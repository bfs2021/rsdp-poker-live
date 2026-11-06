import { beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { MIXED_GAMES, registerAllVariants, studAnteForBigBlindAnte } from '@rsdp/engine/variants';
import { defaultSettings, MAX_PAYOUT_RANGES, standings, summarize, type StructureRow, type TournamentSettings } from '@rsdp/tournament';
import { players, playUntil, setup } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const MIN = 60_000;

const chipsInPlay = (env: ReturnType<typeof setup>) => {
  let total = 0;
  for (const rt of env.tables.values()) {
    for (const seat of rt.state.seats) if (seat) total += seat.pendingChips + (rt.state.hand?.seats.find((x) => x.playerId === seat.playerId) ? 0 : seat.stack);
    if (rt.state.hand) for (const x of rt.state.hand.seats) total += x.startStack;
  }
  return total;
};

describe('tournaments on the server', () => {
  it('starts a scheduled tournament on its own and plays it down to a winner', async () => {
    const env = setup();
    const startAt = env.clock.now() + 10 * MIN;
    const settings: TournamentSettings = defaultSettings({
      name: 'Friday',
      start: { kind: 'scheduled', startAt },
      startingStack: 1000,
      seatsPerTable: 6,
      lateRegistration: { enabled: false, throughLevel: null },
    });
    const id = await env.manager.create('host', settings);
    for (const p of players(14)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: 'spoofed', displayName: 'x' });
    const state = () => env.manager.view(id)!.state;
    expect(state().entries.map((e) => e.playerId)).toContain('p1');
    expect(state().entries.every((e) => e.playerId !== 'spoofed')).toBe(true);

    // A minute before the start the seats are drawn; nobody presses start.
    env.clock.advance(9 * MIN + 1000);
    expect(state().status).toBe('seating');
    expect(env.tables.size).toBe(3);
    expect([...env.tables.values()].every((rt) => !rt.state.hand)).toBe(true);
    // Each player is told where they sit.
    expect(env.moves.filter((m) => m.from === '').map((m) => m.playerId).sort()).toEqual(players(14).map((p) => p.id).sort());
    env.clock.advance(MIN);
    expect(state().status).toBe('running');
    expect([...env.tables.values()].every((rt) => rt.state.hand)).toBe(true);
    expect(chipsInPlay(env)).toBe(14 * 1000);

    playUntil(env, () => state().status === 'finished');
    expect(env.errors).toEqual([]);
    expect(state().status).toBe('finished');
    // Everyone has a place (players busted in the same hand with equal stacks share one) and one winner has every chip.
    const places = standings(state()).map((s) => s.place);
    expect(places.every((p) => p !== null && p >= 1 && p <= 14)).toBe(true);
    expect(places.filter((p) => p === 1)).toHaveLength(1);
    expect(standings(state())[0].stack).toBe(14 * 1000);
    // Tables broke as players busted, and players were moved to keep them balanced.
    expect(env.tables.size).toBe(1);
    expect(env.moves.filter((m) => m.from !== '').length).toBeGreaterThan(0);
  }, 60_000);

  it("a finished Sit & Go's last table shows the winner, with no countdown to a next hand", async () => {
    // With fair dealing's lead time on too, as in production: the table must not wait for a next commitment either.
    for (const fairLeadMs of [0, 2500]) {
      const env = setup(undefined, { fairLeadMs });
      const id = await env.manager.create('host', defaultSettings({ name: 'Turbo', startingStack: 300, start: { kind: 'sng', playersNeeded: 3, startDelaySeconds: 0, autoSpawn: false } }));
      for (const p of players(3)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
      const state = () => env.manager.view(id)!.state;
      env.clock.advance(1000);
      expect(state().status).toBe('running');
      playUntil(env, () => state().status === 'finished', { shove: 40 });
      expect(state().status).toBe('finished');
      expect(env.tables.size).toBe(1);
      const last = [...env.tables.values()][0];
      expect(last.state.nextHandAt).toBeNull();
      // Nor does one come back once the director has handled the result and the table's clocks run on.
      env.clock.advance(1000);
      expect(last.state.nextHandAt).toBeNull();
      env.clock.advance(MIN);
      expect(last.state.nextHandAt).toBeNull();
      expect(last.state.hand?.phase ?? 'complete').toBe('complete');
      expect(env.errors).toEqual([]);
    }
  }, 30_000);

  it("gives every table the event's clock, time bank and rabbit hunt rules", async () => {
    const env = setup();
    const tableRules = { decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30, rabbitHunt: false };
    const id = await env.manager.create('host', defaultSettings({ name: 'RSDP', start: { kind: 'manual' }, startingStack: 1000, tableRules }));
    for (const p of players(3)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', 'Host', { type: 'startNow', by: 'host' });
    env.clock.advance(MIN);
    const rt = [...env.tables.values()][0]!;
    expect(rt.state.settings.timing).toMatchObject({ decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30 });
    expect(rt.state.settings.play).toMatchObject({ rabbitHunt: false });
    expect(rt.state.seats.find((x) => x)?.timeBank).toBe(20);
    // Once tables exist the rules are locked, so every table plays the same way.
    await expect(env.manager.command(id, 'host', 'Host', { type: 'updateSettings', by: 'host', settings: { tableRules: { ...tableRules, rabbitHunt: true } } })).rejects.toThrow(/tableRules is locked/);
  });

  it('an event saved before events had their own rules keeps the old clock and rabbit hunting', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Old', start: { kind: 'manual' }, startingStack: 1000 }));
    for (const p of players(3)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', 'Host', { type: 'startNow', by: 'host' });
    const rt = [...env.tables.values()][0]!;
    expect(rt.state.settings.timing).toMatchObject({ decisionSeconds: 30, timeBankSeconds: 30, timeBankRefillHands: 10 });
    expect(rt.state.settings.play.rabbitHunt).toBe(true);
  });

  it('a host who switches an event to the RSDP rules before the start gets them at every table, and in the next event of the series', async () => {
    const env = setup();
    const startAt = env.clock.now() + 10 * MIN;
    const at = new Date(startAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    const schedule = { timeZone: 'UTC', startDate: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`, time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`, repeat: { freq: 'daily' as const } };
    const id = await env.manager.create(
      'host',
      defaultSettings({ name: 'Series', start: { kind: 'scheduled', startAt, schedule }, startingStack: 1000, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null } }),
    );
    const rsdp = { decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30, rabbitHunt: false };
    await env.manager.command(id, 'host', 'Host', { type: 'updateSettings', by: 'host', settings: { tableRules: rsdp } });
    for (const p of players(8)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    env.clock.advance(10 * MIN + 1000);
    expect(env.manager.view(id)!.state.status).toBe('running');
    expect(env.tables.size).toBe(2);
    for (const rt of env.tables.values()) {
      expect(rt.state.settings.timing).toMatchObject({ decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30 });
      expect(rt.state.settings.play.rabbitHunt).toBe(false);
      expect(rt.state.seats.filter((x) => x).every((x) => x!.timeBank === 20)).toBe(true);
    }
    // The next event of the series is made from this one's settings.
    await new Promise((r) => setTimeout(r, 0));
    const next = env.manager.view(id)!.nextId;
    expect(next).toBeTruthy();
    expect((await env.manager.peek(next!))!.settings.tableRules).toEqual(rsdp);
  });

  it('tells the lobby when the next event of a series cannot be made from settings that no longer pass the checks', async () => {
    const env = setup();
    const startAt = env.clock.now() + 10 * MIN;
    const at = new Date(startAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    const schedule = { timeZone: 'UTC', startDate: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`, time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`, repeat: { freq: 'daily' as const } };
    const id = await env.manager.create('host', defaultSettings({ name: 'Series', start: { kind: 'scheduled', startAt, schedule } }));
    // Saved before payout tables were capped: one range for each two entry counts, more than a table may have now.
    const ranges = Array.from({ length: MAX_PAYOUT_RANGES + 1 }, (_, i) => ({ minEntries: 2 + 2 * i, maxEntries: 3 + 2 * i, percents: [100] }));
    ranges[ranges.length - 1]!.maxEntries = 10_000;
    (await env.manager.peek(id))!.settings.payouts = { structure: { name: 'Old', ranges }, money: { buyIn: 0, rebuy: 0, addOn: 0, added: 0 } };
    expect(env.manager.view(id)!.nextError).toBeNull();
    // Nobody comes, so the event is cancelled and the series moves on to its next one.
    env.clock.advance(10 * MIN + 1000);
    env.clock.advance(env.manager.view(id)!.state.settings.graceMinutes * MIN + 1000);
    expect(env.manager.view(id)!.state.status).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 0));
    const view = env.manager.view(id)!;
    expect(view.nextId).toBeNull();
    expect(view.nextError).toContain(`At most ${MAX_PAYOUT_RANGES} ranges`);
  });

  it("keeps a player's mood emoji when they are moved to another table", async () => {
    const env = setup();
    const settings: TournamentSettings = defaultSettings({
      name: 'Moods',
      start: { kind: 'scheduled', startAt: env.clock.now() + 2 * MIN },
      startingStack: 1000,
      seatsPerTable: 6,
      lateRegistration: { enabled: false, throughLevel: null },
    });
    const id = await env.manager.create('host', settings);
    for (const p of players(14)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    env.clock.advance(2 * MIN + 1000);
    for (const rt of env.tables.values()) for (const seat of rt.state.seats) if (seat) rt.setPreferences(seat.playerId, { mood: '🔥' });
    const moved = () => env.moves.find((m) => m.from !== '');
    playUntil(env, () => !!moved());
    const m = moved()!;
    expect(env.tables.get(m.to)!.seatOf(m.playerId)?.mood).toBe('🔥');
  }, 60_000);

  it('keeps what is left of a player\'s time bank when they are moved to another table', async () => {
    const env = setup();
    const settings: TournamentSettings = defaultSettings({
      name: 'Banks',
      start: { kind: 'scheduled', startAt: env.clock.now() + 2 * MIN },
      startingStack: 1000,
      seatsPerTable: 6,
      lateRegistration: { enabled: false, throughLevel: null },
      tableRules: { decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30, rabbitHunt: false },
    });
    const id = await env.manager.create('host', settings);
    for (const p of players(14)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    env.clock.advance(2 * MIN + 1000);
    // Everyone has used 13 s of their 20 s bank.
    for (const rt of env.tables.values()) for (const seat of rt.state.seats) if (seat) seat.timeBank = 7;
    const moved = () => env.moves.find((m) => m.from !== '');
    playUntil(env, () => !!moved());
    const m = moved()!;
    const seat = env.tables.get(m.to)!.seatOf(m.playerId)!;
    expect(seat.timeBank).toBeLessThanOrEqual(7);
    expect(seat.handsSinceRefill).toBeGreaterThan(0);
  }, 60_000);

  it('plays a mixed-game tournament (Hold\'em, Omaha, Stud, Triple Draw, Badugi) to the end', async () => {
    const env = setup();
    const games = ['nlhe', 'plo4', 'stud', 'td27', 'badugi'];
    const id = await env.manager.create('host', defaultSettings({ name: 'Mixed', games, startingStack: 600, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null } }));
    for (const p of players(25)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    const seen = new Set<string>();
    const watch = () => {
      for (const rt of env.tables.values()) if (rt.state.hand) seen.add(rt.state.hand.input.game.id);
      return state().status === 'finished';
    };
    playUntil(env, watch, { shove: 2, thinkMs: 4000 });
    const levels = state().clock.rowIndex;
    expect(env.errors).toEqual([]);
    expect(state().status).toBe('finished');
    expect(standings(state())[0].stack).toBe(25 * 600);
    expect([...seen].sort(), `levels reached: ${levels}`).toEqual([...games].sort());
  }, 120_000);

  it("HORSE with big-blind antes: the stud levels ante about an eighth each, Hold'em and Omaha none", async () => {
    const env = setup();
    const horse = MIXED_GAMES.find((m) => m.id === 'horse')!;
    const blinds: [number, number][] = [[100, 200], [150, 300], [150, 300], [200, 400], [250, 500], [300, 600]];
    const structure: StructureRow[] = blinds.map(([sb, bb]) => ({ kind: 'level', sb, bb, ante: bb, anteType: 'big-blind', minutes: 5 }));
    const id = await env.manager.create(
      'host',
      defaultSettings({ name: 'HORSE', games: horse.steps.map((st) => st.gameId), gameBetting: horse.steps.map((st) => st.betting), structure, startingStack: 100_000, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null } }),
    );
    for (const p of players(6)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const antes = new Map<string, { bb: number; posts: [string, number][]; shown: string }>();
    const watch = () => {
      for (const rt of env.tables.values()) {
        const h = rt.state.hand;
        if (!h || antes.has(h.input.game.id)) continue;
        const posts = h.events.flatMap((e) => (e.t === 'post' && e.kind.endsWith('ante') ? [[e.kind, e.amount] as [string, number]] : []));
        const c = summarize(env.manager.view(id)!.state, env.clock.now()).clock!;
        antes.set(h.input.game.id, { bb: h.input.stakes.bigBlind, posts, shown: `${c.level.anteType} ${c.level.ante}` });
      }
      return antes.size === 5;
    };
    playUntil(env, watch, { shove: 0, thinkMs: 4000 });
    expect(env.errors).toEqual([]);
    const razz = antes.get('razz')!;
    const stud = antes.get('stud')!;
    expect([razz.bb, stud.bb]).toEqual([300, 400]);
    // Everyone antes, about an eighth of the big-blind ante: never a full big blind each.
    for (const { bb, posts } of [razz, stud]) expect(posts).toEqual(Array(6).fill(['ante', studAnteForBigBlindAnte(bb)]));
    const [razzEach, studEach] = [razz.posts[0][1], stud.posts[0][1]];
    expect(razzEach).toBeGreaterThanOrEqual(30);
    expect(razzEach).toBeLessThanOrEqual(50);
    expect(studEach).toBeGreaterThanOrEqual(40);
    expect(studEach).toBeLessThanOrEqual(60);
    // The lobby's clock says what is dealt.
    expect([razz.shown, stud.shown]).toEqual(['per-player 40', 'per-player 50']);
    // In a mix with stud the blind games post no ante of either kind (D29).
    expect(antes.get('nlhe')!.posts).toEqual([]);
    expect(antes.get('plo8')!.posts).toEqual([]);
  }, 60_000);

  it('only lets the host run the tournament, and never takes hand reports from browsers', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Locked' }));
    await env.manager.command(id, 'p1', 'Ann', { type: 'register', playerId: 'p1', displayName: 'Ann' });
    await env.manager.command(id, 'p2', 'Bob', { type: 'register', playerId: 'p2', displayName: 'Bob' });
    await expect(env.manager.command(id, 'p1', 'Ann', { type: 'startNow', by: 'host' })).rejects.toThrow(/host/);
    await expect(
      env.manager.command(id, 'p1', 'Ann', { type: 'handResult', result: { tableId: 'x', handNumber: 1, startStacks: {}, endStacks: {} } }),
    ).rejects.toThrow();
    await expect(env.manager.command(id, 'p3', '', { type: 'register', playerId: 'p3', displayName: '' })).rejects.toThrow(/name/);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'someone-else' });
    expect(env.manager.view(id)!.state.status).toBe('running');
    expect(env.manager.view(id)!.state.rng).toBe(0);
  });

  it('deals the first hand to everyone at the table and gives players time to get there', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Arrivals', startingStack: 1000 }));
    for (const p of players(3)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const [rt] = env.tables.values();
    expect(rt.state.hand!.input.seats).toHaveLength(3);
    // Nobody has opened the table yet; the first player gets the offline grace, not an instant fold.
    const first = rt.state.hand!.toAct;
    env.clock.advance(10_000);
    expect(rt.state.hand!.toAct).toBe(first);
    env.clock.advance(6_000);
    expect(rt.state.hand!.phase === 'complete' || rt.state.hand!.toAct !== first).toBe(true);
    // The tournament runs its tables: not even its host pauses, stops or changes one directly.
    expect(() => rt.pause('host', true)).toThrow(/lobby/);
    expect(() => rt.updateSettings('host', {})).toThrow(/lobby/);
    expect(() => rt.stop('host')).toThrow(/tournament/);
    expect(() => rt.dealNext('host')).toThrow();
  });

  it('carries on after a restart: a scheduled start still happens and tables come back', async () => {
    const first = setup();
    const startAt = first.clock.now() + 5 * MIN;
    const id = await first.manager.create('host', defaultSettings({ name: 'Restart', start: { kind: 'scheduled', startAt }, startingStack: 500, seatsPerTable: 6 }));
    for (const p of players(4)) await first.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    first.clock.advance(300);
    await first.manager.flush();
    first.manager.dispose();

    // A new server process with the same storage and clock.
    const second = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    await second.manager.resumeAll();
    second.clock.advance(5 * MIN);
    const state = second.manager.view(id)!.state;
    expect(state.status).toBe('running');
    expect(second.tables.size).toBe(1);
    const [rt] = second.tables.values();
    expect(rt.state.hand).not.toBeNull();

    // Mid-hand restart: the table resumes from its snapshot with the same hand.
    const handId = rt.state.hand!.input.handId;
    second.clock.advance(300);
    await second.manager.flush();
    second.manager.dispose();
    for (const t of second.tables.values()) t.dispose();
    const third = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    await third.manager.resumeAll();
    const [again] = third.tables.values();
    expect(again.state.hand?.input.handId).toBe(handId);
    playUntil(third, () => third.manager.view(id)!.state.status === 'finished');
    expect(third.manager.view(id)!.state.status).toBe('finished');
    expect(third.errors).toEqual([]);
  }, 60_000);

  it('a busted player with a rebuy offer holds the table until they decide', async () => {
    const env = setup();
    const structure = defaultSettings({ startingStack: 100 }).structure.map((r, i) => (r.kind === 'level' && i < 3 ? { ...r, rebuy: true } : r));
    const id = await env.manager.create(
      'host',
      defaultSettings({ name: 'Rebuys', startingStack: 100, seatsPerTable: 6, structure, rebuy: { max: 2, chips: 100, approval: false, offerSeconds: 30 } }),
    );
    for (const p of players(3)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    playUntil(env, () => state().entries.some((e) => e.status === 'rebuy-offer'));
    const offered = state().entries.find((e) => e.status === 'rebuy-offer')!;
    const [rt] = env.tables.values();
    // Wait past the deal the table scheduled (the showdown pause, plus any run-out), still well inside the 30 s offer:
    // the table must not deal while the player decides.
    const dueIn = (rt.state.nextHandAt ?? env.clock.t) - env.clock.t;
    expect(dueIn).toBeLessThan(25_000);
    env.clock.advance(Math.max(5000, dueIn + 2000));
    expect(rt.state.hand?.phase ?? 'complete').toBe('complete');
    await env.manager.command(id, offered.playerId, offered.displayName, { type: 'rebuy', playerId: offered.playerId });
    env.clock.advance(5000);
    expect(rt.state.seats.find((x) => x?.playerId === offered.playerId)?.stack).toBe(100);
    expect(rt.state.hand && rt.state.hand.phase !== 'complete').toBe(true);
  }, 30_000);

  it('with re-entry open to the end, the last player left wins a minute after the last bust with nobody doing anything', async () => {
    const env = setup();
    const id = await env.manager.create(
      'host',
      defaultSettings({
        name: 'Re-entry',
        startingStack: 100,
        seatsPerTable: 6,
        lateRegistration: { enabled: false, throughLevel: null },
        reEntry: { enabled: true, throughLevel: null, max: null, approval: false },
      }),
    );
    for (const p of players(2)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    playUntil(env, () => state().entries.filter((e) => e.status === 'seated').length === 1);
    // The busted player has a minute to re-enter; then the server's own wake-up ends the event.
    const lastOut = Math.max(...state().eliminations.map((g) => g.at));
    env.clock.advance(lastOut + MIN - 1 - env.clock.now());
    expect(state().status).toBe('running');
    env.clock.advance(1);
    expect(state().status).toBe('finished');
    expect(standings(state()).map((s) => s.place)).toEqual([1, 2]);
    expect(env.errors).toEqual([]);
  }, 30_000);

  it('a last player left waiting on the host to answer a late registration does not keep the server waking with nothing to do', async () => {
    const env = setup();
    const id = await env.manager.create(
      'host',
      defaultSettings({
        name: 'Re-entry',
        startingStack: 100,
        seatsPerTable: 6,
        lateRegistration: { enabled: true, throughLevel: 4 },
        registrationApproval: true,
        reEntry: { enabled: true, throughLevel: null, max: null, approval: false },
      }),
    );
    const state = () => env.manager.view(id)!.state;
    for (const p of players(2)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    for (const r of state().requests) await env.manager.command(id, 'host', '', { type: 'approve', by: 'host', requestId: r.id });
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    await env.manager.command(id, 'late', 'Late', { type: 'register', playerId: 'late', displayName: 'Late' });
    playUntil(env, () => state().entries.filter((e) => e.status === 'seated').length === 1);
    // The re-entry minute runs out while the late registration still waits for the host: nothing to do until they answer.
    env.clock.advance(2 * MIN);
    expect(state().status).toBe('running');
    await env.manager.command(id, 'host', '', { type: 'reject', by: 'host', requestId: state().requests[0].id });
    expect(state().status).toBe('finished');
    expect(env.errors).toEqual([]);
  }, 30_000);
});
