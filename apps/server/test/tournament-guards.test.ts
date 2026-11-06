import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants, type Action } from '@rsdp/engine/core';
import { MIXED_GAMES, registerAllVariants } from '@rsdp/engine/variants';
import { addOnsOpen, defaultSettings, standings, tableAddress, type Command, type StructureRow, type TournamentSettings } from '@rsdp/tournament';
import type { TableRuntime } from '../src/runtime/table';
import { tableName } from '../src/tournament/manager';
import { chipsInPlay, playUntil, registerAll, seatsAgree, setup } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const MIN = 60_000;

/** Plays one hand at a table: the first player to act shoves, the next one calls, everyone else folds. */
function shoveAndCall(rt: TableRuntime) {
  let caller = false;
  for (let shoved = false; rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null; ) {
    const hand = rt.state.hand;
    const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
    const legal = engine.legalActions(hand, seat.seat)!;
    let action: Action;
    if (!shoved && legal.canRaise) action = { type: legal.raiseKind, to: legal.maxTo };
    else if (shoved && !caller && !legal.canCheck) action = { type: 'call' };
    else action = legal.canCheck ? { type: 'check' } : { type: 'fold' };
    if (action.type === 'call') caller = true;
    shoved ||= action.type === legal.raiseKind;
    rt.act(seat.playerId, action);
  }
}

/** A scheduled event with its seats drawn at two tables, saved and stopped as a server would on shutdown. */
async function seatedThenStopped() {
  const first = setup();
  const startAt = first.clock.now() + 5 * MIN;
  const id = await first.manager.create('host', defaultSettings({ name: 'Reload', start: { kind: 'scheduled', startAt }, startingStack: 1000, seatsPerTable: 6 }));
  await registerAll(first, id, 8);
  first.clock.advance(4 * MIN + 1000);
  const state = first.manager.view(id)!.state;
  expect(state.status).toBe('seating');
  expect(first.tables.size).toBe(2);
  await first.manager.flush();
  first.manager.dispose();
  for (const rt of first.tables.values()) rt.dispose();
  return { first, id, addresses: state.tables.map((t) => tableAddress(t.id)) };
}

describe('mixed-game tournaments', () => {
  it('a HORSE table deals Limit Hold\'em without the level\'s ante, then Limit Omaha Hi-Lo', async () => {
    const env = setup();
    const horse = MIXED_GAMES.find((m) => m.id === 'horse')!;
    const structure: StructureRow[] = [1, 2].map((n) => ({ kind: 'level', sb: 50 * n, bb: 100 * n, ante: 10 * n, anteType: 'per-player', minutes: 10 }));
    const id = await env.manager.create(
      'host',
      defaultSettings({
        name: 'HORSE',
        startingStack: 5000,
        seatsPerTable: 8,
        games: horse.steps.map((st) => st.gameId),
        gameBetting: horse.steps.map((st) => st.betting),
        structure,
        lateRegistration: { enabled: false, throughLevel: null },
      }),
    );
    await registerAll(env, id, 3);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const rt = [...env.tables.values()][0];
    for (const seat of rt.state.seats) if (seat) rt.connect(seat.playerId);
    for (let i = 0; i < 60 && !rt.state.hand; i++) env.clock.advance(1000);
    const first = rt.state.hand!.input;
    expect([first.game.id, first.betting, first.stakes.ante, first.stakes.smallBet, first.stakes.bigBet]).toEqual(['nlhe', 'fixed-limit', 0, 100, 200]);
    expect(rt.handSetup()).toMatchObject({ betting: 'fixed-limit' });
    env.clock.advance(10 * MIN);
    expect(rt.handSetup().game.id).toBe('plo8');
    expect(rt.handSetup().betting).toBe('fixed-limit');
    expect(rt.handSetup().stakes.ante).toBe(0);
  });
});

