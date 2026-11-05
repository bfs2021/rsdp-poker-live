import { describe, expect, it } from 'vitest';
import type { HandEvent } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { departures, holdBack, withShown, type Frozen } from './runout';

/** Two players all in before the flop, run twice: run 1 is 3h 4h 5h / 6h / 7h, run 2 shares nothing. */
function finished(): TableView {
  const events = [
    { seq: 0, t: 'hand-start', seats: [{ seat: 0, playerId: 'a', stack: 100 }, { seat: 1, playerId: 'b', stack: 120 }] },
    { seq: 1, t: 'action', seat: 0, action: 'call', amount: 100, to: 100, allIn: true, auto: false },
    { seq: 1.5, t: 'action', seat: 1, action: 'raise', amount: 120, to: 120, allIn: true, auto: false },
    { seq: 1.7, t: 'uncalled', seat: 1, amount: 20 },
    { seq: 2, t: 'run-it', times: 2 },
    { seq: 3, t: 'board', run: 0, board: 0, cards: ['3h', '4h', '5h'] },
    { seq: 4, t: 'board', run: 0, board: 0, cards: ['6h'] },
    { seq: 5, t: 'board', run: 0, board: 0, cards: ['7h'] },
    { seq: 6, t: 'board', run: 1, board: 0, cards: ['3c', '4c', '5c'] },
    { seq: 7, t: 'board', run: 1, board: 0, cards: ['6c'] },
    { seq: 8, t: 'board', run: 1, board: 0, cards: ['Kd'] },
    { seq: 9, t: 'award', pot: 0, run: 0, board: 0, half: null, seat: 0, amount: 100 },
  ] as unknown as HandEvent[];
  const seat = (n: number, stack: number, won: number) => ({ seat: n, playerId: 'ab'[n], stack, won, handName: 'Straight', cards: [], allIn: false, inHand: true, folded: false, sittingOut: false, sitOutReason: null, leaving: false, waiting: false });
  return {
    hand: {
      handNumber: 4,
      phase: 'complete',
      showdown: true,
      boards: [[['3h', '4h', '5h', '6h', '7h']], [['3c', '4c', '5c', '6c', 'Kd']]],
      pots: [],
      potTotal: 0,
      awards: [{ seat: 0, amount: 100 }, { seat: 1, amount: 100 }],
      events,
    },
    seats: [seat(0, 100, 100), seat(1, 120, 100)],
    ledger: [{ playerId: 'a', net: 0 }],
    log: [{ at: 10, text: 'Rosa calls' }, { at: 20, text: 'John wins 100' }],
    history: [{ handNumber: 3 }, { handNumber: 4 }],
    me: { playerId: 'a', seat: 0 },
    nit: null,
    canShow: [0, 1],
    nextHandAt: 99,
    rabbit: { available: false, cards: null },
  } as unknown as TableView;
}

/** The table just before the runout. */
const before_ = (): Frozen => before();
const before = (): Frozen => ({ logCut: 10, seats: finished().seats, ledger: [], me: { playerId: 'a', seat: 0 }, nit: null });

