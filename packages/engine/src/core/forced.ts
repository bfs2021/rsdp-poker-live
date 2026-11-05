import type { ForcedBetPlan, PlanForcedBets, PlannerSeat } from './api';
import type { PlannedPost, SeatIndex } from './types';

/**
 * Forced-bet planner. Runs between hands with the seats that want to play
 * (sitting in, chips > 0) and decides who is dealt in and who posts what.
 *
 * Blinds follow the dead-button rule: the big blind moves exactly one player
 * each hand, the small blind goes to whoever had the big blind last hand (dead
 * if they left), and the button goes to last hand's small blind position (dead
 * if that seat is empty). Nobody skips or repeats a big blind.
 */
export const planForcedBets: PlanForcedBets = (args) => {
  const { game, stakes, mode, bombPot } = args;
  const seats = [...args.seats].sort((a, b) => a.seat - b.seat);
  const n = args.maxSeats;
  const bySeat = new Map(seats.map((s) => [s.seat, s]));
  const occupied = (seat: SeatIndex | null | undefined): seat is SeatIndex => seat != null && bySeat.has(seat);
  /** First seat in `seats` strictly clockwise after `from` (from may be any position, occupied or not). */
  const after = (from: SeatIndex | null, pool: PlannerSeat[] = seats): SeatIndex | null => {
    if (!pool.length) return null;
    if (from === null) return pool[0].seat;
    let best: PlannerSeat | null = null;
    let bestDist = Infinity;
    for (const s of pool) {
      const d = (s.seat - from - 1 + n) % n;
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best!.seat;
  };
  /** Clockwise distance from `a` to `b`, 0 when equal. */
  const dist = (a: SeatIndex, b: SeatIndex) => (b - a + n) % n;

  const empty = (button: SeatIndex): ForcedBetPlan => ({
    dealtIn: [],
    button,
    buttonDead: !occupied(button),
    smallBlindSeat: null,
    bigBlindSeat: null,
    posts: [],
    waiting: seats.map((s) => s.seat),
  });
  if (seats.length < 2) return empty(args.lastButton ?? seats[0]?.seat ?? 0);

  const antes = (dealtIn: SeatIndex[]): PlannedPost[] =>
    stakes.anteType === 'per-player' && stakes.ante > 0
      ? dealtIn.map((seat) => ({ seat, kind: 'ante' as const, amount: stakes.ante, live: false }))
      : [];

  // Stud: everyone antes; the bring-in is an action in the hand. The button only sets dealing order.
  if (game.forcedBets === 'ante-bring-in') {
    const button = after(args.lastButton)!;
    const dealtIn = seats.map((s) => s.seat);
    return { dealtIn, button, buttonDead: false, smallBlindSeat: null, bigBlindSeat: null, posts: antes(dealtIn), waiting: [] };
  }

  // ---- blind positions
  let button: SeatIndex;
  let sb: SeatIndex | null;
  let bb: SeatIndex;
  const headsUp = seats.length === 2;
  if (args.lastBigBlindSeat === null) {
    // First hand: the button goes to the first player after lastButton (the runtime may seed it randomly).
    button = after(args.lastButton === null ? null : args.lastButton - 1)!;
    if (headsUp) {
      sb = button;
      bb = after(button)!;
    } else {
      sb = after(button)!;
      bb = after(sb)!;
    }
  } else {
    bb = after(args.lastBigBlindSeat)!;
    if (headsUp) {
      // Heads up the button posts the small blind and acts first before the flop.
      button = after(bb)!;
      sb = button;
    } else {
      sb = args.lastBigBlindSeat;
      button = args.lastSmallBlindSeat ?? args.lastButton ?? sb;
      // The button can't sit on or past the small blind (seats changed a lot): fall back to the seat behind it.
      if (button === sb || button === bb || dist(button, bb) < dist(sb, bb)) {
        button = (sb - 1 + n) % n;
      }
      if (sb === bb) sb = null;
    }
  }

  // ---- who is dealt in
  const dealtIn: SeatIndex[] = [];
  const waiting: SeatIndex[] = [];
  const catchUp: PlannedPost[] = [];
  /** Seats from the button up to (not including) the big blind: a new player can't come in there. */
  const inBlindZone = (seat: SeatIndex) => headsUp || (seat !== bb && dist(button, seat) < dist(button, bb));

  // Tournament players never post to play. Someone just seated here (late registration, re-entry or a table move)
  // is dealt in at once, except on the button, the small blind or between them: there they wait one hand for the
  // button to pass, so nobody gets a hand the blinds skipped. Never if that would leave only two playing: a hand
  // laid out for three can't be dealt heads up, so then everyone plays.
  const tournamentWaits =
    mode === 'tournament' && !headsUp ? seats.filter((s) => s.isNew && inBlindZone(s.seat)).map((s) => s.seat) : [];
  const tournamentWait = new Set(seats.length - tournamentWaits.length >= 3 ? tournamentWaits : []);

  for (const s of seats) {
    if (mode === 'tournament') {
      (tournamentWait.has(s.seat) ? waiting : dealtIn).push(s.seat);
      continue;
    }
    const owes = s.isNew || s.missedBigBlind || s.missedSmallBlind;
    // Heads up both players are in the blinds; waiting would stall the table.
    const inBlinds = s.seat === bb || (s.seat === sb && !s.isNew);
    if (headsUp || inBlinds || !owes) {
      dealtIn.push(s.seat);
      continue;
    }
    if (bombPot && !s.waitForBigBlind) {
      // Everyone pays the bomb amount, so nobody needs to post to play; missed blinds stay owed.
      dealtIn.push(s.seat);
      continue;
    }
    if (s.waitForBigBlind || inBlindZone(s.seat)) {
      waiting.push(s.seat);
      continue;
    }
    // Post to play: a live big blind if new or it was missed, and a dead small blind if that was missed.
    dealtIn.push(s.seat);
    if (s.isNew || s.missedBigBlind) catchUp.push({ seat: s.seat, kind: 'missed-big-blind', amount: stakes.bigBlind, live: true });
    if (s.missedSmallBlind && !s.isNew) catchUp.push({ seat: s.seat, kind: 'dead-small-blind', amount: stakes.smallBlind, live: false });
  }

  const plan: ForcedBetPlan = {
    dealtIn,
    button,
    buttonDead: !dealtIn.includes(button),
    smallBlindSeat: sb,
    bigBlindSeat: bb,
    posts: [],
    waiting,
  };
  if (dealtIn.length < 2) return { ...plan, posts: [] };

  if (bombPot) {
    plan.posts = dealtIn.map((seat) => ({ seat, kind: 'bomb-pot', amount: bombPot.amount, live: true }));
    return plan;
  }

  const posts: PlannedPost[] = [...antes(dealtIn)];
  if (sb !== null && dealtIn.includes(sb)) posts.push({ seat: sb, kind: 'small-blind', amount: stakes.smallBlind, live: true });
  posts.push({ seat: bb, kind: 'big-blind', amount: stakes.bigBlind, live: true });
  // Big blind ante goes in after the blind, so a short big blind covers the blind first.
  if (stakes.anteType === 'big-blind' && stakes.ante > 0) posts.push({ seat: bb, kind: 'big-blind-ante', amount: stakes.ante, live: false });
  posts.push(...catchUp);

  // Straddles: cash games with three or more players dealt in.
  if (mode === 'cash' && args.straddles !== 'off' && dealtIn.length >= 3) {
    const pool = seats.filter((s) => dealtIn.includes(s.seat));
    const utg = after(bb, pool)!;
    let top = stakes.bigBlind;
    const utgSeat = bySeat.get(utg)!;
    // A player who just posted to play can't straddle on the same hand.
    if (utgSeat.straddle && !catchUp.some((p) => p.seat === utg) && utg !== button) {
      top *= 2;
      posts.push({ seat: utg, kind: 'straddle', amount: top, live: true });
    }
    if (args.straddles === 'utg-and-button' && plan.dealtIn.includes(button) && button !== utg && button !== bb && button !== sb) {
      const btn = bySeat.get(button)!;
      if (btn.straddle && !catchUp.some((p) => p.seat === button)) {
        top *= 2;
        posts.push({ seat: button, kind: 'straddle', amount: top, live: true });
      }
    }
  }
  plan.posts = posts;
  return plan;
};

/**
 * Seats the big blind passed over since last hand: they were seated but not
 * dealt in when it went by, so they now owe it. The runtime marks
 * missedBigBlind (and missedSmallBlind for the small blind position) on them.
 */
export function blindsPassed(
  plan: Pick<ForcedBetPlan, 'smallBlindSeat' | 'bigBlindSeat'>,
  lastBigBlindSeat: SeatIndex | null,
  seatedSittingOut: SeatIndex[],
  maxSeats: number,
): { missedBig: SeatIndex[]; missedSmall: SeatIndex[] } {
  if (plan.bigBlindSeat === null || lastBigBlindSeat === null) return { missedBig: [], missedSmall: [] };
  const span = (plan.bigBlindSeat - lastBigBlindSeat + maxSeats) % maxSeats;
  // Skipped by the big blind: they owe both blinds.
  const missedBig = seatedSittingOut.filter((seat) => {
    const d = (seat - lastBigBlindSeat + maxSeats) % maxSeats;
    return d > 0 && d < span;
  });
  const missedSmall = [...missedBig];
  // Sitting out in the small blind position: they owe the small blind.
  if (plan.smallBlindSeat !== null && seatedSittingOut.includes(plan.smallBlindSeat) && !missedSmall.includes(plan.smallBlindSeat)) {
    missedSmall.push(plan.smallBlindSeat);
  }
  return { missedBig, missedSmall };
}