describe('tournament manager guards', () => {
  it('refuses host edits naming a game it cannot deal at this table size', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Edits', startingStack: 1000, seatsPerTable: 9 }));
    await registerAll(env, id, 3);
    const host = (command: Command) => env.manager.command(id, 'host', '', command);
    const update = (settings: Partial<TournamentSettings>) => host({ type: 'updateSettings', by: 'host', settings });

    // Before the tables exist the games can still change, but only to ones a table can deal.
    await expect(update({ games: ['no-such-game'] })).rejects.toThrow(/unknown game/);
    await expect(update({ games: ['nlhe', 'badugi'] })).rejects.toThrow(/Badugi seats at most 6/);
    await expect(update({ games: ['nlhe', 'plo4'], stopRotationAtLevel: 1.5 })).rejects.toThrow(/rotation/);
    await update({ games: ['nlhe', 'plo4'] });

    await host({ type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    const structure = state().settings.structure;
    const later = structure.findIndex((r, i) => i > 1 && r.kind === 'level');
    const withGame = (gameId: string): StructureRow[] => structure.map((r, i) => (i === later ? { ...r, gameId } : r));
    await expect(host({ type: 'editStructure', by: 'host', structure: withGame('no-such-game') })).rejects.toThrow(/unknown game/);
    await expect(host({ type: 'editStructure', by: 'host', structure: withGame('') })).rejects.toThrow(/unknown game/);
    await expect(host({ type: 'editStructure', by: 'host', structure: withGame('badugi') })).rejects.toThrow(/Badugi seats at most 6/);
    expect(state().settings.structure).toEqual(structure);
    await host({ type: 'editStructure', by: 'host', structure: withGame('plo4') });
    expect(state().settings.structure[later]).toMatchObject({ gameId: 'plo4' });
    expect(env.errors).toEqual([]);
  });

  it('refuses a new tournament whose levels would pick a game nobody can deal', async () => {
    const env = setup();
    const settings = defaultSettings({ name: 'Games', startingStack: 1000 });
    const later = settings.structure.findIndex((r, i) => i > 0 && r.kind === 'level');
    // An empty level game and a rotation stop between levels both name a game that is not there.
    const structure = settings.structure.map((r, i) => (i === later ? { ...r, gameId: '' } : r));
    await expect(env.manager.create('host', { ...settings, structure })).rejects.toThrow(/unknown game/);
    await expect(env.manager.create('host', { ...settings, games: ['nlhe', 'plo4'], stopRotationAtLevel: 1.5 })).rejects.toThrow(/rotation/);
  });

  it('a table that fails to deal is logged, and the tournament is still saved and timed', async () => {
    const first = setup();
    const id = await first.manager.create('host', defaultSettings({ name: 'Broken', startingStack: 1000 }));
    await registerAll(first, id, 3);
    await first.manager.flush();
    first.manager.dispose();
    // A saved event whose game this server does not have (an older build, or a removed variant).
    const saved = (await first.store.load(id))!;
    await first.store.save({ ...saved.state, settings: { ...saved.state.settings, games: ['no-such-game'] } }, saved.nextId);

    const env = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    await env.manager.resumeAll();
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    // Logged by the manager, or by the table when it catches the failure itself.
    expect(env.errors.length).toBeGreaterThan(0);
    expect(env.errors.every((x) => /deal/.test((x as [string])[0]))).toBe(true);
    env.clock.advance(1000);
    expect((await env.store.load(id))!.state.status).toBe('running');
    // The clock still runs: the first level ends on time.
    env.clock.advance(env.manager.view(id)!.state.settings.structure[0].minutes * MIN);
    expect(env.manager.view(id)!.state.clock.rowIndex).toBe(1);
  });

  it('a rebuy that frees a held table for a balance move deals after the move, so no chips appear', async () => {
    const env = setup();
    const structure = defaultSettings({ startingStack: 1000 }).structure.map((r, i) => (r.kind === 'level' && i < 3 ? { ...r, rebuy: true } : r));
    const id = await env.manager.create(
      'host',
      defaultSettings({
        name: 'Rebalance',
        startingStack: 1000,
        seatsPerTable: 6,
        structure,
        rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 300 },
        lateRegistration: { enabled: false, throughLevel: null },
      }),
    );
    await registerAll(env, id, 10);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    const [held, other] = state().tables.map((t) => t.id);
    const rt = env.tables.get(tableAddress(held))!;
    const count = (tableId: string) => state().tables.find((t) => t.id === tableId)!.seats.filter(Boolean).length;
    expect([count(held), count(other)]).toEqual([5, 5]);
    // The held table's players are at their browsers, so its hands wait for them.
    for (const seat of rt.state.seats) if (seat) rt.connect(seat.playerId);

    // Heads-up all-ins at one table until somebody busts there and is offered a rebuy.
    for (let i = 0; i < 50 && !state().entries.some((e) => e.status === 'rebuy-offer'); i++) {
      shoveAndCall(rt);
      env.clock.advance(10_000);
    }
    const offered = state().entries.find((e) => e.status === 'rebuy-offer')!;
    expect(offered.tableId).toBe(held);

    // Thin the other table: the held table now has to give up a player, which waits for the offer.
    const removed = state().entries.filter((e) => e.tableId === other && e.status === 'seated').slice(0, 2);
    for (const e of removed) await env.manager.command(id, 'host', '', { type: 'remove', by: 'host', playerId: e.playerId });
    const otherRt = env.tables.get(tableAddress(other))!;
    const between = (x: TableRuntime) => (x.state.hand?.phase ?? 'complete') === 'complete';
    for (let i = 0; i < 300 && (count(other) > 3 || !between(otherRt)); i++) env.clock.advance(1000);
    expect([count(held), count(other)]).toEqual([5, 3]);
    // The held table already tried to deal and is waiting on the director.
    expect(rt.state.nextHandAt).toBeNull();
    expect(between(rt)).toBe(true);
    const before = chipsInPlay(env);
    expect(state().entries.reduce((a, e) => a + e.stack, 0)).toBe(before);

    const moves = env.moves.length;
    await env.manager.command(id, offered.playerId, offered.displayName, { type: 'rebuy', playerId: offered.playerId });
    // The rebuy and the move it allows land together; the held table deals only once the moved player has gone.
    expect(env.moves.slice(moves).map((m) => m.from)).toEqual([tableAddress(held)]);
    expect(rt.state.hand && rt.state.hand.phase !== 'complete').toBe(true);
    seatsAgree(env, id);
    expect(chipsInPlay(env)).toBe(before + 1000);

    playUntil(env, () => state().status === 'finished');
    expect(env.errors).toEqual([]);
    expect(standings(state())[0].stack).toBe(before + 1000);
  }, 60_000);

  it('the director hears of a deal at once, so a command in the same moment cannot move a player out of the hand', async () => {
    const env = setup();
    const settings = defaultSettings({ name: 'Same moment', startingStack: 1000, seatsPerTable: 3, lateRegistration: { enabled: true, throughLevel: 4 } });
    const id = await env.manager.create('host', settings);
    await registerAll(env, id, 6);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    expect(state().tables.map((t) => t.inHand)).toEqual([true, true]);
    // A late registration handled before any timer runs opens a third table that needs players.
    await env.manager.command(id, 'p7', 'Player 7', { type: 'register', playerId: 'p7', displayName: 'Player 7' });
    expect(state().tables).toHaveLength(3);
    seatsAgree(env, id);
    expect(chipsInPlay(env)).toBe(7000);

    playUntil(env, () => state().status === 'finished');
    expect(env.errors).toEqual([]);
    expect(standings(state())[0].stack).toBe(7000);
  }, 60_000);

  it('an add-on bought after a hand ends but before the director acts on it counts on top of the hand', async () => {
    const env = setup();
    const structure: StructureRow[] = [
      { kind: 'level', sb: 10, bb: 20, ante: 0, anteType: 'none', minutes: 1 },
      { kind: 'break', minutes: 5, addOn: true },
      { kind: 'level', sb: 20, bb: 40, ante: 0, anteType: 'none', minutes: 20 },
    ];
    const settings = defaultSettings({
      name: 'Add-on race',
      startingStack: 1000,
      structure,
      addOn: { max: 1, chips: 1500, approval: false },
      lateRegistration: { enabled: false, throughLevel: null },
    });
    const id = await env.manager.create('host', settings);
    await registerAll(env, id, 3);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    const rt = [...env.tables.values()][0];
    for (const seat of rt.state.seats) if (seat) rt.connect(seat.playerId);
    // The break and its add-ons start while a hand is still being played.
    for (let i = 0; i < 120 && !addOnsOpen(state()); i++) env.clock.advance(1000);
    expect(addOnsOpen(state())).toBe(true);
    expect(rt.state.hand?.phase).toBe('betting');

    // Finish the hand, then add on before any timer runs.
    while (rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null) {
      const hand = rt.state.hand;
      const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
      rt.act(seat.playerId, engine.legalActions(hand, seat.seat)!.canCheck ? { type: 'check' } : { type: 'call' });
    }
    expect(rt.state.hand?.phase).toBe('complete');
    await env.manager.command(id, 'p1', 'Player 1', { type: 'addOn', playerId: 'p1' });
    env.clock.advance(1);

    for (const e of state().entries) expect(e.stack, e.playerId).toBe(rt.seatOf(e.playerId)!.stack);
    expect(state().entries.reduce((a, e) => a + e.stack, 0)).toBe(4500);
    expect(env.errors).toEqual([]);
  });

  it('a table whose clock ran out a moment ago waits for the add-on on its way before ending the hand', async () => {
    const env = setup();
    const structure: StructureRow[] = [
      { kind: 'level', sb: 10, bb: 20, ante: 0, anteType: 'none', minutes: 1 },
      { kind: 'break', minutes: 5, addOn: true },
      { kind: 'level', sb: 20, bb: 40, ante: 0, anteType: 'none', minutes: 20 },
    ];
    const settings = defaultSettings({
      name: 'Add-on lag',
      startingStack: 1000,
      seatsPerTable: 3,
      structure,
      addOn: { max: 1, chips: 1500, approval: false },
      lateRegistration: { enabled: false, throughLevel: null },
    });
    const id = await env.manager.create('host', settings);
    await registerAll(env, id, 4);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    const [t1, t2] = state().tables.map((t) => env.tables.get(tableAddress(t.id))!);
    for (const rt of [t1, t2]) for (const seat of rt.state.seats) if (seat) rt.connect(seat.playerId);
    const toAct = (rt: TableRuntime) => {
      const hand = rt.state.hand;
      return hand?.phase === 'betting' && hand.toAct !== null ? hand.seats.find((x) => x.seat === hand.toAct)! : null;
    };
    const passive = (rt: TableRuntime) => {
      const seat = toAct(rt);
      if (seat) rt.act(seat.playerId, engine.legalActions(rt.state.hand!, seat.seat)!.canCheck ? { type: 'check' } : { type: 'call' });
    };
    for (let i = 0; i < 20 && !addOnsOpen(state()); i++) {
      passive(t1);
      passive(t2);
      env.clock.advance(20_000);
    }
    expect(addOnsOpen(state())).toBe(true);

    // At the first table one player bets and the next one lets their clock run.
    const bettor = toAct(t1)!;
    t1.act(bettor.playerId, { type: engine.legalActions(t1.state.hand!, bettor.seat)!.raiseKind, to: engine.legalActions(t1.state.hand!, bettor.seat)!.minTo });
    env.clock.advance(1000);
    // At the other table someone moves all in, which a call will end in a bust and a table break.
    const shover = toAct(t2)!;
    const legal = engine.legalActions(t2.state.hand!, shover.seat)!;
    t2.act(shover.playerId, { type: legal.raiseKind, to: legal.maxTo });
    const caller = toAct(t2)!;
    for (let i = 0; i < 200 && !t1.state.turn?.usingBank; i++) env.clock.advance(1000);
    // Just past the first table's deadline, before its timer runs: the call and the bettor's add-on arrive.
    env.clock.t = t1.turnDeadline()! + 1;
    t2.act(caller.playerId, { type: 'call' });
    await env.manager.command(id, bettor.playerId, '', { type: 'addOn', playerId: bettor.playerId });
    env.clock.advance(0);
    expect(t1.seatOf(bettor.playerId)!.stack).toBe(state().entries.find((e) => e.playerId === bettor.playerId)!.stack);
    expect(state().entries.filter((e) => e.status === 'seated').reduce((n, e) => n + e.stack, 0)).toBe(chipsInPlay(env));
    expect(env.errors).toEqual([]);
  });

  it('names each table after its tournament within the table-name limit, even with emoji', async () => {
    expect(tableName('Friday Game', 2)).toBe('Friday Game · Table 2');
    for (const name of ['🏆🏆🏆 Sunday Major Championship', '😀'.repeat(20), '𠀀'.repeat(28), 'x'.repeat(40)]) {
      for (const n of [1, 10, 100]) {
        const t = tableName(name, n);
        expect(t.length, `${name} ${n}`).toBeLessThanOrEqual(40);
        expect(t.endsWith(` · Table ${n}`)).toBe(true);
        expect(t).not.toMatch(/\p{Cs}/u);
      }
    }
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: '🏆🏆🏆 Sunday Major Championship', startingStack: 1000, seatsPerTable: 3 }));
    await registerAll(env, id, 6);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    expect([...env.tables.values()].map((rt) => rt.state.settings.table.name).sort()).toEqual([
      '🏆🏆🏆 Sunday Major Championsh · Table 1',
      '🏆🏆🏆 Sunday Major Championsh · Table 2',
    ]);
    expect(env.errors).toEqual([]);
  });

  it('a restart that fails to load a table leaves nothing half-loaded, and the next visit loads it whole', async () => {
    const { first, id, addresses } = await seatedThenStopped();
    // The second table's snapshot fails to load once (the database was briefly unreachable).
    const snapshots = new Map(first.snapshots);
    const get = snapshots.get.bind(snapshots);
    let failures = 1;
    snapshots.get = (key: string) => {
      if (key === addresses[1] && failures-- > 0) throw new Error('storage is down');
      return get(key);
    };
    const second = setup({ store: first.store, snapshots, clock: first.clock });
    await second.manager.resumeAll();
    expect(second.errors).toHaveLength(1);
    expect(second.manager.view(id)).toBeNull();
    expect(second.tables.size).toBe(0);
    expect(second.manager.tournamentOf(addresses[0])).toBeNull();

    expect(await second.manager.loadTableOwner(addresses[1])).toBe(id);
    expect([...second.tables.keys()].sort()).toEqual([...addresses].sort());
    second.clock.advance(MIN);
    expect(second.manager.view(id)!.state.status).toBe('running');
    expect([...second.tables.values()].every((rt) => rt.state.hand)).toBe(true);
    expect(chipsInPlay(second)).toBe(8000);
  });

  it('a table that fails to resume does not stop the others or the tournament clock', async () => {
    const { first, id, addresses } = await seatedThenStopped();
    // The first table's first save after the restart fails, so its resume throws.
    const snapshots = new Map(first.snapshots);
    const set = snapshots.set.bind(snapshots);
    let failures = 1;
    snapshots.set = (key: string, value: string) => {
      if (key === addresses[0] && failures-- > 0) throw new Error('disk full');
      return set(key, value);
    };
    const second = setup({ store: first.store, snapshots, clock: first.clock });
    await second.manager.resumeAll();
    expect(second.errors.map((x) => (x as [string])[0])).toEqual([expect.stringMatching(/resum/)]);
    expect(second.tables.size).toBe(2);
    second.clock.advance(MIN);
    expect(second.manager.view(id)!.state.status).toBe('running');
    expect([...second.tables.values()].every((rt) => rt.state.hand)).toBe(true);
  });

  it('never arms a timer for a wake time that is not a number', async () => {
    const first = setup();
    const id = await first.manager.create('host', defaultSettings({ name: 'Wake', start: { kind: 'scheduled', startAt: first.clock.now() + 10 * MIN } }));
    await registerAll(first, id, 2);
    await first.manager.flush();
    first.manager.dispose();
    // A saved setting the director cannot do arithmetic with.
    const saved = (await first.store.load(id))!;
    await first.store.save({ ...saved.state, settings: { ...saved.state.settings, seatLeadSeconds: 'soon' as unknown as number } }, saved.nextId);

    const second = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    const delays: number[] = [];
    const arm = second.clock.setTimeout;
    second.clock.setTimeout = (fn, ms) => {
      delays.push(ms);
      return arm(fn, ms);
    };
    await second.manager.resumeAll();
    expect(delays.filter((ms) => !Number.isFinite(ms))).toEqual([]);
    expect(second.errors.map((x) => (x as [string])[0])).toEqual([expect.stringMatching(/wake/)]);
    expect(second.manager.view(id)!.state.status).toBe('registering');
  });
});
