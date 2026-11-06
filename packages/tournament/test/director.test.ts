import { describe, expect, it } from 'vitest';
import { MIXED_GAMES } from '@rsdp/engine/variants';
import {
  apply,
  createTournament,
  defaultSettings,
  DirectorError,
  levelFor,
  validateSettings,
  nextWakeAt,
  payoutPreset,
  standings,
  tableGate,
  tick,
  type Command,
  type DirectorEvent,
  type StructureRow,
  type TournamentSettings,
  type TournamentState,
} from '../src';
import { nextRandom } from '../src/seating';

const MIN = 60_000;
const T0 = Date.parse('2026-10-30T00:00:00Z');
const START = T0 + 60 * MIN;

const levels: StructureRow[] = [
  { kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 10, rebuy: true },
  { kind: 'level', sb: 100, bb: 200, ante: 0, anteType: 'none', minutes: 10, rebuy: true },
  { kind: 'break', minutes: 5, addOn: true },
  { kind: 'level', sb: 200, bb: 400, ante: 50, anteType: 'per-player', minutes: 10 },
  { kind: 'level', sb: 400, bb: 800, ante: 800, anteType: 'big-blind', minutes: 10 },
  { kind: 'level', sb: 1000, bb: 2000, ante: 2000, anteType: 'big-blind', minutes: 10 },
];

/** Test harness: keeps state, collects events, owns the clock. */
class Sim {
  state: TournamentState;
  events: DirectorEvent[] = [];
  now = T0;
  constructor(overrides: Partial<TournamentSettings> = {}) {
    this.state = createTournament({
      id: 'T',
      hostId: 'host',
      settings: defaultSettings({ structure: levels, startingStack: 1000, lateRegistration: { enabled: false, throughLevel: null }, ...overrides }),
      now: this.now,
      seed: 42,
    });
  }
  do(cmd: Command) {
    const r = apply(this.state, cmd, this.now);
    this.state = r.state;
    this.events.push(...r.events);
    return r.events;
  }
  at(t: number) {
    this.now = t;
    const r = tick(this.state, t);
    this.state = r.state;
    this.events.push(...r.events);
    return r.events;
  }
  register(n: number, from = 0) {
    for (let i = from; i < from + n; i++) this.do({ type: 'register', playerId: `p${i}`, displayName: `P${i}` });
  }
  of<K extends DirectorEvent['type']>(type: K) {
    return this.events.filter((e): e is Extract<DirectorEvent, { type: K }> => e.type === type);
  }
  entry(playerId: string) {
    return this.state.entries.filter((e) => e.playerId === playerId).at(-1)!;
  }
  /** Plays a hand at a table: `bust` players lose everything to `winner`. */
  hand(tableId: string, winner: string, bust: string[] = [], button?: number) {
    const t = this.state.tables.find((x) => x.id === tableId)!;
    const ids = t.seats.filter((x): x is string => !!x).map((id) => this.state.entries.find((e) => e.id === id)!);
    const start = Object.fromEntries(ids.map((e) => [e.playerId, e.stack]));
    const end = { ...start };
    for (const b of bust) {
      end[winner] += end[b];
      end[b] = 0;
    }
    this.do({ type: 'handStarted', tableId, handNumber: t.lastHandNumber + 1 });
    return this.do({
      type: 'handResult',
      result: { tableId, handNumber: t.lastHandNumber + 1, startStacks: start, endStacks: end, knockedOutBy: Object.fromEntries(bust.map((b) => [b, [winner]])), button },
    });
  }
  seatedAt(tableId: string) {
    return this.state.entries.filter((e) => e.tableId === tableId && e.status !== 'busted').map((e) => e.playerId);
  }
}

const scheduled = (extra: Partial<TournamentSettings> = {}): Partial<TournamentSettings> => ({ start: { kind: 'scheduled', startAt: START }, ...extra });

describe('scheduled auto-start', () => {
  it('seats a minute early and deals at the start time with no host action', () => {
    const sim = new Sim(scheduled());
    sim.register(12);
    expect(nextWakeAt(sim.state)).toBe(START - MIN);
    sim.at(START - MIN);
    const created = sim.of('tablesCreated')[0].tables;
    expect(created.map((t) => t.seats.length)).toEqual([6, 6]);
    expect(sim.state.status).toBe('seating');
    expect(tableGate(sim.state, created[0].tableId, sim.now)).toBe('hold');
    expect(nextWakeAt(sim.state)).toBe(START);
    sim.at(START);
    expect(sim.state.status).toBe('running');
    expect(sim.of('started')).toHaveLength(1);
    expect(sim.of('levelUp')[0]).toMatchObject({ levelNumber: 1, sb: 50, bb: 100 });
    expect(tableGate(sim.state, created[0].tableId, sim.now)).toBe('deal');
    expect(levelFor(sim.state, created[0].tableId)).toMatchObject({ gameId: 'nlhe', sb: 50, bb: 100, ante: 0, anteType: 'none' });
  });

  it('a late tick still seats and starts in one go', () => {
    const sim = new Sim(scheduled());
    sim.register(3);
    sim.at(START + 5000);
    expect(sim.state.status).toBe('running');
    expect(sim.state.startedAt).toBe(START + 5000);
  });

  it('with fewer than 2 players, waits through the grace period and starts as soon as a second registers', () => {
    const sim = new Sim(scheduled());
    sim.register(1);
    expect(nextWakeAt(sim.state)).toBe(START);
    sim.at(START);
    expect(sim.of('startDelayed')[0]).toMatchObject({ graceUntil: START + 15 * MIN });
    expect(sim.state.status).toBe('registering');
    sim.now = START + 4 * MIN;
    sim.register(1, 1);
    expect(sim.state.status).toBe('running');
  });

  it('cancels when the grace period ends without 2 players', () => {
    const sim = new Sim(scheduled());
    sim.register(1);
    sim.at(START);
    expect(nextWakeAt(sim.state)).toBe(START + 15 * MIN);
    sim.at(START + 15 * MIN);
    expect(sim.state.status).toBe('cancelled');
    expect(sim.of('cancelled')[0].reason).toBe('not-enough-players');
  });

  it('asks the server to create the next occurrence of a series when it starts', () => {
    const startAt = Date.parse('2026-11-06T00:30:00Z');
    const sim = new Sim({
      start: { kind: 'scheduled', startAt, schedule: { timeZone: 'America/New_York', startDate: '2026-11-05', time: '19:30', repeat: { freq: 'weekly', weekdays: [4] } } },
    });
    sim.register(2);
    sim.at(startAt);
    expect(new Date(sim.of('scheduleNext')[0].startAt).toISOString()).toBe('2026-11-13T00:30:00.000Z');
  });

  it('rejects a start time in the past', () => {
    expect(() => createTournament({ id: 'x', hostId: 'h', settings: defaultSettings({ start: { kind: 'scheduled', startAt: T0 - 1 } }), now: T0, seed: 1 })).toThrow(
      DirectorError,
    );
  });
});

