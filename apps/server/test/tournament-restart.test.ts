import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { addOnsOpen, defaultSettings, MAX_PAYOUT_RANGES, levelEndsAt, standings, tableAddress, type StructureRow, type TournamentSettings, type TournamentState } from '@rsdp/tournament';
import { createApp, memoryStore } from '../src/app';
import type { TableRuntime } from '../src/runtime/table';
import type { RuntimeState } from '../src/runtime/types';
import { memoryTournamentStore } from '../src/tournament/store';
import { FakeClock, seeded } from './fake-clock';
import { socketClient, type Client } from './socket-client';
import { chipsInPlay, players, playUntil, registerAll, seatsAgree, setup, type Env } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

// Tests can make the next few random draws come out the same, as if two new tournaments drew one id.
const draws = vi.hoisted(() => ({ fixed: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = (n: number) => {
    if (draws.fixed <= 0) return real.randomBytes(n);
    draws.fixed--;
    return Buffer.alloc(n, 0xab);
  };
  return { ...real, randomBytes };
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** A new server process after a crash: the stores as the old one left them, and a clock of its own, so nothing the old process armed ever fires. */
async function restart(store: Env['store'], snapshots: Map<string, string>, now: number) {
  const clock = new FakeClock();
  clock.t = now;
  const env = setup({ store, snapshots, clock });
  await env.manager.resumeAll();
  return env;
}

/** Lets saves and other promise chains that need no timers finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** A store holding just this director state, as the last save left it. */
async function savedAs(state: TournamentState) {
  const store = memoryTournamentStore();
  await store.save(state, null);
  return store;
}

/** A series at 20:00 UTC every day, from the test clock's first day. */
function daily(env: Env) {
  const startAt = Date.UTC(1970, 0, 1, 20, 0);
  expect(startAt).toBeGreaterThan(env.clock.now());
  const schedule = { timeZone: 'UTC', startDate: '1970-01-01', time: '20:00', repeat: { freq: 'daily' as const } };
  return { startAt, settings: defaultSettings({ name: 'Daily', startingStack: 1000, start: { kind: 'scheduled', startAt, schedule } }) };
}

async function started(n: number, overrides: Partial<TournamentSettings> = {}) {
  const env = setup();
  const settings = defaultSettings({ name: 'Restart', startingStack: 1000, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null }, ...overrides });
  const id = await env.manager.create('host', settings);
  await registerAll(env, id, n);
  await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
  return { env, id, state: () => env.manager.view(id)!.state };
}

/** The first player to act moves all in and everyone calls (or checks) it down. */
function allIn(rt: TableRuntime) {
  while (rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null) {
    const hand = rt.state.hand;
    const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
    const legal = engine.legalActions(hand, seat.seat)!;
    rt.act(seat.playerId, legal.canRaise ? { type: legal.raiseKind, to: legal.maxTo } : legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

describe('shutting down', () => {
  it('a hand that ends as the server stops is saved by both the director and its table', async () => {
    const clock = new FakeClock();
    const tables = memoryStore();
    const tournaments = memoryTournamentStore();
    const errors: unknown[] = [];
    const server = createApp({ clock, rng: seeded(3), store: tables, tournaments, log: (m, e) => errors.push([m, e]) });
    const id = await server.tournaments.create('host', defaultSettings({ name: 'Shutdown', startingStack: 1500 }));
    for (const p of players(2)) await server.tournaments.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await server.tournaments.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const [rt] = server.tables.values();
    // The hand is over and the table has reported it, but the director acts on that a moment later.
    allIn(rt);
    expect(rt.state.handStartedAt).toBeNull();
    await server.close();

    const director = (await tournaments.load(id))!.state;
    const table = (await tables.loadTable(rt.state.id))!;
    expect(director.tables[0]).toMatchObject({ inHand: false, lastHandNumber: table.handNumber });
    for (const e of director.entries) expect(table.seats.find((x) => x?.playerId === e.playerId)?.stack ?? 0, e.playerId).toBe(e.stack);
    // Nothing moves once the server has stopped.
    clock.advance(10 * MIN);
    expect(rt.state).toEqual(table);
    expect(errors).toEqual([]);
  });

  it('players still connected as the server stops are not timed out at their tables', async () => {
    const tables = memoryStore();
    const server = createApp({ clock: new FakeClock(), rng: seeded(3), store: tables, log: () => {} });
    await new Promise<void>((resolve) => server.http.listen(0, resolve));
    const url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
    const clients: Client[] = [];
    const host = socketClient(url, 'host-secret-shutdown-0123', clients);
    const guest = socketClient(url, 'guest-secret-shutdown-0123', clients);
    try {
      // No grace: a player who drops is out of time at once.
      const settings = { seating: { offlineGraceSeconds: 0, requireApproval: false } };
      const { tableId } = await host.call<{ tableId: string }>('table:create', { settings });
      await host.call('table:join', { tableId });
      await guest.call('table:join', { tableId });
      await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
      await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
      await host.call('host:start');
      const rt = server.tables.get(tableId)!;
      expect(rt.state.hand).toMatchObject({ phase: 'betting', toAct: expect.any(Number) });
      const before = JSON.parse(JSON.stringify(rt.state));
      await server.close();
      expect(await tables.loadTable(tableId)).toEqual(before);
    } finally {
      for (const c of clients) c.close();
    }
  });

  it('an action sent while the director is being saved is not played, so the director and its table still agree', async () => {
    // A database round trip for each director save; nothing is written once the process has exited.
    let exited = false;
    const tables = memoryStore();
    const tournaments = memoryTournamentStore();
    const store = {
      ...tables,
      async saveTable(state: RuntimeState) {
        if (!exited) await tables.saveTable(state);
      },
    };
    const slow = {
      ...tournaments,
      async save(state: TournamentState, nextId: string | null) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (!exited) await tournaments.save(state, nextId);
      },
    };
    const server = createApp({ rng: seeded(3), store, tournaments: slow, log: () => {} });
    await new Promise<void>((resolve) => server.http.listen(0, resolve));
    const url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
    const clients: Client[] = [];
    const ann = socketClient(url, 'ann-secret-stopping-0123', clients);
    const bob = socketClient(url, 'bob-secret-stopping-0123', clients);
    try {
      const { id } = await ann.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Stopping', startingStack: 1500 }) });
      for (const [c, name] of [[ann, 'Ann'], [bob, 'Bob']] as const) await c.call('tournament:command', { id, command: { type: 'register', displayName: name } });
      await ann.call('tournament:command', { id, command: { type: 'startNow' } });
      const tableId = tableAddress(server.tournaments.view(id)!.state.tables[0].id);
      for (const c of [ann, bob]) await c.call('table:join', { tableId });
      const rt = server.tables.get(tableId)!;
      // Heads-up: the first to act moves all in, and the other calls just after the server starts to stop.
      const hand = rt.state.hand!;
      const first = hand.seats.find((x) => x.seat === hand.toAct)!;
      const legal = engine.legalActions(hand, first.seat)!;
      rt.act(first.playerId, { type: legal.raiseKind, to: legal.maxTo });
      const caller = rt.seatOf(first.playerId)!.name === 'Ann' ? bob : ann;
      const closing = server.close();
      await new Promise((resolve) => setTimeout(resolve, 5));
      (caller.socket.emit as (event: string, ...args: unknown[]) => void)('hand:act', { type: 'call' }, () => {});
      await closing;
      exited = true;

      const director = (await tournaments.load(id))!.state;
      const table = (await tables.loadTable(tableId))!;
      expect(director.tables[0].inHand).toBe(table.handStartedAt !== null);
      for (const e of director.entries) expect(table.seats.find((x) => x?.playerId === e.playerId)?.stack ?? 0, e.displayName).toBe(e.stack);
    } finally {
      for (const c of clients) c.close();
    }
  });
});

describe('tournaments after a crash', () => {
  it('the test setup is seeded: the same steps play the same tournament', async () => {
    // So a failure here can be replayed: the seat draw, the deals and the order players bust in all repeat.
    const run = async () => {
      const { env, state } = await started(4);
      const seats = state().entries.map((e) => [e.playerId, e.seat]);
      playUntil(env, () => state().status === 'finished');
      expect(env.errors).toEqual([]);
      return { seats, busts: state().entries.map((e) => [e.playerId, e.bust?.at]), hands: state().tables[0].lastHandNumber };
    };
    expect(await run()).toEqual(await run());
  }, 60_000);

  it.each(['during', 'before'] as const)('a bust the director never saved is replayed from the table (director saved %s the hand)', async (when) => {
    const { env, id, state } = await started(4);
    const [rt] = env.tables.values();
    // The director hears of each hand at once but saves a moment later, so after a crash its last save can be
    // from during the hand that knocked somebody out, or from between hands before it.
    let between = state();
    let during = state();
    playUntil(env, () => {
      const t = state().tables[0];
      // The hand is over and the busted player is still at the table: the director has not acted on it yet.
      const bust = rt.state.handStartedAt === null && rt.state.seats.some((x) => x?.stack === 0);
      // Before: the director must have been between hands since the last one (not so for a bust in the first hand).
      if (bust && (when === 'during' || (!between.tables[0].inHand && between.tables[0].lastHandNumber === rt.state.handNumber - 1))) return true;
      during = state();
      if (rt.state.handStartedAt === null && !t.inHand && t.lastHandNumber === rt.state.handNumber) between = state();
      return false;
    });
    const saved = when === 'during' ? during : between;
    expect(saved.tables[0].inHand).toBe(when === 'during');
    expect(saved.tables[0].lastHandNumber).toBe(when === 'during' ? rt.state.handNumber : rt.state.handNumber - 1);
    // Out: whoever the save already had out (busted in an earlier hand and gone from the table), and whoever this hand busted.
    const busted = [
      ...saved.entries.filter((e) => e.status === 'busted').map((e) => e.playerId),
      ...rt.state.seats.flatMap((x) => (x?.stack === 0 ? [x.playerId] : [])),
    ].sort();
    expect(rt.state.seats.some((x) => x?.stack === 0)).toBe(true);

    const after = await restart(await savedAs(saved), env.snapshots, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    expect(now().entries.filter((e) => e.status === 'busted').map((e) => e.playerId).sort()).toEqual(busted);
    expect(now().tables[0]).toMatchObject({ inHand: false, lastHandNumber: rt.state.handNumber });
    seatsAgree(after, id);
    expect(chipsInPlay(after)).toBe(4000);
    playUntil(after, () => now().status === 'finished');
    expect(after.errors).toEqual([]);
    expect(standings(now())[0].stack).toBe(4000);
  }, 60_000);

  it.each(['before', 'after'] as const)('a table break the director never saved is replayed, and its players reach the table they moved to (saved %s the move)', async (when) => {
    const { env, id, state } = await started(4, { seatsPerTable: 3 });
    expect(state().tables).toHaveLength(2);
    // The hand is over and the busted player is still at the table: the director has not acted on it yet.
    const unhandled = () => [...env.tables.values()].some((rt) => rt.state.handStartedAt === null && rt.state.seats.some((x) => x?.stack === 0));
    // The director hears of the hand at once but saves a moment later: its last save is from before the hand ended.
    let saved = state();
    playUntil(env, () => {
      if (unhandled()) return true;
      saved = state();
      return false;
    });
    expect(saved.tables.some((t) => t.inHand)).toBe(true);
    const before = new Map(env.snapshots);
    // The report lands: somebody is out, a table breaks and its players move.
    env.clock.advance(0);
    expect(state().tables).toHaveLength(1);
    // The broken table was saved at once; the one its players moved to may not have been saved since.
    const snapshots = new Map(when === 'after' ? env.snapshots : before);
    for (const [address, json] of env.snapshots) if (!env.tables.has(address)) snapshots.set(address, json);

    const after = await restart(await savedAs(saved), snapshots, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    expect(now().tables).toHaveLength(1);
    expect(now().entries.filter((e) => e.status === 'busted')).toHaveLength(1);
    seatsAgree(after, id);
    expect(chipsInPlay(after)).toBe(4000);
    playUntil(after, () => now().status === 'finished');
    expect(after.errors).toEqual([]);
    expect(standings(now())[0].stack).toBe(4000);
  }, 60_000);

  it.each([30_000, 70_000])('the player to act keeps their hand when the server is back %i ms later, even if a level went up meanwhile', async (gap) => {
    const level = (sb: number): StructureRow => ({ kind: 'level', sb, bb: sb * 2, ante: 0, anteType: 'none', minutes: 1 });
    const { env, id, state } = await started(3, { structure: [level(10), level(20), level(40)] });
    const [rt] = env.tables.values();
    for (let i = 0; i < 100 && !(rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null); i++) env.clock.advance(250);
    const hand = rt.state.hand!;
    expect(hand.phase).toBe('betting');
    const thinker = hand.seats.find((x) => x.seat === hand.toAct)!.playerId;

    // Down for a while: with 1-minute levels, 70 s means a level went up before the server came back.
    const after = await restart(await savedAs(state()), env.snapshots, env.clock.t + gap);
    const table = after.tables.get(rt.state.id)!;
    const seat = table.state.hand!.seats.find((x) => x.playerId === thinker)!;
    expect({ folded: seat.folded, toAct: table.state.hand!.toAct, timeouts: table.seatOf(thinker)!.timeouts }).toEqual({ folded: false, toAct: seat.seat, timeouts: 0 });
    expect(after.manager.view(id)!.state.status).toBe('running');
    expect(after.errors).toEqual([]);
  });

  it('an add-on bought during a hand the director never heard end is kept', async () => {
    const level = (sb: number): StructureRow => ({ kind: 'level', sb, bb: sb * 2, ante: 0, anteType: 'none', minutes: 5 });
    const structure = [level(10), { kind: 'break', minutes: 5, addOn: true } as const, level(20), level(40)];
    const { env, id, state } = await started(3, { structure, addOn: { max: 1, chips: 1000, approval: false } });
    const [rt] = env.tables.values();
    // A hand is dealt just before the break, which starts while it is still being played.
    const toBreak = () => levelEndsAt(state(), 1, env.clock.now())! - env.clock.now();
    playUntil(env, () => rt.state.hand?.phase === 'betting' && toBreak() < 20_000, { shove: 0 });
    env.clock.advance(toBreak());
    expect(addOnsOpen(state())).toBe(true);
    const buyer = rt.state.hand!.seats[0].playerId;
    await env.manager.command(id, buyer, '', { type: 'addOn', playerId: buyer });
    expect(rt.seatOf(buyer)!.pendingChips).toBe(1000);
    const saved = state();
    // The hand ends and the table is saved; the server stops before the director acts on it.
    playUntil(env, () => rt.state.handStartedAt === null, { shove: 0 });
    expect(saved.tables[0].inHand).toBe(true);

    const after = await restart(await savedAs(saved), env.snapshots, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    const [table] = after.tables.values();
    expect(now().tables[0]).toMatchObject({ inHand: false, lastHandNumber: rt.state.handNumber });
    for (const e of now().entries) expect(e.stack, e.playerId).toBe(table.seatOf(e.playerId)?.stack ?? 0);
    expect(now().entries.reduce((n, e) => n + e.stack, 0)).toBe(4000);
    seatsAgree(after, id);
    expect(after.errors).toEqual([]);
  });

  it('a hand the replay itself ends reaches the director after its own start, so the table is not left "in a hand"', async () => {
    const level = (sb: number): StructureRow => ({ kind: 'level', sb, bb: sb * 2, ante: 0, anteType: 'none', minutes: 60, rebuy: true });
    const { env, id, state } = await started(5, {
      seatsPerTable: 3,
      structure: [level(10), level(20)],
      rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 30 },
    });
    const rts = [...env.tables.values()];
    const t = rts.find((rt) => rt.state.seats.filter(Boolean).length === 2)!;
    const u = rts.find((rt) => rt !== t)!;
    for (const rt of rts) for (const seat of rt.state.seats) if (seat) rt.connect(seat.playerId);
    const step = (rt: TableRuntime, shove: boolean) => {
      const hand = rt.state.hand;
      if (!hand || hand.phase !== 'betting' || hand.toAct === null) return false;
      const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
      const legal = engine.legalActions(hand, seat.seat)!;
      rt.act(seat.playerId, shove && legal.canRaise ? { type: legal.raiseKind, to: legal.maxTo } : legal.canCheck ? { type: 'check' } : { type: 'call' });
      return true;
    };
    // Heads-up all-ins at one table until somebody busts there and is offered a rebuy; the other table checks along.
    for (let i = 0; i < 2000 && !t.state.seats.some((x) => x?.stack === 0); i++) if (!step(t, true) && !step(u, false)) env.clock.advance(500);
    env.clock.advance(0);
    const busted = t.state.seats.find((x) => x?.stack === 0)!.playerId;
    expect(state().entries.find((e) => e.playerId === busted)!.status).toBe('rebuy-offer');
    // The other table finishes its hand. The director's last save is from just after that.
    for (let i = 0; i < 2000 && u.state.handStartedAt !== null; i++) if (!step(u, false)) env.clock.advance(100);
    env.clock.advance(0);
    const saved = structuredClone(state());
    // The other table deals again; then the rebuy lets the first table deal at once. Only the tables are saved.
    for (let i = 0; i < 100 && u.state.handStartedAt === null; i++) env.clock.advance(500);
    env.clock.advance(100);
    await env.manager.command(id, busted, '', { type: 'rebuy', playerId: busted });
    for (let i = 0; i < 100 && t.state.handStartedAt === null; i++) env.clock.advance(100);
    expect([t.state.handStartedAt, u.state.handStartedAt].every((x) => x !== null)).toBe(true);

    // The server comes back after the rebuy offer would have run out. Replaying the lost rebuy's hand start
    // expires the offer, which folds that player out of the hand still being played, ending it during the replay.
    const after = await restart(await savedAs(saved), new Map(env.snapshots), env.clock.t + 60_000);
    after.clock.advance(0);
    const now = () => after.manager.view(id)!.state;
    for (const table of now().tables) expect(table.inHand, table.id).toBe(after.tables.get(tableAddress(table.id))!.state.handStartedAt !== null);
    seatsAgree(after, id);
    expect(after.errors).toEqual([]);
    // Nothing waits on a hand that is over: the host can pause, let the last hand finish, and end the event.
    await after.manager.command(id, 'host', '', { type: 'pause', by: 'host' });
    for (const rt of after.tables.values()) for (const seat of rt.state.seats) if (seat) rt.connect(seat.playerId);
    for (let i = 0; i < 2000 && [...after.tables.values()].some((rt) => rt.state.handStartedAt !== null); i++) {
      if (![...after.tables.values()].some((rt) => step(rt, false))) after.clock.advance(100);
    }
    await after.manager.command(id, 'host', '', { type: 'end', by: 'host' });
    expect(now().status).toBe('finished');
  });

  it('a hand that ends as a restart brings a table\'s seats in line reaches the director', async () => {
    const { env, id } = await started(2, { lateRegistration: { enabled: true, throughLevel: 4 } });
    const [rt] = env.tables.values();
    expect(rt.state.hand?.phase).toBe('betting');
    await env.manager.command(id, 'host', '', { type: 'pause', by: 'host' });
    // The table was last saved mid-hand; then a late registrant is seated there and only the director is saved.
    const lagging = new Map(env.snapshots);
    await env.manager.command(id, 'p3', 'Player 3', { type: 'register', playerId: 'p3', displayName: 'Player 3' });
    expect(rt.seatOf('p3')).not.toBeNull();
    await env.manager.flush();

    // The player to act had sat out. A restart gives a turn a fresh clock, but a player sitting out is folded at once:
    // once the late registrant is seated, that player is folded and the hand ends.
    const saved = JSON.parse(lagging.get(rt.state.id)!) as typeof rt.state;
    Object.assign(saved.seats[saved.hand!.toAct!]!, { sittingOut: true, sitOutReason: 'timeouts' });
    lagging.set(rt.state.id, JSON.stringify(saved));
    const after = await restart(env.store, lagging, env.clock.t + 10 * MIN);
    after.clock.advance(0);
    const now = () => after.manager.view(id)!.state;
    const [table] = after.tables.values();
    expect(table.state.history.map((h) => h.handNumber)).toEqual([1]);
    expect(now().tables[0]).toMatchObject({ inHand: false, lastHandNumber: 1 });
    for (const e of now().entries) expect(e.stack, e.playerId).toBe(table.seatOf(e.playerId)!.stack);
    expect(after.errors).toEqual([]);
    // Nothing waits on the hand that is over, so the host can end the paused event.
    await after.manager.command(id, 'host', '', { type: 'end', by: 'host' });
    expect(now().status).toBe('finished');
  });

  it.each([
    ['a break', [{ kind: 'break', minutes: 5 }], null],
    ['a new level', [], 100],
  ] as const)('a table between hands waits for %s that started while the server was down', async (_, next, bigBlind) => {
    const level = (sb: number, minutes: number): StructureRow => ({ kind: 'level', sb, bb: sb * 2, ante: 0, anteType: 'none', minutes });
    const { env, id } = await started(2, { structure: [level(10, 1), ...next, level(50, 20)] });
    const [rt] = env.tables.values();
    for (const seat of rt.state.seats) if (seat) rt.connect(seat.playerId);
    while (rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null) {
      const hand = rt.state.hand;
      const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
      rt.act(seat.playerId, engine.legalActions(hand, seat.seat)!.canCheck ? { type: 'check' } : { type: 'fold' });
    }
    env.clock.advance(0);
    expect(rt.state.handStartedAt).toBeNull();
    await env.manager.flush();

    // Back two minutes later: the first level ended a minute ago.
    const after = await restart(env.store, new Map(env.snapshots), env.clock.t + 2 * MIN);
    const [table] = after.tables.values();
    expect(after.manager.view(id)!.state.clock.rowIndex).toBe(1);
    if (bigBlind === null) expect(table.state.handStartedAt).toBeNull();
    else expect(table.state.hand?.input.stakes.bigBlind).toBe(bigBlind);
    expect(after.errors).toEqual([]);
  });

  it('seats players where the director has them when their tables were saved before a move', async () => {
    const env = setup();
    const startAt = env.clock.now() + 5 * MIN;
    const settings = defaultSettings({ name: 'Moves', start: { kind: 'scheduled', startAt }, startingStack: 1000, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null } });
    const id = await env.manager.create('host', settings);
    await registerAll(env, id, 10);
    env.clock.advance(4 * MIN + 1000);
    const state = () => env.manager.view(id)!.state;
    expect(state().status).toBe('seating');
    const lagging = new Map(env.snapshots);
    // Two players leave one table, so a player moves over from the other.
    const [a] = state().tables;
    for (const e of state().entries.filter((x) => x.tableId === a.id).slice(0, 2)) await env.manager.command(id, 'host', '', { type: 'remove', by: 'host', playerId: e.playerId });
    expect(env.moves.filter((m) => m.from !== '')).toHaveLength(1);
    // The director was saved after all that, the tables before it.
    await env.manager.flush();

    const after = await restart(env.store, lagging, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    seatsAgree(after, id);
    expect(chipsInPlay(after)).toBe(8000);
    after.clock.advance(MIN);
    expect(now().status).toBe('running');
    playUntil(after, () => now().status === 'finished');
    expect(after.errors).toEqual([]);
    expect(standings(now())[0].stack).toBe(8000);
  }, 60_000);
});

describe('tournament ids', () => {
  it('a new tournament never takes over one whose id it happens to draw', async () => {
    const env = setup();
    draws.fixed = 1;
    const first = await env.manager.create('host', defaultSettings({ name: 'First' }));
    draws.fixed = 1;
    const second = await env.manager.create('other', defaultSettings({ name: 'Second' }));
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toMatch(/^[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
    expect((await env.store.load(first))!.state).toMatchObject({ hostId: 'host', settings: { name: 'First' } });
    expect((await env.store.load(second))!.state).toMatchObject({ hostId: 'other', settings: { name: 'Second' } });
    expect(env.manager.view(first)!.state.settings.name).toBe('First');
  });
});

describe('the next event', () => {
  it('a Sit & Go that fills just before a crash opens one next Sit & Go, not two', async () => {
    const first = setup();
    const id = await first.manager.create('host', defaultSettings({ name: 'Turbo', startingStack: 1000, start: { kind: 'sng', playersNeeded: 3, startDelaySeconds: 60, autoSpawn: true } }));
    await registerAll(first, id, 2);
    await first.manager.flush();
    // The third player fills it: the next one is saved at once, but this one's own save is still 300 ms away.
    const third = { type: 'register', playerId: 'p3', displayName: 'Player 3' } as const;
    await first.manager.command(id, 'p3', 'Player 3', third);
    await settled();
    const next = first.manager.view(id)!.nextId;
    expect(next).not.toBeNull();
    expect((await first.store.load(id))!.state.status).toBe('registering');

    const after = await restart(first.store, first.snapshots, first.clock.t);
    await after.manager.command(id, 'p3', 'Player 3', third);
    await settled();
    after.clock.advance(1000);
    expect(after.manager.view(id)!.nextId).toBe(next);
    const open = (await after.store.listLive()).filter((t) => t.state.status === 'registering').map((t) => t.state.id);
    expect(open).toEqual([next]);
    expect(after.errors).toEqual([]);
  });

  it('a series goes on after the server was down through its next date', async () => {
    const first = setup();
    const { startAt, settings } = daily(first);
    const id = await first.manager.create('host', settings);
    await registerAll(first, id, 3);
    await first.manager.flush();
    // Back up a day and an hour after the start: the overdue event begins, and next is the one still to come.
    const after = await restart(first.store, first.snapshots, startAt + DAY + 60 * MIN);
    await settled();
    const view = after.manager.view(id)!;
    expect(view.state.status).toBe('running');
    expect(view.nextId).not.toBeNull();
    expect((await after.store.load(view.nextId!))!.state).toMatchObject({ status: 'registering', startAt: startAt + 2 * DAY });
    expect(after.errors).toEqual([]);
  });

  /** A daily series whose payouts were saved before payout tables were capped (#266), so its next event can't be made. */
  async function blockedSeries() {
    const first = setup();
    const { startAt, settings } = daily(first);
    const id = await first.manager.create('host', settings);
    const ranges = Array.from({ length: MAX_PAYOUT_RANGES + 1 }, (_, i) => ({ minEntries: 2 + 2 * i, maxEntries: 3 + 2 * i, percents: [100] }));
    ranges[ranges.length - 1]!.maxEntries = 10_000;
    (await first.manager.peek(id))!.settings.payouts = { structure: { name: 'Old', ranges }, money: { buyIn: 0, rebuy: 0, addOn: 0, added: 0 } };
    await registerAll(first, id, 3);
    first.clock.advance(startAt - first.clock.now() + 1000);
    await settled();
    const view = first.manager.view(id)!;
    expect(view.state.status).toBe('running');
    expect(view.nextId).toBeNull();
    expect(view.nextError).toContain(`At most ${MAX_PAYOUT_RANGES} ranges`);
    return { first, id, startAt };
  }

  it('a series whose next event could not be made still says why after a restart (#276)', async () => {
    const { first, id } = await blockedSeries();
    await first.manager.flush();
    const after = await restart(first.store, first.snapshots, first.clock.t);
    await settled();
    const view = after.manager.view(id)!;
    expect(view.nextId).toBeNull();
    expect(view.nextError).toContain(`At most ${MAX_PAYOUT_RANGES} ranges`);
    // Only the lobby's own field carries it, not the event's state.
    expect(view.state).not.toHaveProperty('nextError');
  });

  it('a series whose next event could not be made tries again once the host fixes the settings (#276)', async () => {
    const { first, id, startAt } = await blockedSeries();
    await first.manager.command(id, 'host', 'Host', { type: 'updateSettings', by: 'host', settings: { payouts: defaultSettings().payouts } });
    await settled();
    const view = first.manager.view(id)!;
    expect(view.nextError).toBeNull();
    expect(view.nextId).not.toBeNull();
    expect((await first.store.load(view.nextId!))!.state).toMatchObject({ status: 'registering', startAt: startAt + DAY });
    // The cleared reason is saved too, so a restart does not bring it back.
    await first.manager.flush();
    const after = await restart(first.store, first.snapshots, first.clock.t);
    expect(after.manager.view(id)!.nextError).toBeNull();
  });

  it('a series goes on after an event nobody came to', async () => {
    const env = setup();
    const { startAt, settings } = daily(env);
    const id = await env.manager.create('host', settings);
    await registerAll(env, id, 1);
    // Past the start and its 15 minutes of grace.
    env.clock.advance(startAt + 16 * MIN - env.clock.now());
    await settled();
    const view = env.manager.view(id)!;
    expect(view.state.status).toBe('cancelled');
    expect(view.nextId).not.toBeNull();
    expect((await env.store.load(view.nextId!))!.state).toMatchObject({ status: 'registering', startAt: startAt + DAY });
    expect(env.errors).toEqual([]);
  });
});