describe('holdBack', () => {
  it('shows no runout cards before the first step, and keeps the result back', () => {
    const v = holdBack(finished(), before(), 0);
    expect(v.hand!.boards).toEqual([[[]], [[]]]);
    expect(v.hand!.phase).toBe('betting');
    expect(v.hand!.awards).toEqual([]);
    expect(v.hand!.pots).toEqual([{ amount: 200, eligible: [] }]);
    expect(v.hand!.events.map((e) => e.seq)).toEqual([0, 1, 1.5, 1.7, 2]);
    expect(v.seats.map((s) => [s!.stack, s!.won, s!.handName, s!.allIn])).toEqual([[0, 0, null, true], [20, 0, null, false]]);
    expect(v.ledger).toEqual([]);
    expect(v.log).toHaveLength(1);
    expect(v.history.map((h) => h.handNumber)).toEqual([3]);
    expect(v.nextHandAt).toBeNull();
  });

  it('finishes the first run before the second appears', () => {
    expect(holdBack(finished(), before(), 2).hand!.boards).toEqual([[['3h', '4h', '5h', '6h']], [[]]]);
    expect(holdBack(finished(), before(), 4).hand!.boards).toEqual([[['3h', '4h', '5h', '6h', '7h']], [['3c', '4c', '5c']]]);
    const all = holdBack(finished(), before(), 6);
    expect(all.hand!.boards).toEqual(finished().hand!.boards);
    expect(all.hand!.events.map((e) => e.seq)).toEqual([0, 1, 1.5, 1.7, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps players at the table who bust or leave when the hand ends', () => {
    const done = finished();
    const busted = { ...done.seats[0]!, stack: 0, won: 0, sittingOut: true, sitOutReason: 'busted' as const };
    const v = holdBack({ ...done, seats: [busted, null], me: { playerId: 'a', seat: null } }, before(), 0);
    expect(v.me.seat).toBe(0);
    expect(v.seats[0]).toMatchObject({ playerId: 'a', sittingOut: false, sitOutReason: null, stack: 0, allIn: true });
    expect(v.seats[1]).toMatchObject({ playerId: 'b', stack: 20 });
  });
});

/** Three-handed tournament hand: seat 1 is all in before the flop, loses and is knocked out. */
function knockout(): { before: TableView; after: TableView } {
  const events = [
    { seq: 0, t: 'hand-start', seats: [{ seat: 0, playerId: 'a', stack: 300 }, { seat: 1, playerId: 'b', stack: 100 }, { seat: 2, playerId: 'c', stack: 300 }] },
    { seq: 1, t: 'show', seat: 0, cards: ['As', 'Ad'] },
    { seq: 2, t: 'show', seat: 1, cards: ['Kc', 'Kd'] },
    { seq: 3, t: 'run-it', times: 1 },
    { seq: 4, t: 'board', run: 0, board: 0, cards: ['2h', '7c', '9d'] },
    { seq: 5, t: 'board', run: 0, board: 0, cards: ['Js'] },
    { seq: 6, t: 'board', run: 0, board: 0, cards: ['3s'] },
    { seq: 7, t: 'hand-end', stacks: { 0: 400, 1: 0, 2: 300 } },
  ] as unknown as HandEvent[];
  const seat = (n: number, cards: string[], extra = {}) => ({ seat: n, playerId: 'abc'[n], name: 'P' + n, stack: 300, won: 0, handName: null, allIn: false, inHand: true, folded: false, cards: cards.map((card) => ({ card, up: false })), ...extra });
  const hand = { handNumber: 9, phase: 'complete', showdown: true, boards: [[['2h', '7c', '9d', 'Js', '3s']]], pots: [], potTotal: 0, awards: [{ seat: 0, amount: 200 }], events };
  const after = { mode: 'tournament', hand, seats: [seat(0, ['??', '??']), null, seat(2, ['??', '??'], { folded: true })], nextHandAt: 9000, serverNow: 1000, me: { playerId: 'a', seat: 0 }, log: [], history: [], ledger: [] } as unknown as TableView;
  const before = { ...after, hand: { ...hand, phase: 'betting' }, seats: [seat(0, ['??', '??']), seat(1, ['??', '??'], { stack: 0, allIn: true }), seat(2, ['??', '??'], { folded: true })] } as unknown as TableView;
  return { before, after };
}

describe('a player knocked out (#308)', () => {
  it('shows the cards they turned up, which the table before the result still had face down', () => {
    const { after } = knockout();
    expect(withShown([{ card: '??', up: false }, { card: '??', up: false }], after.hand!.events, 1)).toEqual([
      { card: 'Kc', up: false },
      { card: 'Kd', up: false },
    ]);
    // Their cards during the runout, too.
    const v = holdBack(after, { logCut: 0, seats: knockout().before.seats, ledger: [], me: { playerId: 'a', seat: 0 } as TableView['me'], nit: null }, 0);
    expect(v.seats[1]!.cards.map((c) => c.card)).toEqual(['Kc', 'Kd']);
  });

  it('keeps them in their seat, cards up and marked out, until the next hand', () => {
    const { before, after } = knockout();
    const kept = departures(before, after, null)!;
    expect([...kept.seats.keys()]).toEqual([1]);
    expect(kept.seats.get(1)).toMatchObject({ playerId: 'b', stack: 0, departed: 'out', cards: [{ card: 'Kc' }, { card: 'Kd' }] });
    // Still kept while the result shows; gone with the next deal.
    expect(departures(after, after, kept)).toBe(kept);
    const next = { ...after, hand: { ...after.hand!, handNumber: 10, phase: 'betting' } } as TableView;
    expect(departures(after, next, kept)).toBeNull();
  });

  it('keeps nobody at a cash table, nor a player who moved tables with chips', () => {
    const { before, after } = knockout();
    expect(departures({ ...before, mode: 'cash' }, { ...after, mode: 'cash' }, null)).toBeNull();
    const moved = { ...after, hand: { ...after.hand!, events: after.hand!.events.map((e) => (e.t === 'hand-end' ? { ...e, stacks: { 0: 300, 1: 100, 2: 300 } } : e)) } } as TableView;
    expect(departures(before, moved, null)).toBeNull();
  });

  it('puts a face-down card on the board while the last card of one run waits', () => {
    const { before, after } = knockout();
    const frozen: Frozen = { logCut: 0, seats: before.seats, ledger: [], me: { playerId: 'a', seat: 0 } as TableView['me'], nit: null };
    expect(holdBack(after, frozen, 1).hand!.comingNext).toBeUndefined();
    expect(holdBack(after, frozen, 2).hand!.comingNext).toEqual([{ run: 0, board: 0 }]);
    // Run it twice deals at its own pace, without the wait.
    expect(holdBack(finished(), before_(), 5).hand!.comingNext).toBeUndefined();
  });
});