describe('Sit & Go', () => {
  it('seats when full, spawns the next one, and deals after the delay', () => {
    const sim = new Sim({ start: { kind: 'sng', playersNeeded: 6, startDelaySeconds: 30, autoSpawn: true } });
    sim.register(5);
    expect(sim.state.status).toBe('registering');
    sim.do({ type: 'unregister', playerId: 'p4' });
    sim.register(2, 5);
    expect(sim.state.status).toBe('seating');
    expect(sim.of('spawnNext')).toHaveLength(1);
    expect(nextWakeAt(sim.state)).toBe(T0 + 30_000);
    sim.at(T0 + 30_000);
    expect(sim.state.status).toBe('running');
    expect(sim.state.tables).toHaveLength(1);
    expect(() => sim.do({ type: 'unregister', playerId: 'p0' })).toThrow('only quit');
  });
});

describe('clock, breaks and pause', () => {
  it('levels up, holds tables on the break, and offers add-ons there', () => {
    const sim = new Sim({ addOn: { max: 1, chips: 500, approval: false } });
    sim.register(4);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    expect(nextWakeAt(sim.state)).toBe(T0 + 10 * MIN);
    sim.at(T0 + 10 * MIN);
    expect(levelFor(sim.state, t).bb).toBe(200);
    sim.at(T0 + 20 * MIN);
    expect(sim.of('breakStarted')[0]).toMatchObject({ minutes: 5, endsAt: T0 + 25 * MIN, addOn: true });
    expect(tableGate(sim.state, t, sim.now)).toBe('hold');
    expect(levelFor(sim.state, t)).toMatchObject({ bb: 400, ante: 50, anteType: 'per-player', levelNumber: 3 });
    sim.do({ type: 'addOn', playerId: 'p0' });
    expect(sim.entry('p0').stack).toBe(1500);
    expect(() => sim.do({ type: 'addOn', playerId: 'p0' })).toThrow('No add-ons left');
    sim.at(T0 + 25 * MIN);
    expect(sim.of('breakEnded')).toHaveLength(1);
    expect(tableGate(sim.state, t, sim.now)).toBe('deal');
    expect(() => sim.do({ type: 'addOn', playerId: 'p1' })).toThrow('not open');
  });

  it('pausing freezes the clock', () => {
    const sim = new Sim();
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    sim.now = T0 + 4 * MIN;
    sim.do({ type: 'pause', by: 'host' });
    expect(nextWakeAt(sim.state)).toBeNull();
    expect(tableGate(sim.state, sim.state.tables[0].id, sim.now)).toBe('hold');
    sim.now = T0 + 64 * MIN;
    sim.do({ type: 'resume', by: 'host' });
    expect(nextWakeAt(sim.state)).toBe(T0 + 70 * MIN);
  });

  it('rotates games per level and stops rotating at the chosen level', () => {
    const sim = new Sim({ games: ['nlhe', 'plo', 'stud'], stopRotationAtLevel: 2 });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    expect(levelFor(sim.state, t).gameId).toBe('nlhe');
    sim.at(T0 + 10 * MIN);
    expect(levelFor(sim.state, t).gameId).toBe('plo');
    sim.at(T0 + 25 * MIN);
    expect(levelFor(sim.state, t).gameId).toBe('plo');
  });

  it('plays HORSE with each game\'s own betting, and only the stud levels ante', () => {
    const anteLevels: StructureRow[] = [1, 2, 3, 4, 5, 6].map((n) => ({ kind: 'level', sb: 50 * n, bb: 100 * n, ante: 10 * n, anteType: 'per-player', minutes: 10 }));
    const horse = MIXED_GAMES.find((m) => m.id === 'horse')!;
    const sim = new Sim({ structure: anteLevels, games: horse.steps.map((st) => st.gameId), gameBetting: horse.steps.map((st) => st.betting) });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    const seen = [];
    for (let level = 0; level < 6; level++) {
      sim.at(T0 + level * 10 * MIN + MIN);
      const l = levelFor(sim.state, t);
      seen.push([l.gameId, l.betting, l.ante]);
    }
    expect(seen).toEqual([
      ['nlhe', 'fixed-limit', 0],
      ['plo8', 'fixed-limit', 0],
      ['razz', 'fixed-limit', 30],
      ['stud', 'fixed-limit', 40],
      ['stud8', 'fixed-limit', 50],
      ['nlhe', 'fixed-limit', 0],
    ]);
    expect(sim.of('levelUp').find((e) => e.levelNumber === 2)).toMatchObject({ gameId: 'plo8', betting: 'fixed-limit', ante: 0 });
  });

  it('8-Game deals Hold\'em both Limit and No-Limit; a game left to its usual betting says nothing', () => {
    const eight = MIXED_GAMES.find((m) => m.id === '8-game')!;
    const sim = new Sim({ games: eight.steps.map((st) => st.gameId), gameBetting: eight.steps.map((st) => st.betting), seatsPerTable: 6 });
    expect(sim.state.settings.gameBetting).toHaveLength(8);
    const plain = new Sim({ games: ['nlhe', 'stud'] });
    plain.register(2);
    plain.do({ type: 'startNow', by: 'host' });
    expect(levelFor(plain.state, plain.state.tables[0].id)).not.toHaveProperty('betting');
  });

  it('a mix with stud keeps its antes once the rotation stops on a blind game', () => {
    const anteLevels: StructureRow[] = [1, 2, 3].map((n) => ({ kind: 'level', sb: 50 * n, bb: 100 * n, ante: 10 * n, anteType: 'per-player', minutes: 10 }));
    const sim = new Sim({ structure: anteLevels, games: ['stud', 'nlhe'], stopRotationAtLevel: 2 });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.at(T0 + 21 * MIN);
    expect(levelFor(sim.state, t)).toMatchObject({ levelNumber: 3, gameId: 'nlhe', ante: 30 });
  });

  it('refuses betting that does not line up with the games', () => {
    const base = defaultSettings({ games: ['nlhe', 'stud'] });
    expect(validateSettings({ ...base, gameBetting: ['fixed-limit'] })).toContain('Give one betting choice for each game');
    expect(validateSettings({ ...base, gameBetting: ['fixed-limit', 'huge' as never] })).toContain('Betting must be no-limit, pot-limit or fixed-limit');
    expect(validateSettings({ ...base, gameBetting: ['fixed-limit', null] })).toEqual([]);
  });

  it('only future levels can be edited once running', () => {
    const sim = new Sim();
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    const edited = structuredClone(levels);
    (edited[0] as { bb: number }).bb = 150;
    expect(() => sim.do({ type: 'editStructure', by: 'host', structure: edited })).toThrow('Only levels after');
    const later = structuredClone(levels);
    later[5] = { ...(later[5] as object), minutes: 20 } as StructureRow;
    sim.do({ type: 'editStructure', by: 'host', structure: later });
    expect(sim.of('structureEdited')).toHaveLength(1);
  });

  it('levels added while the last level runs past its length start from the edit, one at a time', () => {
    const short = levels.slice(0, 2);
    const sim = new Sim({ structure: short });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.at(T0 + 10 * MIN);
    // Level 2 is the last: it runs on long past its 10 minutes.
    sim.at(T0 + 120 * MIN);
    expect(levelFor(sim.state, t)).toMatchObject({ levelNumber: 2, bb: 200 });
    const edit = sim.now;
    sim.do({
      type: 'editStructure',
      by: 'host',
      structure: [
        ...short,
        { kind: 'level', sb: 200, bb: 400, ante: 0, anteType: 'none', minutes: 10 },
        { kind: 'break', minutes: 5, addOn: false },
        { kind: 'level', sb: 300, bb: 600, ante: 0, anteType: 'none', minutes: 10 },
        { kind: 'level', sb: 500, bb: 1000, ante: 0, anteType: 'none', minutes: 10 },
      ],
    });
    // The next level starts now, and the ones after it follow at their own lengths.
    expect(nextWakeAt(sim.state)).toBe(edit);
    const before = sim.events.length;
    sim.at(edit + 1000);
    expect(sim.events.slice(before).map((e) => e.type)).toEqual(['levelUp']);
    expect(levelFor(sim.state, t)).toMatchObject({ levelNumber: 3, bb: 400 });
    sim.at(edit + 10 * MIN);
    expect(sim.of('breakStarted').at(-1)).toMatchObject({ minutes: 5, endsAt: edit + 15 * MIN });
    expect(tableGate(sim.state, t, sim.now)).toBe('hold');
    sim.at(edit + 15 * MIN);
    expect(levelFor(sim.state, t)).toMatchObject({ levelNumber: 4, bb: 600 });
    expect(tableGate(sim.state, t, sim.now)).toBe('deal');
  });

  it('a level added during a pause, with the last level past its length, starts when play resumes', () => {
    const short = levels.slice(0, 2);
    const sim = new Sim({ structure: short });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    sim.at(T0 + 10 * MIN);
    sim.now = T0 + 60 * MIN;
    sim.do({ type: 'pause', by: 'host' });
    sim.do({ type: 'editStructure', by: 'host', structure: [...short, { kind: 'level', sb: 200, bb: 400, ante: 0, anteType: 'none', minutes: 10 }] });
    sim.now = T0 + 70 * MIN;
    sim.do({ type: 'resume', by: 'host' });
    expect(nextWakeAt(sim.state)).toBe(sim.now);
    sim.at(sim.now);
    expect(levelFor(sim.state, '')).toMatchObject({ levelNumber: 3, bb: 400 });
  });
});

