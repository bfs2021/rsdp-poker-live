// A move sent for a turn that has passed by the time it arrives is refused, not played on a later one (#178): on a slow
// connection, a player who gives up waiting and taps again has the first tap played on its turn and the second refused.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { createApp } from '../src/app';
import { TableRuntime } from '../src/runtime/table';
import { tableView } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';
import { socketClient, type Client } from './socket-client';

let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);
type Player = ReturnType<typeof client>;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  registerAllVariants(variants);
  server = createApp({ log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
});

const TOO_LATE = /arrived too late: the turn it was for is over/;

/** Two players heads-up, the first hand dealt. Without a clock unless the settings give one. */
async function headsUp(name: string, settings: object = {}) {
  const ann = client(`late-${name}-ann-0123456789`);
  const ben = client(`late-${name}-ben-0123456789`);
  const { tableId } = await ann.call<{ tableId: string }>('table:create', {
    settings: { seating: { requireApproval: false }, timing: { decisionSeconds: 0, autoStartNextHand: false }, ...settings },
  });
  await ann.call('table:join', { tableId });
  await ben.call('table:join', { tableId });
  await ann.call('seat:request', { seat: 0, name: 'Ann', stack: 10_000 });
  await ben.call('seat:request', { seat: 1, name: 'Ben', stack: 10_000 });
  await ann.until((v) => v.seats.filter(Boolean).length === 2);
  await ann.call('host:start');
  await ann.until((v) => !!v.hand);
  await ben.until((v) => !!v.hand);
  return { ann, ben, tableId };
}

/** The turn as this player's view shows it, as the action bar sends it. */
const keyOf = (v: TableView) => ({ handNumber: v.hand!.handNumber, at: v.hand!.events.length });
const mySeat = (v: TableView) => v.seats[v.me.seat!]!;

/** Whoever is to move plays on with checks, calls and standing pat (sending no turn, as a page from before it did) until `stop` holds. */
async function playOn(players: Player[], stop: () => boolean) {
  for (let i = 0; i < 60; i++) {
    if (stop()) return;
    const mover = players.find((c) => c.view().hand?.phase !== 'complete' && (c.view().legal || c.view().canDraw));
    if (!mover) {
      await pause(20);
      continue;
    }
    const v = mover.view();
    if (v.canDraw) await mover.call('hand:draw', { discard: [] });
    else await mover.call('hand:act', { type: v.legal!.canCheck ? 'check' : 'call' });
  }
  throw new Error('the hand never got there');
}

