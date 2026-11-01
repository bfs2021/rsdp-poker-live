import { describe, expect, it } from 'vitest';
import { engine, type HandState } from '@rsdp/engine/core';
import type { BotNote, HandRecordView, SharedHandView } from '@rsdp/engine/wire';
import { start } from '../../../packages/engine/test/core/harness';
import { finalStacks, frameView, isReplayable, playerStats, replayFrames, sharedHandViewer } from './replay';

const fmt = (n: number) => String(n);
/** A finished engine hand as one viewer gets it from the server. */
const record = (s: HandState, seat: number | null): HandRecordView => ({
  handNumber: 1,
  startedAt: 0,
  endedAt: 0,
  gameName: s.input.game.name,
  betting: s.input.betting,
  stakes: s.input.stakes,
  button: s.input.button,
  seats: s.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, name: x.playerId, stack: x.startStack })),
  events: engine.visibleEvents(s, { seat, seeAll: false }),
});
const cardsAt = (h: HandRecordView, seat: number, viewer: string) =>
  replayFrames(h, viewer, fmt).at(-1)!.seats.get(seat)!.cards.map((c) => (c.shown || c.up ? c.card : '??'));

function passive(state: HandState, draw: (seat: number) => number[] = () => []) {
  for (let i = 0; i < 500 && state.phase !== 'complete'; i++) {
    if (state.phase === 'drawing') {
      engine.draw(state, state.toAct!, draw(state.toAct!));
      continue;
    }
    const seat = state.toAct!;
    const legal = engine.legalActions(state, seat)!;
    engine.act(state, seat, legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
  }
}

describe('replayFrames', () => {
  it('ends on the engine stacks and an empty pot', () => {
    const s = start({ stacks: [100, 100, 100] });
    passive(s);
    const last = replayFrames(record(s, 0), 'p0', fmt).at(-1)!;
    expect(last.done).toBe(true);
    expect(last.pot).toBe(0);
    for (const x of s.seats) expect(last.seats.get(x.seat)!.stack).toBe(x.stack);
  });

  it('gives the second run of a run-it-twice hand the shared cards', () => {
    const s = start({ stacks: [100, 100], options: { runItTwice: 'always' } });
    engine.act(s, s.toAct!, { type: 'call' });
    engine.act(s, s.toAct!, { type: 'check' });
    engine.act(s, s.toAct!, { type: 'bet', to: 98 });
    engine.act(s, s.toAct!, { type: 'call' });
    expect(s.phase).toBe('complete');
    const boards = replayFrames(record(s, 0), 'p0', fmt).at(-1)!.boards;
    expect(boards.map((run) => run[0])).toEqual(s.runs!.map((run) => run[0]));
  });

  it('shows the cards an opponent kept after drawing', () => {
    const s = start({ game: 'td27', stacks: [100, 100, 100] });
    passive(s, () => [0, 1]);
    const h = record(s, 0);
    let opponents = 0;
    for (const x of s.seats.filter((x) => x.seat !== 0)) {
      const shown = cardsAt(h, x.seat, 'p0');
      if (shown.includes('??')) continue; // mucked
      expect(shown).toEqual(x.cards.map((c) => c.card));
      opponents++;
    }
    expect(opponents).toBeGreaterThan(0);
    expect(cardsAt(h, 0, 'p0')).toEqual(s.seats[0].cards.map((c) => c.card));
  });
});

describe('Frame.why', () => {
  /** A three-handed hand where the bots (seats 1 and 2) each have a reason for every move. */
  function withNotes() {
    const s = start({ stacks: [100, 100, 100] });
    passive(s);
    const h = record(s, 0);
    const notes: BotNote[] = h.events
      .filter((e) => e.t === 'action' && e.seat !== 0)
      .map((e) => ({ seq: e.seq, seat: (e as { seat: number }).seat, level: 'normal', rule: 'call', share: 0.4, cost: 0.25, need: 0.28 }));
    return { h, notes };
  }

  it('puts each reason on the frame that plays its move', () => {
    const { h, notes } = withNotes();
    expect(notes.length).toBeGreaterThan(2);
    // Given out of order, as nothing promises otherwise.
    h.botNotes = [...notes].reverse();
    const frames = replayFrames(h, 'p0', fmt);
    let from = 0;
    for (const f of frames) {
      for (const n of f.why) expect(n.seq >= from && n.seq < f.upTo).toBe(true);
      // An action has a frame of its own, with its log line.
      for (const n of f.why) expect(f.caption).toContain(`p${n.seat}`);
      from = f.upTo;
    }
    expect(frames.flatMap((f) => f.why.map((n) => n.seq))).toEqual(notes.map((n) => n.seq));
  });

  it('keeps a reason whose step was merged into the next or left out', () => {
    const { h } = withNotes();
    // Events that end no step: all but the last deal (the deals show as one step), and any that change nothing seen.
    const ends = new Set(replayFrames(h, 'p0', fmt).map((f) => f.upTo - 1));
    const hidden = h.events.map((e) => e.seq).filter((seq) => !ends.has(seq));
    const deals = h.events.filter((e) => e.t === 'deal').map((e) => e.seq);
    expect(hidden).toEqual(expect.arrayContaining(deals.slice(0, -1)));
    h.botNotes = hidden.map((seq) => ({ seq, seat: 1, level: 'normal', rule: 'fallback' }));
    const frames = replayFrames(h, 'p0', fmt);
    for (const seq of hidden) {
      const at = frames.findIndex((f) => f.why.some((n) => n.seq === seq));
      expect(at).toBe(frames.findIndex((f) => f.upTo > seq));
    }
    expect(frames.flatMap((f) => f.why)).toHaveLength(hidden.length);
  });

  it('is empty for a hand without reasons', () => {
    const { h } = withNotes();
    expect(replayFrames(h, 'p0', fmt).every((f) => f.why.length === 0)).toBe(true);
  });
});

describe('playerStats and finalStacks', () => {
  it('counts calls and raises on the first round only', () => {
    const s = start({ stacks: [100, 100, 100] });
    const first = s.toAct!;
    engine.act(s, first, { type: 'raise', to: 6 });
    passive(s);
    const rows = new Map(playerStats([record(s, null)]).map((r) => [r.playerId, r]));
    expect(rows.get(`p${first}`)).toMatchObject({ hands: 1, counted: 1, vpip: 1, pfr: 1 });
    const net = finalStacks(record(s, null))!;
    for (const x of s.seats) expect(net[x.seat]).toBe(x.stack);
  });

  it('adds transfers after the hand ends', () => {
    const h = record(Object.assign(start({ stacks: [100, 100] }), {}), null);
    h.events = [
      { seq: 1, t: 'hand-end', stacks: { 0: 90, 1: 110 } },
      { seq: 2, t: 'transfer', kind: 'bounty-72', from: 1, to: 0, amount: 4 },
    ];
    expect(finalStacks(h)).toEqual({ 0: 94, 1: 106 });
  });
});

describe('isReplayable', () => {
  it('takes a real hand and refuses broken ones', () => {
    const s = start({ stacks: [100, 100] });
    passive(s);
    const h = record(s, 0);
    expect(isReplayable(h, fmt)).toBe(true);
    expect(isReplayable({ ...h, stakes: undefined }, fmt)).toBe(false);
    expect(isReplayable({ ...h, seats: [{ ...h.seats[0], seat: 1e9 }] }, fmt)).toBe(false);
    expect(isReplayable({ ...h, events: 'nope' }, fmt)).toBe(false);
    expect(isReplayable(null, fmt)).toBe(false);
  });

  it('drops any bots’ reasons from a file', () => {
    const s = start({ stacks: [100, 100] });
    passive(s);
    const h: HandRecordView = { ...record(s, 0), botNotes: [{ seq: 5, seat: 1, level: 'hard', rule: 'fold' }] };
    expect(isReplayable(h, fmt)).toBe(true);
    expect(h.botNotes).toBeUndefined();
    expect(replayFrames(h, 'p0', fmt).every((f) => f.why.length === 0)).toBe(true);
  });
});

describe('frameView bots', () => {
  it('badges a seat as a bot only when the hand says so, never by its id', () => {
    const s = start({ stacks: [100, 100] });
    passive(s);
    const h = record(s, 0);
    // A person whose id happens to start with 'bot-', and a real bot, with the look the server sent.
    h.seats = [
      { ...h.seats[0], playerId: 'bot-person' },
      { ...h.seats[1], bot: { ownerName: 'Ann', look: 3 } },
    ];
    const view = frameView('Practice', 2, h, replayFrames(h, null, fmt).at(-1)!, null);
    expect(view.seats[0]!.bot).toBeUndefined();
    expect(view.seats[1]!.bot).toEqual({ ownerId: '', ownerName: 'Ann', look: 3 });
  });
});

describe('shared hand links', () => {
  /** A link to `s`, frozen as the server freezes it: as seat 0 saw it, or as an outsider when seat 0 hid their cards. */
  const link = (s: HandState, hideMine: boolean): SharedHandView => ({
    id: 'link-0123456789',
    tableName: 'Share night',
    centsMode: false,
    seatCount: 2,
    felt: null,
    sharedBy: 'p0',
    createdAt: 0,
    ...(hideMine ? {} : { sharerSeat: 0 }),
    hand: record(s, hideMine ? null : 0),
  });
  /** Heads up, seat 0 on the button raises with aces and seat 1 folds: no showdown. */
  const aces = () => {
    const s = start({ stacks: [100, 100], button: 0, top: ['Kh', 'As', 'Ks', 'Ad'] });
    engine.act(s, s.toAct!, { type: 'raise', to: engine.legalActions(s, s.toAct!)!.minTo });
    engine.act(s, s.toAct!, { type: 'fold' });
    expect(s.phase).toBe('complete');
    return s;
  };
  /** The shared page's replay of a link, as whoever opens it sees it: seat 0's cards at the end, the captions, and who "me" is. */
  const replay = (shared: SharedHandView) => {
    const { myId, sharerSeat } = sharedHandViewer(shared);
    const frames = replayFrames(shared.hand, myId, fmt, sharerSeat);
    const view = frameView(shared.tableName, shared.seatCount, shared.hand, frames.at(-1)!, myId, undefined, sharerSeat);
    return { myId, captions: frames.map((f) => f.caption), cards: view.seats[0]!.cards.map((c) => c.card), me: view.me };
  };

  it('shows the sharer’s cards with Show my cards, even when nobody turned them over', () => {
    expect(replay(link(aces(), false)).cards).toEqual(['As', 'Ad']);
    // A link made with the cards hidden still shows them face down.
    expect(replay(link(aces(), true)).cards).toEqual(['??', '??']);
  });

  it('never calls whoever opens a link “you”: the hand and its result are the sharer’s', () => {
    const shown = replay(link(aces(), false));
    // No viewer, so the header shows nobody's result as "you", and the deal names the sharer.
    expect(shown.myId).toBeNull();
    expect(shown.captions.filter((c) => c.includes('You are dealt'))).toEqual([]);
    expect(shown.captions.some((c) => c.includes('p0 is dealt [As] [Ad]'))).toBe(true);
    // Still seen from the sharer's chair.
    expect(shown.me).toEqual({ playerId: '', seat: 0 });
  });

  it('shows the sharer’s cards in a link made before links said whose they were', () => {
    // Links are kept: one made with Show my cards back then holds the cards but no seat.
    const { sharerSeat, ...old } = link(aces(), false);
    expect(sharerSeat).toBe(0);
    expect(replay(old).cards).toEqual(['As', 'Ad']);
    expect(replay(old).captions.some((c) => c.includes('p0 is dealt [As] [Ad]'))).toBe(true);
    // Cards turned over at a showdown are no clue: in a link with the sharer's cards hidden, nobody's are face up from the deal.
    const s = start({ stacks: [100, 100] });
    passive(s);
    const hidden = link(s, true);
    expect(hidden.hand.events.some((e) => e.t === 'deal' && e.cards.some((c) => c.card !== '??'))).toBe(true);
    expect(sharedHandViewer(hidden).sharerSeat).toBeNull();
    expect(replay(link(aces(), true)).cards).toEqual(['??', '??']);
  });
});