describe('busts, rebuys and re-entry', () => {
  it('ranks same-hand busts by starting stack, and ties equal stacks', () => {
    const sim = new Sim();
    sim.register(5);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    // p1 and p2 bust p3 first so stacks differ, then a three-way bust.
    sim.hand(t, 'p0', ['p1']);
    const e = sim.hand(t, 'p0', ['p2', 'p3', 'p4']);
    // p2, p3 and p4 all started with 1000: they tie for 2nd.
    expect(e.filter((x) => x.type === 'eliminated').map((x) => (x as { place: number }).place)).toEqual([2, 2, 2]);
    expect(sim.state.status).toBe('finished');
    const st = standings(sim.state);
    expect(st.map((s) => [s.playerId, s.place])).toEqual([
      ['p0', 1],
      ['p2', 2],
      ['p3', 2],
      ['p4', 2],
      ['p1', 5],
    ]);
    expect(st[1].eliminatedBy).toEqual(['p0']);
  });

  it('bigger starting stack places higher', () => {
    const sim = new Sim();
    sim.register(4);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.state.entries.find((e) => e.playerId === 'p2')!.stack = 600;
    sim.state.entries.find((e) => e.playerId === 'p3')!.stack = 400;
    sim.hand(t, 'p0', ['p3', 'p2']);
    expect(Object.fromEntries(standings(sim.state).map((s) => [s.playerId, s.place]))).toMatchObject({ p2: 3, p3: 4 });
  });

  it('offers a rebuy that holds only that table, then expires into a bust', () => {
    const sim = new Sim({ rebuy: { max: 2, chips: 1000, approval: false, offerSeconds: 15 } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, 'p0', ['p1']);
    expect(sim.of('rebuyOffered')[0]).toMatchObject({ playerId: 'p1', expiresAt: T0 + 15_000, chips: 1000 });
    expect(tableGate(sim.state, t, sim.now)).toBe('hold');
    sim.do({ type: 'rebuy', playerId: 'p1' });
    expect(sim.entry('p1')).toMatchObject({ status: 'seated', stack: 1000, rebuys: 1 });
    expect(tableGate(sim.state, t, sim.now)).toBe('deal');
    sim.hand(t, 'p0', ['p1']);
    expect(nextWakeAt(sim.state)).toBe(T0 + 15_000);
    sim.at(T0 + 15_000);
    expect(sim.entry('p1').status).toBe('busted');
    expect(sim.of('eliminated')[0]).toMatchObject({ playerId: 'p1', place: 3 });
  });

  it('rebuys with host approval, and a rejection busts the player', () => {
    const sim = new Sim({ rebuy: { max: 2, chips: 1000, approval: true, offerSeconds: 15 } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, 'p0', ['p1']);
    sim.do({ type: 'rebuy', playerId: 'p1' });
    const req = sim.of('requestPending')[0].request;
    sim.do({ type: 'approve', by: 'host', requestId: req.id });
    expect(sim.entry('p1').stack).toBe(1000);
    sim.hand(t, 'p0', ['p1']);
    sim.do({ type: 'rebuy', playerId: 'p1' });
    sim.do({ type: 'reject', by: 'host', requestId: sim.of('requestPending')[1].request.id });
    expect(sim.entry('p1').status).toBe('busted');
  });

  it('no rebuy after the rebuy levels', () => {
    const sim = new Sim({ rebuy: { max: 5, chips: 1000, approval: false, offerSeconds: 15 } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    sim.at(T0 + 20 * MIN);
    expect(sim.of('rebuysClosed')).toHaveLength(0); // rebuys stay open on the break after a rebuy level
    sim.at(T0 + 25 * MIN);
    expect(sim.of('rebuysClosed')).toHaveLength(1);
    sim.hand(sim.state.tables[0].id, 'p0', ['p1']);
    expect(sim.entry('p1').status).toBe('busted');
  });

  it('re-entry replaces the busted entry and gets a fresh stack', () => {
    const sim = new Sim({ reEntry: { enabled: true, throughLevel: 2, max: 1, approval: false } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, 'p0', ['p1']);
    sim.do({ type: 'reEnter', playerId: 'p1' });
    expect(sim.entry('p1')).toMatchObject({ entryNo: 2, status: 'seated', stack: 1000 });
    sim.hand(t, 'p0', ['p1']);
    expect(() => sim.do({ type: 'reEnter', playerId: 'p1' })).toThrow('No re-entries left');
    sim.hand(t, 'p0', ['p2']);
    // p2 could still re-enter, so p0 waits until re-entry closes after level 2.
    expect(sim.state.status).toBe('running');
    sim.at(T0 + 5 * MIN);
    expect(sim.state.status).toBe('running');
    sim.at(T0 + 20 * MIN);
    expect(sim.state.status).toBe('finished');
    const st = standings(sim.state);
    expect(st.map((s) => [s.playerId, s.entryNo, s.place])).toEqual([
      ['p0', 1, 1],
      ['p2', 1, 2],
      ['p1', 2, 3],
    ]);
  });

  it('with re-entry open to the end, the last player left wins a minute after the last bust if nobody re-enters', () => {
    // What the create form sends when the host ticks "Re-entry after busting" and leaves both boxes empty.
    const sim = new Sim({ reEntry: { enabled: true, throughLevel: null, max: null, approval: false } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, 'p0', ['p1', 'p2']);
    // The busted players have a minute to come back; the server is woken when it runs out.
    expect(sim.state.status).toBe('running');
    expect(nextWakeAt(sim.state)).toBe(T0 + MIN);
    sim.at(T0 + MIN - 1000);
    expect(sim.state.status).toBe('running');
    sim.at(T0 + MIN);
    expect(sim.state.status).toBe('finished');
    expect(standings(sim.state).map((s) => [s.playerId, s.place])).toEqual([
      ['p0', 1],
      ['p1', 2],
      ['p2', 2],
    ]);
  });

  it('with re-entry open to the end, a re-entry waiting for the host holds the last player left past that minute', () => {
    const sim = new Sim({ reEntry: { enabled: true, throughLevel: null, max: null, approval: true } });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, 'p0', ['p1']);
    sim.now += 30_000;
    sim.do({ type: 'reEnter', playerId: 'p1' });
    sim.at(T0 + 5 * MIN);
    expect(sim.state.status).toBe('running');
    sim.do({ type: 'approve', by: 'host', requestId: sim.of('requestPending').at(-1)!.request.id });
    expect(sim.entry('p1')).toMatchObject({ entryNo: 2, status: 'seated' });
    // Busted again, p1 asks again, and the host says no two minutes later: the minute is up, so p0 wins.
    sim.hand(t, 'p0', ['p1']);
    sim.do({ type: 'reEnter', playerId: 'p1' });
    sim.now += 2 * MIN;
    sim.do({ type: 'reject', by: 'host', requestId: sim.of('requestPending').at(-1)!.request.id });
    expect(sim.state.status).toBe('finished');
    expect(standings(sim.state).map((s) => [s.playerId, s.entryNo, s.place])).toEqual([
      ['p0', 1, 1],
      ['p1', 2, 2],
    ]);
  });

  it('with re-entry open to the end, a late registration still waiting for the host after that minute does not wake the server again and again', () => {
    const sim = new Sim({
      reEntry: { enabled: true, throughLevel: null, max: null, approval: false },
      lateRegistration: { enabled: true, throughLevel: 4 },
      registrationApproval: true,
    });
    sim.register(3);
    for (const r of sim.of('requestPending')) sim.do({ type: 'approve', by: 'host', requestId: r.request.id });
    sim.do({ type: 'startNow', by: 'host' });
    sim.do({ type: 'register', playerId: 'late', displayName: 'Late' });
    sim.hand(sim.state.tables[0].id, 'p0', ['p1', 'p2']);
    sim.at(T0 + 2 * MIN);
    // The minute is up, but p0 still waits for the host's answer: the next wake-up is the end of level 1, not a time already past.
    expect(sim.state.status).toBe('running');
    expect(nextWakeAt(sim.state)).toBe(T0 + 10 * MIN);
    sim.do({ type: 'reject', by: 'host', requestId: sim.of('requestPending').at(-1)!.request.id });
    expect(sim.state.status).toBe('finished');
  });

  it('with re-entry open to the end, a last player left on a rebuy offer is woken when the offer runs out, not when the re-entry minute does', () => {
    const sim = new Sim({
      allowQuit: true,
      rebuy: { max: 2, chips: 1000, approval: false, offerSeconds: 120 },
      reEntry: { enabled: true, throughLevel: null, max: null, approval: false },
    });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, 'p0', ['p2']);
    sim.do({ type: 'declineRebuy', playerId: 'p2' });
    // p0 leaves during a hand that busts p1, so p1, on a rebuy offer, is the only one left.
    sim.do({ type: 'handStarted', tableId: t, handNumber: 2 });
    sim.do({ type: 'quit', playerId: 'p0' });
    sim.do({ type: 'handResult', result: { tableId: t, handNumber: 2, startStacks: { p0: 2000, p1: 1000 }, endStacks: { p0: 3000, p1: 0 }, knockedOutBy: { p1: ['p0'] } } });
    expect(sim.entry('p1').status).toBe('rebuy-offer');
    const expiresAt = sim.entry('p1').rebuyOfferExpiresAt!;
    expect(nextWakeAt(sim.state)).toBe(expiresAt);
    sim.at(expiresAt);
    expect(sim.state.status).toBe('finished');
  });

  it('with re-entry open to the end, a last player left waiting on a rebuy the host has not answered is not woken again and again once the minute is up', () => {
    const sim = new Sim({
      allowQuit: true,
      rebuy: { max: 2, chips: 1000, approval: true, offerSeconds: 15 },
      reEntry: { enabled: true, throughLevel: null, max: null, approval: false },
    });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, 'p0', ['p2']);
    sim.do({ type: 'declineRebuy', playerId: 'p2' });
    sim.do({ type: 'handStarted', tableId: t, handNumber: 2 });
    sim.do({ type: 'quit', playerId: 'p0' });
    sim.do({ type: 'handResult', result: { tableId: t, handNumber: 2, startStacks: { p0: 2000, p1: 1000 }, endStacks: { p0: 3000, p1: 0 }, knockedOutBy: { p1: ['p0'] } } });
    sim.do({ type: 'rebuy', playerId: 'p1' });
    sim.at(T0 + 2 * MIN);
    expect(sim.entry('p1').status).toBe('rebuy-offer');
    expect(nextWakeAt(sim.state)).toBe(T0 + 10 * MIN);
  });

  it('re-entry through the last level, which never ends, is open to the end: the last player left wins a minute after the last bust', () => {
    const sim = new Sim({ structure: levels.slice(0, 2), reEntry: { enabled: true, throughLevel: 2, max: null, approval: false } });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    sim.at(T0 + 15 * MIN);
    sim.hand(sim.state.tables[0].id, 'p0', ['p1']);
    expect(sim.state.status).toBe('running');
    expect(nextWakeAt(sim.state)).toBe(T0 + 16 * MIN);
    sim.at(T0 + 16 * MIN);
    expect(sim.state.status).toBe('finished');
    expect(standings(sim.state).map((s) => [s.playerId, s.place])).toEqual([
      ['p0', 1],
      ['p1', 2],
    ]);
  });

  it('re-entry through a level past the end of the structure is open to the end too, until levels are added that reach it', () => {
    const sim = new Sim({ structure: levels.slice(0, 2), reEntry: { enabled: true, throughLevel: 3, max: null, approval: false } });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    sim.hand(sim.state.tables[0].id, 'p0', ['p1']);
    expect(nextWakeAt(sim.state)).toBe(T0 + MIN);
    // With a third level and a fourth after it, re-entry closes when level 3 ends, so p0 waits for that instead.
    sim.do({ type: 'editStructure', by: 'host', structure: [...levels.slice(0, 2), levels[3], levels[4]] });
    expect(nextWakeAt(sim.state)).toBe(T0 + 10 * MIN);
    sim.at(T0 + 5 * MIN);
    expect(sim.state.status).toBe('running');
    sim.at(T0 + 30 * MIN);
    expect(sim.of('reEntryClosed')).toHaveLength(1);
    expect(sim.state.status).toBe('finished');
  });

  it('late registration is open until it closes', () => {
    const sim = new Sim({ lateRegistration: { enabled: true, throughLevel: 1 } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    sim.hand(sim.state.tables[0].id, 'p0', ['p1']);
    expect(sim.state.status).toBe('running');
    sim.register(1, 3);
    expect(sim.of('seatPlayer')[0].reason).toBe('late-registration');
    expect(tableGate(sim.state, sim.state.tables[0].id, sim.now)).toBe('deal');
    sim.at(T0 + 10 * MIN);
    expect(sim.of('lateRegistrationClosed')).toHaveLength(1);
    expect(() => sim.register(1, 4)).toThrow('Registration is closed');
  });

  it('a lone survivor wins even while late registration is open', () => {
    const sim = new Sim({ lateRegistration: { enabled: true, throughLevel: 4 } });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    sim.hand(sim.state.tables[0].id, 'p0', ['p1']);
    expect(sim.state.status).toBe('finished');
    expect(standings(sim.state).map((s) => [s.playerId, s.place])).toEqual([
      ['p0', 1],
      ['p1', 2],
    ]);
    expect(() => sim.register(1, 2)).toThrow();
  });

  it('a lone survivor waits for a late registration the host has not approved yet', () => {
    const sim = new Sim({ lateRegistration: { enabled: true, throughLevel: 4 }, registrationApproval: true });
    sim.register(2);
    for (const r of sim.of('requestPending')) sim.do({ type: 'approve', by: 'host', requestId: r.request.id });
    sim.do({ type: 'startNow', by: 'host' });
    sim.register(1, 2);
    sim.hand(sim.state.tables[0].id, 'p0', ['p1']);
    expect(sim.state.status).toBe('running');
    sim.do({ type: 'approve', by: 'host', requestId: sim.of('requestPending').at(-1)!.request.id });
    expect(sim.entry('p2').status).toBe('seated');
  });

  it('with nobody busted yet, a lone player waits for late registration', () => {
    const sim = new Sim({ lateRegistration: { enabled: true, throughLevel: 4 } });
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    sim.do({ type: 'remove', by: 'host', playerId: 'p1' });
    expect(sim.state.status).toBe('running');
  });

  it('a quit during a hand takes effect when the hand ends', () => {
    const sim = new Sim({ allowQuit: true });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0];
    sim.do({ type: 'handStarted', tableId: t.id, handNumber: 1 });
    sim.do({ type: 'quit', playerId: 'p2' });
    expect(sim.entry('p2').status).toBe('seated');
    sim.do({ type: 'handResult', result: { tableId: t.id, handNumber: 1, startStacks: {}, endStacks: {} } });
    expect(sim.entry('p2').status).toBe('quit');
    expect(sim.of('eliminated')[0]).toMatchObject({ playerId: 'p2', reason: 'quit', place: 3 });
  });

  it('quitting is refused when the setting is off', () => {
    const sim = new Sim();
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    expect(() => sim.do({ type: 'quit', playerId: 'p0' })).toThrow('not allowed');
  });

  it('registration approval', () => {
    const sim = new Sim({ registrationApproval: true });
    sim.register(1);
    expect(sim.state.entries).toHaveLength(0);
    sim.do({ type: 'approve', by: 'host', requestId: sim.of('requestPending')[0].request.id });
    expect(sim.entry('p0').status).toBe('registered');
  });

  it('ends early by chip count', () => {
    const sim = new Sim();
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.state.entries[0].stack = 2000;
    sim.state.entries[1].stack = 500;
    sim.state.entries[2].stack = 500;
    expect(() => sim.do({ type: 'end', by: 'host' })).toThrow('Pause');
    sim.do({ type: 'pause', by: 'host' });
    sim.do({ type: 'end', by: 'host' });
    expect(sim.state.status).toBe('finished');
    expect(standings(sim.state).map((s) => s.place)).toEqual([1, 2, 2]);
    void t;
  });
});

describe('multi-table', () => {
  it('moves the player due the big blind to the short table', () => {
    const sim = new Sim({ seatsPerTable: 6 });
    sim.register(12);
    sim.do({ type: 'startNow', by: 'host' });
    const [a, b] = sim.state.tables;
    const aPlayers = sim.seatedAt(a.id);
    // B is mid-hand when two busts at A leave 4 v 6: one player moves from B when B's hand ends.
    sim.do({ type: 'handStarted', tableId: b.id, handNumber: 1 });
    sim.hand(a.id, aPlayers[0], [aPlayers[1], aPlayers[2]]);
    expect(sim.of('moveSeat')).toHaveLength(0);
    const bSeats = sim.state.tables[1].seats;
    const occupied = bSeats.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
    const button = occupied[0];
    const expectedSeat = occupied[3]; // next button = occupied[1], big blind = occupied[3]
    const stacks = Object.fromEntries(sim.seatedAt(b.id).map((p) => [p, 1000]));
    sim.do({ type: 'handResult', result: { tableId: b.id, handNumber: 1, startStacks: stacks, endStacks: stacks, button } });
    const mv = sim.of('moveSeat');
    expect(mv).toHaveLength(1);
    expect(mv[0].from).toEqual({ tableId: b.id, seat: expectedSeat });
    expect(mv[0].to.tableId).toBe(a.id);
    expect(sim.seatedAt(a.id)).toHaveLength(5);
    expect(sim.seatedAt(b.id)).toHaveLength(5);
  });

  it('turns hand-for-hand on at the bubble and ties busts across tables', () => {
    const sim = new Sim({
      seatsPerTable: 3,
      payouts: { structure: payoutPreset('standard', 600), money: { buyIn: 100 } },
    });
    sim.register(10); // standard pays 3 of 10
    sim.do({ type: 'startNow', by: 'host' });
    const alive = () => sim.state.entries.filter((e) => e.status === 'seated').length;
    while (alive() > 4) {
      const t = sim.state.tables.find((x) => tableGate(sim.state, x.id, sim.now) === 'deal')!.id;
      sim.hand(t, sim.seatedAt(t)[0], [sim.seatedAt(t)[1]]);
    }
    expect(sim.state.handForHand.active).toBe(true);
    expect(sim.of('handForHand')).toHaveLength(1);
    expect(sim.state.tables).toHaveLength(2);
    const [x, y] = sim.state.tables.map((t) => t.id);
    // Both tables deal the bubble hand; a player busts at each. They tie.
    const result = (t: string) => {
      const [w, l] = sim.seatedAt(t);
      const start = { [w]: sim.entry(w).stack, [l]: sim.entry(l).stack };
      sim.do({ type: 'handResult', result: { tableId: t, handNumber: 99, startStacks: start, endStacks: { [w]: start[w] + start[l], [l]: 0 } } });
    };
    expect(tableGate(sim.state, x, sim.now)).toBe('deal');
    sim.do({ type: 'handStarted', tableId: x, handNumber: 99 });
    // x has dealt this round; it may not deal again until y has too.
    expect(tableGate(sim.state, x, sim.now)).toBe('hold');
    sim.do({ type: 'handStarted', tableId: y, handNumber: 99 });
    result(x);
    result(y);
    expect(standings(sim.state).filter((s) => s.place === 3)).toHaveLength(2);
    expect(sim.state.handForHand.active).toBe(false);
    expect(sim.state.tables).toHaveLength(1);
  });

  it('simulates a 45-player event to the end with valid seating throughout', () => {
    const sim = new Sim({
      seatsPerTable: 9,
      structure: [
        { kind: 'level', sb: 25, bb: 50, ante: 0, anteType: 'none', minutes: 10, rebuy: true },
        { kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 10 },
        { kind: 'break', minutes: 5 },
        { kind: 'level', sb: 100, bb: 200, ante: 200, anteType: 'big-blind', minutes: 10 },
      ],
      rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 10 },
      lateRegistration: { enabled: true, throughLevel: 2 },
      payouts: { structure: payoutPreset('standard', 600), money: { buyIn: 2000, rebuy: 2000 } },
    });
    sim.register(40);
    sim.do({ type: 'startNow', by: 'host' });
    expect(sim.state.tables.map((t) => t.seats.filter(Boolean).length)).toEqual([8, 8, 8, 8, 8]);
    let rng = 7;
    const rand = () => {
      let r: number;
      [r, rng] = nextRandom(rng);
      return r;
    };
    let late = 40;
    for (let step = 0; step < 5000 && sim.state.status === 'running'; step++) {
      sim.at(sim.now + 20_000);
      if (late < 45 && rand() < 0.05 && sim.state.clock.rowIndex < 2) sim.register(1, late++);
      for (const e of sim.state.entries.filter((x) => x.status === 'rebuy-offer')) if (rand() < 0.5) sim.do({ type: 'rebuy', playerId: e.playerId });
      for (const t of [...sim.state.tables]) {
        if (!sim.state.tables.includes(t) && !sim.state.tables.some((x) => x.id === t.id)) continue;
        if (tableGate(sim.state, t.id, sim.now) !== 'deal') continue;
        const live = sim.state.tables.find((x) => x.id === t.id)!;
        const players = live.seats.filter((x): x is string => !!x).map((id) => sim.state.entries.find((e) => e.id === id)!);
        const winner = players[Math.floor(rand() * players.length)];
        const losers = players.filter((p) => p !== winner && rand() < 0.15).map((p) => p.playerId);
        sim.hand(t.id, winner.playerId, losers, live.seats.findIndex(Boolean));
      }
      // Invariants
      const seated = sim.state.entries.filter((e) => e.status === 'seated' || e.status === 'rebuy-offer');
      for (const e of seated) expect(sim.state.tables.find((t) => t.id === e.tableId)!.seats[e.seat!]).toBe(e.id);
      const occupied = sim.state.tables.flatMap((t) => t.seats.filter(Boolean));
      expect(new Set(occupied).size).toBe(occupied.length);
      expect(occupied.length).toBe(seated.length);
      const chips = seated.reduce((a, e) => a + e.stack, 0);
      const added = sim.state.entries.reduce((a, e) => a + 1000 + e.rebuys * 1000, 0);
      expect(chips).toBe(added);
      const idle = sim.state.tables.every((t) => !t.inHand);
      if (idle && sim.state.status === 'running' && !seated.some((e) => e.status === 'rebuy-offer')) {
        const counts = sim.state.tables.map((t) => t.seats.filter(Boolean).length);
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
        expect(sim.state.tables.length).toBe(Math.max(1, Math.ceil(seated.length / 9)));
      }
    }
    expect(sim.state.status).toBe('finished');
    const st = standings(sim.state);
    expect(st).toHaveLength(late);
    expect(st[0].place).toBe(1);
    expect(st.every((s) => s.place !== null && s.place >= 1 && s.place <= late)).toBe(true);
    const pool = (late + st.reduce((a, s) => a + s.rebuys, 0)) * 2000;
    expect(st.reduce((a, s) => a + s.prize, 0)).toBe(pool);
    expect(sim.of('tableBroken').length).toBe(sim.state.counters.table - 1);
  });
});

describe('summaries', () => {
  it('reports the live clock, field stats and player options', async () => {
    const { summarize, playerOptions } = await import('../src');
    const sim = new Sim({
      start: { kind: 'scheduled', startAt: START },
      rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 15 },
      payouts: { structure: payoutPreset('standard', 600), money: { buyIn: 500, rebuy: 500 } },
    });
    sim.register(3);
    expect(summarize(sim.state, T0)).toMatchObject({ status: 'registering', msToStart: 60 * MIN, playersLeft: 3, registrationOpen: true, clock: null });
    expect(playerOptions(sim.state, 'p9').canRegister).toBe(true);
    expect(playerOptions(sim.state, 'p0')).toMatchObject({ canRegister: false, canUnregister: true });
    sim.at(START);
    sim.hand(sim.state.tables[0].id, 'p0', ['p1']);
    sim.now = START + 4 * MIN;
    const sum = summarize(sim.state, sim.now);
    expect(sum.clock).toMatchObject({ levelNumber: 1, msLeft: 6 * MIN, msToBreak: 16 * MIN, running: true });
    expect(sum).toMatchObject({ playersLeft: 3, averageStack: 1000, chipLeader: { playerId: 'p0', stack: 2000 }, prizePool: 1500, rebuysOpen: true });
    expect(playerOptions(sim.state, 'p1')).toMatchObject({ canRebuy: true, canDeclineRebuy: true, canQuit: false });
  });
});

describe('rebuys the host approves', () => {
  it('a rebuy asked for inside the offer window waits for the host, who can approve it after the window', () => {
    const sim = new Sim({ rebuy: { max: 2, chips: 1000, approval: true, offerSeconds: 15 } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, 'p0', ['p1']);
    expect(sim.entry('p1').status).toBe('rebuy-offer');
    sim.now += 5_000;
    sim.do({ type: 'rebuy', playerId: 'p1' });
    const req = sim.state.requests.find((r) => r.kind === 'rebuy' && r.playerId === 'p1')!;
    // The offer's own time runs out while the host is busy: nothing to wake up for, and p1 is still waiting.
    expect(nextWakeAt(sim.state)).not.toBe(sim.entry('p1').rebuyOfferExpiresAt);
    sim.at(sim.now + 30_000);
    expect(sim.entry('p1').status).toBe('rebuy-offer');
    sim.do({ type: 'approve', by: 'host', requestId: req.id });
    expect(sim.entry('p1')).toMatchObject({ status: 'seated', stack: 1000, rebuys: 1 });
  });

  it('one the host turns down knocks the player out, and an offer nobody takes up still runs out', () => {
    const sim = new Sim({ rebuy: { max: 2, chips: 1000, approval: true, offerSeconds: 15 } });
    sim.register(4);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, 'p0', ['p1', 'p2']);
    sim.do({ type: 'rebuy', playerId: 'p1' });
    sim.at(sim.now + 16_000);
    expect(sim.entry('p2').status).toBe('busted');
    expect(sim.entry('p1').status).toBe('rebuy-offer');
    const req = sim.state.requests.find((r) => r.kind === 'rebuy' && r.playerId === 'p1')!;
    sim.do({ type: 'reject', by: 'host', requestId: req.id });
    expect(sim.entry('p1').status).toBe('busted');
  });
});

describe('hand-for-hand at two-seat tables', () => {
  it('a table left with one player does not hold up the round, so play goes on', () => {
    // 5 players at heads-up tables; the standard payouts pay 2 places at 5 entries.
    const sim = new Sim({ seatsPerTable: 2, payouts: { structure: payoutPreset('standard', 600), money: { buyIn: 100 } } });
    const players = (tableId: string) =>
      sim.state.tables.find((x) => x.id === tableId)!.seats.filter((x): x is string => !!x).map((id) => sim.state.entries.find((e) => e.id === id)!.playerId);
    sim.register(5);
    sim.do({ type: 'startNow', by: 'host' });
    const a = sim.state.tables.find((t) => players(t.id).length === 2)!;
    sim.hand(a.id, players(a.id)[0], [players(a.id)[1]]);
    const b = sim.state.tables[0];
    sim.hand(b.id, players(b.id)[0], [players(b.id)[1]]);
    // The bubble: 3 left, 2 paid, at tables of 2 and 1.
    expect(sim.state.handForHand.active).toBe(true);
    expect(sim.state.tables.map((t) => players(t.id).length).sort()).toEqual([1, 2]);
    const two = sim.state.tables.find((t) => players(t.id).length === 2)!;
    for (let round = 0; round < 3; round++) {
      expect(tableGate(sim.state, two.id, sim.now)).toBe('deal');
      sim.hand(two.id, players(two.id)[0], []);
    }
    sim.hand(two.id, players(two.id)[0], [players(two.id)[1]]);
    expect(sim.state.handForHand.active).toBe(false);
  });

  it('a table whose busted player is still deciding on a rebuy holds the round up', () => {
    // 4 players at heads-up tables, 3 paid: hand-for-hand from the start.
    const sim = new Sim({
      seatsPerTable: 2,
      rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 300 },
      payouts: { structure: { name: 'custom', ranges: [{ minEntries: 2, maxEntries: 3, percents: [70, 30] }, { minEntries: 4, maxEntries: 600, percents: [50, 30, 20] }] }, money: { buyIn: 100 } },
    });
    const players = (tableId: string) =>
      sim.state.tables.find((x) => x.id === tableId)!.seats.filter((x): x is string => !!x).map((id) => sim.state.entries.find((e) => e.id === id)!.playerId);
    sim.register(4);
    sim.do({ type: 'startNow', by: 'host' });
    expect(sim.state.handForHand.active).toBe(true);
    const [a, b] = sim.state.tables;
    const [winner, loser] = players(a.id);
    sim.hand(a.id, winner, [loser]);
    expect(sim.entry(loser).status).toBe('rebuy-offer');
    // Table B plays the round, and the next one (A played its hand of that round already).
    sim.hand(b.id, players(b.id)[0], []);
    expect(tableGate(sim.state, b.id, sim.now)).toBe('deal');
    sim.hand(b.id, players(b.id)[0], []);
    // Now B waits for A, whose busted player may still rebuy and play this round.
    expect(tableGate(sim.state, b.id, sim.now)).toBe('hold');
    // The offer runs out: the player is out (the bubble bursts) and B plays on.
    sim.at(sim.now + 301_000);
    expect(sim.entry(loser).status).toBe('busted');
    expect(tableGate(sim.state, b.id, sim.now)).toBe('deal');
  });

  it('a busted player who rebuys on the bubble plays the round they are owed', () => {
    const sim = new Sim({
      seatsPerTable: 2,
      rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 300 },
      payouts: { structure: { name: 'custom', ranges: [{ minEntries: 2, maxEntries: 3, percents: [70, 30] }, { minEntries: 4, maxEntries: 600, percents: [50, 30, 20] }] }, money: { buyIn: 100 } },
    });
    const players = (tableId: string) =>
      sim.state.tables.find((x) => x.id === tableId)!.seats.filter((x): x is string => !!x).map((id) => sim.state.entries.find((e) => e.id === id)!.playerId);
    sim.register(4);
    sim.do({ type: 'startNow', by: 'host' });
    const [a, b] = sim.state.tables;
    const [winner, loser] = players(a.id);
    sim.hand(a.id, winner, [loser]);
    sim.hand(b.id, players(b.id)[0], []);
    sim.hand(b.id, players(b.id)[0], []);
    sim.do({ type: 'rebuy', playerId: loser });
    expect(sim.entry(loser).status).toBe('seated');
    expect([tableGate(sim.state, a.id, sim.now), tableGate(sim.state, b.id, sim.now)]).toEqual(['deal', 'hold']);
  });
});