describe('a move for a turn that has passed', () => {
  it('heads-up, the big blind checks on a slow phone and then folds: the check closes preflop and the fold is refused on the flop', async () => {
    const { ann, ben } = await headsUp('fold');
    // The small blind (the button heads-up) acts first before the flop, sending no turn: still played.
    const sb = ann.view().legal ? ann : ben;
    const bb = sb === ann ? ben : ann;
    await sb.until((v) => !!v.legal);
    await sb.call('hand:act', { type: 'call' });
    const before = await bb.until((v) => !!v.legal?.canCheck);
    const turn = keyOf(before);
    // Both taps are on their way before either is answered: the slow check, then the fold on the same screen.
    const check = bb.call('hand:act', { type: 'check', ...turn });
    const fold = bb.call('hand:act', { type: 'fold', ...turn });
    await expect(check).resolves.toBeTruthy();
    await expect(fold).rejects.toThrow(TOO_LATE);
    // The hand plays on, on the flop, with the big blind still in and to act.
    const flop = await bb.until((v) => v.hand?.street === 1);
    expect(flop.hand!.phase).toBe('betting');
    expect(mySeat(flop).folded).toBe(false);
    expect(flop.hand!.toAct).toBe(flop.me.seat);
    expect(flop.hand!.events.some((e) => e.t === 'action' && e.seat === flop.me.seat && e.action === 'fold')).toBe(false);
    // A move for the turn on screen now is played.
    await bb.call('hand:act', { type: 'check', ...keyOf(flop) });
    expect(bb.view().hand!.toAct).not.toBe(flop.me.seat);
  });

  it('refuses a move for an earlier hand, and a key that is not a number', async () => {
    const { ann, ben } = await headsUp('hand');
    const first = ann.view().legal ? ann : ben;
    const v1 = await first.until((v) => !!v.legal);
    await expect(first.call('hand:act', { type: 'call', handNumber: v1.hand!.handNumber, at: 'soon' })).rejects.toThrow(TOO_LATE);
    await expect(first.call('hand:act', { type: 'call', handNumber: v1.hand!.handNumber + 1, at: v1.hand!.events.length })).rejects.toThrow(TOO_LATE);
    await first.call('hand:act', { type: 'fold', ...keyOf(v1) });
    await ann.until((v) => v.hand?.phase === 'complete');
    await ann.call('host:deal');
    const second = await first.until((v) => v.hand?.handNumber === 2 && v.hand.phase !== 'complete');
    const mover = second.legal ? first : first === ann ? ben : ann;
    await mover.until((v) => !!v.legal);
    // The fold for hand 1, arriving now.
    await expect(mover.call('hand:act', { type: 'fold', ...keyOf(v1) })).rejects.toThrow(TOO_LATE);
    expect(mover.view().hand!.phase).toBe('betting');
  });

  it('refuses a draw sent for an earlier draw', async () => {
    const { ann, ben } = await headsUp('draw', { game: { gameId: 'td27' }, table: { maxSeats: 6 } });
    const players = [ann, ben];
    // Whoever draws first in the first draw, with the turn on screen: played.
    await playOn(players, () => players.some((c) => !!c.view().canDraw));
    const drawer = players.find((c) => !!c.view().canDraw)!;
    const v1 = drawer.view();
    expect(v1.hand!.street).toBe(1);
    await drawer.call('hand:draw', { discard: [], ...keyOf(v1) });
    // The same tap arriving again at the second draw is refused, and the draw is still theirs to make.
    await playOn(players, () => !!drawer.view().canDraw && drawer.view().hand!.street === 2);
    const v2 = drawer.view();
    await expect(drawer.call('hand:draw', { discard: [0, 1], ...keyOf(v1) })).rejects.toThrow(TOO_LATE);
    expect(drawer.view().canDraw).not.toBeNull();
    expect(drawer.view().hand!.events.length).toBe(v2.hand!.events.length);
    await drawer.call('hand:draw', { discard: [], ...keyOf(v2) });
    expect(drawer.view().canDraw).toBeNull();
  });

  it('refuses a show meant for an earlier hand, so it never shows the cards of a later one', async () => {
    const { ann, ben } = await headsUp('show');
    const first = ann.view().legal ? ann : ben;
    await first.until((v) => !!v.legal);
    await first.call('hand:act', { type: 'fold' });
    const done1 = await ann.until((v) => v.hand?.phase === 'complete');
    expect(done1.canShow.length).toBeGreaterThan(0);
    await ann.call('host:deal');
    const v2 = await ann.until((v) => v.hand?.handNumber === 2 && v.hand.phase !== 'complete');
    const mover = v2.legal ? ann : ben;
    await mover.until((v) => !!v.legal);
    await mover.call('hand:act', { type: 'fold' });
    await ann.until((v) => v.hand?.handNumber === 2 && v.hand.phase === 'complete');
    // Show cards, pressed after hand 1, arriving after hand 2.
    await expect(ann.call('hand:show', { cards: [0, 1], handNumber: 1 })).rejects.toThrow(/too late to show/i);
    expect(ann.view().hand!.events.some((e) => e.t === 'show')).toBe(false);
    const benSees = (await ben.until((v) => v.hand?.handNumber === 2 && v.hand.phase === 'complete')).seats[ann.view().me.seat!]!;
    expect(benSees.cards).toHaveLength(2);
    expect(benSees.cards.every((c) => c.card === '??')).toBe(true);
    // Meant for this hand, or sent without a hand (a page from before), it shows.
    await ann.call('hand:show', { cards: [0], handNumber: 2 });
    await ann.call('hand:show', { cards: [1] });
    const shown = await ben.until((v) => v.hand!.events.filter((e) => e.t === 'show').length === 2);
    expect(shown.seats[ann.view().me.seat!]!.cards).toHaveLength(2);
    expect(shown.seats[ann.view().me.seat!]!.cards.every((c) => c.card !== '??')).toBe(true);
  });

  it('ignores a run it twice vote meant for an earlier hand, so it never counts in a later vote', async () => {
    const { ann, ben } = await headsUp('rit', { play: { runItTwice: 'ask' }, seating: { requireApproval: false, rebuyRequiresApproval: false } });
    const players = [ann, ben];
    /** Both shove: the hand stops at the run it twice vote. */
    const allIn = async (handNumber: number) => {
      for (let i = 0; i < 60; i++) {
        const views = players.map((c) => c.view());
        if (views.every((v) => v.hand?.handNumber === handNumber && v.canVoteRunItTwice)) return;
        const mover = players.find((c) => c.view().hand?.handNumber === handNumber && c.view().legal);
        if (!mover) {
          await pause(20);
          continue;
        }
        const legal = mover.view().legal!;
        await mover.call('hand:act', legal.canRaise ? { type: legal.raiseKind, to: legal.maxTo } : { type: 'call' });
      }
      throw new Error('never all in');
    };
    await allIn(1);
    // Ben's yes for hand 1 is held up on a slow connection; Ann's no settles hand 1 without it.
    await ann.call('hand:runItTwice', { yes: false, handNumber: 1 });
    await ann.until((v) => v.hand?.phase === 'complete');
    for (const c of players) if (mySeat(await c.until((v) => v.hand?.phase === 'complete')).stack === 0) await c.call('seat:rebuy', { amount: 10_000 });
    await ann.call('host:deal');
    await allIn(2);
    // The held-up yes arrives during hand 2's vote: ignored, and Ben still has his vote to make.
    await ben.call('hand:runItTwice', { yes: true, handNumber: 1 });
    const still = ben.view();
    expect(still.canVoteRunItTwice).toBe(true);
    expect(still.hand!.runItTwice.votes[still.me.seat!]).toBeNull();
    expect(still.hand!.events.some((e) => e.t === 'rit-vote')).toBe(false);
    // Meant for this hand, or sent without a hand (a page from before), a vote counts.
    await ann.call('hand:runItTwice', { yes: true });
    await ben.call('hand:runItTwice', { yes: true, handNumber: 2 });
    const done = await ben.until((v) => v.hand?.handNumber === 2 && v.hand.phase === 'complete');
    expect(done.hand!.runItTwice.times).toBe(2);
  });

  it('refuses a time bank tap that arrives on a later turn', async () => {
    const { ann, ben } = await headsUp('bank', { timing: { decisionSeconds: 30, timeBankSeconds: 30, autoStartNextHand: false } });
    const sb = ann.view().legal ? ann : ben;
    const bb = sb === ann ? ben : ann;
    // A page from before sends the tap with nothing but the answer: still turned on.
    await sb.until((v) => !!v.legal);
    await new Promise<void>((resolve, reject) =>
      (sb.socket.emit as (e: string, ...a: unknown[]) => void)('hand:timeBank', (res: { ok: boolean; error?: string }) => (res.ok ? resolve() : reject(new Error(res.error)))),
    );
    expect(sb.view().turn!.usingBank).toBe(true);
    await sb.call('hand:act', { type: 'call' });
    const pre = await bb.until((v) => !!v.legal?.canCheck);
    await bb.call('hand:act', { type: 'check', ...keyOf(pre) });
    const flop = await bb.until((v) => v.hand?.street === 1 && !!v.legal);
    await expect(bb.call('hand:timeBank', keyOf(pre))).rejects.toThrow(/time bank wasn't started: the turn it was for is over/);
    expect(bb.view().turn!.usingBank).toBe(false);
    await bb.call('hand:timeBank', keyOf(flop));
    expect(bb.view().turn!.usingBank).toBe(true);
  });
});

describe('someone watching without a seat', () => {
  it('gets the same answer whatever turn a move names, so a table running behind for them gives nothing away', async () => {
    const { ann, ben, tableId } = await headsUp('watch', { spectators: { allowed: true, delaySeconds: 120 } });
    const fan = client('late-watch-fan-0123456789');
    await fan.call('table:join', { tableId });
    const watching = await fan.until((v) => !!v.spectator);
    // Two minutes behind, the watcher hasn't seen this hand dealt yet.
    expect(watching.hand).toBeNull();
    const live = (ann.view().legal ? ann : ben).view().hand!;
    const answer = (event: string, ...args: unknown[]) =>
      fan.call(event, ...args).then(
        () => 'played',
        (e: Error) => e.message,
      );
    // Every hand number and event count around the live ones, the right ones among them, and none at all.
    const keys = [{}];
    for (let handNumber = 0; handNumber <= live.handNumber + 1; handNumber++)
      for (let at = 0; at <= live.events.length + 2; at++) keys.push({ handNumber, at });
    const answers = async (send: (key: object) => Promise<string>) => new Set(await Promise.all(keys.map(send)));
    expect(await answers((key) => answer('hand:act', { type: 'fold', ...key }))).toEqual(new Set(['you are not in this hand']));
    expect(await answers((key) => answer('hand:draw', { discard: [], ...key }))).toEqual(new Set(['you are not in this hand']));
    expect(await answers((key) => answer('hand:timeBank', key))).toEqual(new Set(['you are not in this hand']));
    expect(await answers((key) => answer('hand:show', { cards: [0], ...key }))).toEqual(new Set(['you were not in the last hand']));
  });
});

describe('someone watching on a delay, after the live hand ends early', () => {
  it('can’t tell from the rabbit hunt, the fair-dealing commits, the hand list or share links that it has ended', async () => {
    const { ann, ben, tableId } = await headsUp('ended', { spectators: { allowed: true, delaySeconds: 120 } });
    const fan = client('late-ended-fan-0123456789');
    await fan.call('table:join', { tableId });
    await fan.until((v) => !!v.spectator);
    const answer = (event: string, ...args: unknown[]) =>
      fan.call(event, ...args).then(
        () => 'played',
        (e: Error) => e.message,
      );
    const asked = async () => ({
      rabbit: await answer('hand:rabbit'),
      history: [await answer('table:history', { handNumber: 1 }), await answer('table:history', { handNumber: 99 })],
      share: [await answer('hand:share', { handNumber: 1 }), await answer('hand:share', { handNumber: 99 })],
    });
    const during = await asked();
    const seen = fan.view();
    // The live hand ends before the flop: the players could now rabbit hunt it.
    const sb = ann.view().legal ? ann : ben;
    await sb.call('hand:act', { type: 'fold' });
    await sb.until((v) => v.hand?.phase === 'complete' && v.rabbit.available);
    await sb.call('hand:rabbit');
    const after = await asked();
    // Every answer the same as while the hand was live, a hand that ended the same as one that never was.
    expect(after).toEqual(during);
    expect(new Set(after.history)).toEqual(new Set(['that hand isn’t available']));
    expect(new Set(after.share)).toEqual(new Set(['that hand isn’t available']));
    expect(after.rabbit).toBe('spectators on a delay can’t rabbit hunt');
    // The view the watcher gets now says no more than it did before the hand ended.
    await pause(50);
    const now = fan.view();
    expect(now.rabbit).toEqual({ available: false, cards: null });
    expect(now.fair).toEqual(seen.fair);
    expect(now.fair.handCommit).toBeNull();
  });
});

describe('someone watching a short delay behind', () => {
  it('sees the fair-dealing commits and the seats as they were, not as the live hand ended', async () => {
    const { ann, ben, tableId } = await headsUp('short', { spectators: { allowed: true, delaySeconds: 1 } });
    const fan = client('late-short-fan-0123456789');
    await fan.call('table:join', { tableId });
    // Once a second has passed, the watcher sees the first hand being played.
    const playing = await fan.until((v) => !!v.hand && v.hand.phase !== 'complete');
    const commits = playing.fair;
    expect(commits.handCommit).toBe(ann.view().fair.handCommit);
    // Ann leaves after this hand; the live hand ends at once and her seat empties.
    (ann.socket.emit as (e: string, ...a: unknown[]) => void)('seat:stand', { afterHand: true });
    await pause(50);
    const sb = ann.view().legal ? ann : ben;
    await sb.call('hand:act', { type: 'fold' });
    await ben.until((v) => v.hand?.phase === 'complete' && !v.seats[0]);
    // Still a second behind: the hand still running, the same commits, Ann still in her seat.
    await pause(100);
    const now = fan.view();
    expect(now.hand?.phase).not.toBe('complete');
    expect(now.fair).toEqual(commits);
    expect(now.seats[0]?.name).toBe('Ann');
    expect(now.rabbit).toEqual({ available: false, cards: null });
    // Then it catches up.
    const later = await fan.until((v) => v.hand?.phase === 'complete' || !v.hand);
    expect(later.seats[0]).toBeNull();
  });
});

describe('someone without a seat, between hands and during them', () => {
  // Their answer must not say whether a hand is live, paused or voting on running it twice.
  it('gets the same refusal from every move whatever the live table is doing', () => {
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.play.runItTwice = 'ask';
    const rt = TableRuntime.create({ id: 't1', hostId: 'p0', settings }, { clock: new FakeClock(), rng: seeded() });
    for (const [seat, id] of ['p0', 'p1'].entries()) {
      rt.connect(id);
      rt.requestSeat(id, { seat, name: id, stack: 1_000 });
    }
    rt.connect('fan');
    const refusals = () => {
      const tries: (() => unknown)[] = [
        () => rt.act('fan', { type: 'fold' }),
        () => rt.draw('fan', []),
        () => rt.useTimeBank('fan'),
        () => rt.voteRunItTwice('fan', true),
        () => rt.coachTip('fan', 1, 0),
      ];
      return tries.map((t) => {
        try {
          t();
          return 'played';
        } catch (e) {
          return (e as Error).message;
        }
      });
    };
    const answers = new Set<string>();
    const seen: string[] = [];
    const look = (when: string) => {
      seen.push(when);
      refusals().forEach((a) => answers.add(a));
    };
    look('before the first hand');
    rt.start('p0');
    look('during a hand');
    rt.pause('p0', true);
    look('paused');
    rt.pause('p0', false);
    // Both all in: the hand stops at the run-it-twice vote.
    const hand = rt.state.hand!;
    rt.act(rt.state.seats[hand.toAct!]!.playerId, { type: 'raise', to: 1_000 });
    rt.act(rt.state.seats[hand.toAct!]!.playerId, { type: 'call' });
    expect(rt.state.hand!.phase).toBe('rit-vote');
    look('voting on running it twice');
    for (const id of ['p0', 'p1']) rt.voteRunItTwice(id, false);
    expect(rt.state.hand!.phase).toBe('complete');
    look('between hands');
    expect(seen).toHaveLength(5);
    expect([...answers]).toEqual(['you are not in this hand']);
  });
});

describe('the turn a player sees', () => {
  // The key is only as good as this: every event counts in each player's view, cards they can't see included.
  it.each(['nlhe', 'td27', 'stud'])('is the turn the server has, at every step of a hand of %s', (gameId) => {
    const settings = defaultSettings('cash');
    settings.game.gameId = gameId;
    settings.seating.requireApproval = false;
    const rt = TableRuntime.create({ id: 't1', hostId: 'p0', settings }, { clock: new FakeClock(), rng: seeded() });
    const ids = ['p0', 'p1', 'p2'];
    ids.forEach((id, seat) => {
      rt.connect(id);
      rt.requestSeat(id, { seat, name: id, stack: 1_000 });
    });
    rt.start('p0');
    const seen = () => {
      const hand = rt.state.hand!;
      for (const id of ids) expect(tableView(rt, id, 0).hand!.events.length, id).toBe(hand.events.length);
    };
    for (let i = 0; i < 100 && rt.state.hand!.phase !== 'complete'; i++) {
      seen();
      const hand = rt.state.hand!;
      const id = rt.state.seats[hand.toAct!]!.playerId;
      if (hand.phase === 'drawing') rt.draw(id, [0, 1]);
      else {
        const legal = engine.legalActions(hand, hand.toAct!)!;
        // One player folds early, so a folded hand is seen too.
        rt.act(id, i === 1 && legal.canFold ? { type: 'fold' } : legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
      }
    }
    expect(rt.state.hand!.phase).toBe('complete');
    seen();
    if (gameId === 'td27') expect(rt.state.hand!.events.some((e) => e.t === 'draw')).toBe(true);
  });
});
