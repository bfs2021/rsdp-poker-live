import { describe, expect, it } from 'vitest';
import type { PlannerSeat } from '../../src/core/api';
import { blindsPassed, planForcedBets } from '../../src/core/forced';
import type { GameSpec, Stakes } from '../../src/core/types';

const stakes: Stakes = { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none', bringIn: 0, smallBet: 2, bigBet: 4 };
const HOLDEM: GameSpec = {
  id: 'nlhe',
  name: 'Hold',
  family: 'flop',
  streets: [],
  maxPlayers: 10,
  defaultBetting: 'no-limit',
  split: 'high',
  forcedBets: 'blinds',
};
const STUD: GameSpec = { ...HOLDEM, id: 'stud', family: 'stud', forcedBets: 'ante-bring-in', maxPlayers: 8 };

const seat = (n: number, extra: Partial<PlannerSeat> = {}): PlannerSeat => ({
  seat: n,
  playerId: `p${n}`,
  stack: 100,
  isNew: false,
  missedSmallBlind: false,
  missedBigBlind: false,
  waitForBigBlind: false,
  straddle: false,
  ...extra,
});

const base = {
  game: HOLDEM,
  stakes,
  maxSeats: 9,
  lastBigBlindSeat: null,
  lastSmallBlindSeat: null,
  lastButton: null,
  mode: 'cash' as const,
  straddles: 'off' as const,
  bombPot: null,
};

/** Plays `hands` plans in a row, feeding each back into the next. */
function rotate(seats: PlannerSeat[], hands: number) {
  let last = { button: null as number | null, sb: null as number | null, bb: null as number | null };
  const out = [];
  for (let i = 0; i < hands; i++) {
    const plan = planForcedBets({ ...base, seats, lastButton: last.button, lastSmallBlindSeat: last.sb, lastBigBlindSeat: last.bb });
    out.push(plan);
    last = { button: plan.button, sb: plan.smallBlindSeat, bb: plan.bigBlindSeat };
  }
  return out;
}

describe('planForcedBets: blinds', () => {
  it('first hand puts the button on the first seat, then small and big blind', () => {
    const plan = planForcedBets({ ...base, seats: [seat(0), seat(3), seat(5)] });
    expect(plan.button).toBe(0);
    expect(plan.smallBlindSeat).toBe(3);
    expect(plan.bigBlindSeat).toBe(5);
    expect(plan.buttonDead).toBe(false);
    expect(plan.posts).toEqual([
      { seat: 3, kind: 'small-blind', amount: 1, live: true },
      { seat: 5, kind: 'big-blind', amount: 2, live: true },
    ]);
    expect(plan.dealtIn).toEqual([0, 3, 5]);
  });

  it('rotates one seat per hand around a full ring', () => {
    const plans = rotate([seat(0), seat(1), seat(2), seat(3)], 5);
    expect(plans.map((p) => [p.button, p.smallBlindSeat, p.bigBlindSeat])).toEqual([
      [0, 1, 2],
      [1, 2, 3],
      [2, 3, 0],
      [3, 0, 1],
      [0, 1, 2],
    ]);
  });

  it('heads up the button posts the small blind', () => {
    const plan = planForcedBets({ ...base, seats: [seat(2), seat(7)] });
    expect(plan.button).toBe(2);
    expect(plan.smallBlindSeat).toBe(2);
    expect(plan.bigBlindSeat).toBe(7);
    const next = planForcedBets({ ...base, seats: [seat(2), seat(7)], lastButton: 2, lastSmallBlindSeat: 2, lastBigBlindSeat: 7 });
    expect([next.button, next.smallBlindSeat, next.bigBlindSeat]).toEqual([7, 7, 2]);
  });

  it('dead small blind when last big blind left, and the big blind still moves one player', () => {
    // Last hand: button 0, small 1, big 2. Seat 2 leaves.
    const plan = planForcedBets({ ...base, seats: [seat(0), seat(1), seat(3)], lastButton: 0, lastSmallBlindSeat: 1, lastBigBlindSeat: 2 });
    expect(plan.bigBlindSeat).toBe(3);
    expect(plan.smallBlindSeat).toBe(2);
    expect(plan.button).toBe(1);
    expect(plan.posts.map((p) => p.kind)).toEqual(['big-blind']);
  });

  it('dead button when last small blind left', () => {
    // Last hand: button 0, small 1, big 2. Seat 1 leaves.
    const plan = planForcedBets({ ...base, seats: [seat(0), seat(2), seat(3)], lastButton: 0, lastSmallBlindSeat: 1, lastBigBlindSeat: 2 });
    expect(plan.button).toBe(1);
    expect(plan.buttonDead).toBe(true);
    expect(plan.smallBlindSeat).toBe(2);
    expect(plan.bigBlindSeat).toBe(3);
  });

  it('three to two players: nobody takes the big blind twice in a row', () => {
    // Last hand: button 0, small 1, big 2. Seat 1 busts.
    const plan = planForcedBets({ ...base, seats: [seat(0), seat(2)], lastButton: 0, lastSmallBlindSeat: 1, lastBigBlindSeat: 2 });
    expect(plan.bigBlindSeat).toBe(0);
    expect(plan.button).toBe(2);
    expect(plan.smallBlindSeat).toBe(2);
  });

  it('every player pays exactly one big blind per orbit as players come and go', () => {
    let seats = [seat(0), seat(1), seat(2), seat(3), seat(4)];
    let last = { button: null as number | null, sb: null as number | null, bb: null as number | null };
    const bbs: number[] = [];
    for (let i = 0; i < 12; i++) {
      if (i === 4) seats = seats.filter((s) => s.seat !== 2);
      const plan = planForcedBets({ ...base, seats, lastButton: last.button, lastSmallBlindSeat: last.sb, lastBigBlindSeat: last.bb });
      bbs.push(plan.bigBlindSeat!);
      last = { button: plan.button, sb: plan.smallBlindSeat, bb: plan.bigBlindSeat };
    }
    for (let i = 1; i < bbs.length; i++) expect(bbs[i]).not.toBe(bbs[i - 1]);
    expect(bbs).toEqual([2, 3, 4, 0, 1, 3, 4, 0, 1, 3, 4, 0]);
  });
});

describe('planForcedBets: new and returning players', () => {
  const last = { lastButton: 0, lastSmallBlindSeat: 1, lastBigBlindSeat: 2 };

  it('a new player in the big blind just posts the blind', () => {
    const plan = planForcedBets({ ...base, ...last, seats: [seat(0), seat(1), seat(2), seat(3, { isNew: true })] });
    expect(plan.bigBlindSeat).toBe(3);
    expect(plan.dealtIn).toContain(3);
    expect(plan.posts.filter((p) => p.seat === 3)).toEqual([{ seat: 3, kind: 'big-blind', amount: 2, live: true }]);
  });

  it('a new player elsewhere posts to play, or waits for the big blind', () => {
    const seats = [seat(0), seat(1), seat(2), seat(3), seat(5, { isNew: true })];
    const posting = planForcedBets({ ...base, ...last, seats });
    expect(posting.dealtIn).toContain(5);
    expect(posting.posts).toContainEqual({ seat: 5, kind: 'missed-big-blind', amount: 2, live: true });

    const waiting = planForcedBets({ ...base, ...last, seats: [...seats.slice(0, 4), seat(5, { isNew: true, waitForBigBlind: true })] });
    expect(waiting.dealtIn).not.toContain(5);
    expect(waiting.waiting).toEqual([5]);
  });

  it('a new player between the button and the big blind must wait', () => {
    // Button 1, small 2, big 3 this hand. Seat 2 left; a new player sits in seat 2.
    const plan = planForcedBets({ ...base, ...last, seats: [seat(0), seat(1), seat(2, { isNew: true }), seat(3), seat(4)] });
    expect([plan.button, plan.smallBlindSeat, plan.bigBlindSeat]).toEqual([1, 2, 3]);
    expect(plan.waiting).toEqual([2]);
    expect(plan.posts.map((p) => p.kind)).toEqual(['big-blind']);
  });

  it('a returning player posts the missed big blind live and the small blind dead', () => {
    const plan = planForcedBets({
      ...base,
      ...last,
      seats: [seat(0), seat(1), seat(2), seat(3), seat(5, { missedBigBlind: true, missedSmallBlind: true })],
    });
    expect(plan.posts.filter((p) => p.seat === 5)).toEqual([
      { seat: 5, kind: 'missed-big-blind', amount: 2, live: true },
      { seat: 5, kind: 'dead-small-blind', amount: 1, live: false },
    ]);
  });

  it('tournaments deal everyone in without posting, but a new arrival waits out the button and small blind', () => {
    // Next hand: button 1, small blind 2, big blind 3.
    const t = (seats: PlannerSeat[]) => planForcedBets({ ...base, ...last, mode: 'tournament', seats });
    const settled = t([seat(0, { missedBigBlind: true, missedSmallBlind: true }), seat(1), seat(2), seat(3), seat(5, { waitForBigBlind: true })]);
    expect(settled.dealtIn).toEqual([0, 1, 2, 3, 5]);
    expect(settled.waiting).toEqual([]);
    expect(settled.posts.map((p) => p.kind)).toEqual(['small-blind', 'big-blind']);
    // New in the small blind: they wait and the small blind is dead (#311).
    const inSmall = t([seat(0), seat(1), seat(2, { isNew: true }), seat(3)]);
    expect(inSmall.dealtIn).toEqual([0, 1, 3]);
    expect(inSmall.waiting).toEqual([2]);
    expect(inSmall.posts).toEqual([{ seat: 3, kind: 'big-blind', amount: 2, live: true }]);
    // New on the button, or new between the button and the small blind: they wait too.
    expect(t([seat(0), seat(1, { isNew: true }), seat(2), seat(3)]).waiting).toEqual([1]);
    const between = planForcedBets({ ...base, mode: 'tournament', lastButton: 0, lastSmallBlindSeat: 2, lastBigBlindSeat: 4, seats: [seat(0), seat(2), seat(3, { isNew: true }), seat(4), seat(6)] });
    expect([between.button, between.smallBlindSeat, between.bigBlindSeat]).toEqual([2, 4, 6]);
    expect(between.waiting).toEqual([3]);
    // New in the big blind, or anywhere outside the blinds: dealt in at once, posting nothing extra.
    const inBig = t([seat(0), seat(1), seat(2), seat(3, { isNew: true }), seat(5, { isNew: true })]);
    expect(inBig.dealtIn).toEqual([0, 1, 2, 3, 5]);
    expect(inBig.posts.map((p) => [p.seat, p.kind])).toEqual([
      [2, 'small-blind'],
      [3, 'big-blind'],
    ]);
    // Heads up nobody waits.
    expect(t([seat(1), seat(2, { isNew: true })]).waiting).toEqual([]);
  });

  it('marks players the big blind skipped while they sat out', () => {
    // Seat 3 sat out; the big blind went from 2 to 4.
    const plan = planForcedBets({ ...base, ...last, seats: [seat(0), seat(1), seat(2), seat(4)] });
    expect(plan.bigBlindSeat).toBe(4);
    expect(blindsPassed(plan, 2, [3], 9)).toEqual({ missedBig: [3], missedSmall: [3] });
    // Seat 2 (last big blind) sits out: it misses only the small blind this hand.
    const plan2 = planForcedBets({ ...base, ...last, seats: [seat(0), seat(1), seat(3)] });
    expect(blindsPassed(plan2, 2, [2], 9)).toEqual({ missedBig: [], missedSmall: [2] });
  });
});

describe('planForcedBets: antes, straddles, bomb pots, stud', () => {
  const last = { lastButton: 0, lastSmallBlindSeat: 1, lastBigBlindSeat: 2 };
  const four = [seat(0), seat(1), seat(2), seat(3)];

  it('per-player antes are dead money posted by everyone dealt in', () => {
    const plan = planForcedBets({ ...base, stakes: { ...stakes, ante: 1, anteType: 'per-player' }, seats: four });
    expect(plan.posts.filter((p) => p.kind === 'ante')).toHaveLength(4);
    expect(plan.posts.every((p) => p.kind !== 'ante' || !p.live)).toBe(true);
  });

  it('big blind ante is posted by the big blind after the blind', () => {
    const plan = planForcedBets({ ...base, stakes: { ...stakes, ante: 2, anteType: 'big-blind' }, seats: four });
    expect(plan.posts.slice(-2)).toEqual([
      { seat: 2, kind: 'big-blind', amount: 2, live: true },
      { seat: 2, kind: 'big-blind-ante', amount: 2, live: false },
    ]);
  });

  it('under the gun straddle doubles the big blind; the button can re-straddle', () => {
    const seats = [seat(0), seat(1), seat(2), seat(3, { straddle: true }), seat(4), seat(5, { straddle: true })];
    // This hand: button 1, small 2, big 3? Use last = button 4, small 5, big 0 -> button 5, small 0, big 1, UTG 2.
    const prev = { lastButton: 4, lastSmallBlindSeat: 5, lastBigBlindSeat: 0 };
    const utgOnly = planForcedBets({ ...base, ...prev, straddles: 'utg', seats: seats.map((s) => (s.seat === 2 ? { ...s, straddle: true } : s)) });
    expect(utgOnly.posts.filter((p) => p.kind === 'straddle')).toEqual([{ seat: 2, kind: 'straddle', amount: 4, live: true }]);

    const both = planForcedBets({ ...base, ...prev, straddles: 'utg-and-button', seats: seats.map((s) => (s.seat === 2 ? { ...s, straddle: true } : s)) });
    expect(both.posts.filter((p) => p.kind === 'straddle')).toEqual([
      { seat: 2, kind: 'straddle', amount: 4, live: true },
      { seat: 5, kind: 'straddle', amount: 8, live: true },
    ]);
  });

  it('no straddles heads up or in tournaments', () => {
    const hu = planForcedBets({ ...base, straddles: 'utg', seats: [seat(0, { straddle: true }), seat(1, { straddle: true })] });
    expect(hu.posts.some((p) => p.kind === 'straddle')).toBe(false);
    const t = planForcedBets({ ...base, ...last, mode: 'tournament', straddles: 'utg', seats: four.map((s) => ({ ...s, straddle: true })) });
    expect(t.posts.some((p) => p.kind === 'straddle')).toBe(false);
  });

  it('bomb pot: everyone posts the bomb amount live, no blinds, rotation continues', () => {
    const plan = planForcedBets({ ...base, ...last, bombPot: { amount: 10 }, seats: [...four, seat(5, { isNew: true })] });
    expect(plan.posts).toEqual([0, 1, 2, 3, 5].map((s) => ({ seat: s, kind: 'bomb-pot', amount: 10, live: true })));
    expect(plan.bigBlindSeat).toBe(3);
  });

  it('stud: everyone antes and the button just moves on', () => {
    const plan = planForcedBets({ ...base, game: STUD, stakes: { ...stakes, ante: 1, anteType: 'per-player', bringIn: 1 }, lastButton: 1, seats: four });
    expect(plan.button).toBe(2);
    expect(plan.smallBlindSeat).toBeNull();
    expect(plan.posts).toEqual([0, 1, 2, 3].map((s) => ({ seat: s, kind: 'ante', amount: 1, live: false })));
  });

  it('fewer than two players: nothing is planned', () => {
    const plan = planForcedBets({ ...base, seats: [seat(4)] });
    expect(plan.dealtIn).toEqual([]);
    expect(plan.posts).toEqual([]);
  });
});
