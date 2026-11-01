import { describe, expect, it } from 'vitest';
import {
  aliveEntries,
  apply,
  createTournament,
  defaultSettings,
  DirectorError,
  formatterCacheSize,
  MAX_CHIPS,
  MAX_CHIPS_IN_PLAY,
  nextWakeAt,
  payoutPreset,
  presetStructure,
  tick,
  toLocal,
  validateStructure,
  type Command,
  type StructureRow,
  type TournamentSettings,
  type TournamentState,
} from '../src';

const MIN = 60_000;
const T0 = Date.parse('2026-10-30T00:00:00Z');

const levels: StructureRow[] = [
  { kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 10, rebuy: true },
  { kind: 'break', minutes: 5, addOn: true },
  { kind: 'level', sb: 100, bb: 200, ante: 0, anteType: 'none', minutes: 10 },
];

/** Settings as a raw client could send them: any field may be missing or the wrong type. */
const settings = (overrides: Record<string, unknown> = {}) =>
  ({ ...defaultSettings({ structure: levels, startingStack: 1000 }), ...overrides }) as TournamentSettings;

const create = (overrides: Record<string, unknown> = {}) => createTournament({ id: 'T', hostId: 'host', settings: settings(overrides), now: T0, seed: 1 });

const update = (state: TournamentState, changes: Record<string, unknown>) =>
  apply(state, { type: 'updateSettings', by: 'host', settings: changes as Partial<TournamentSettings> }, T0).state;

const act = (state: TournamentState, cmd: Command) => apply(state, cmd, T0);
const entryOf = (state: TournamentState, playerId: string) => state.entries.find((e) => e.playerId === playerId)!;

/** Three players at one table, started at T0. */
function running(overrides: Record<string, unknown> = {}) {
  let state = create(overrides);
  for (const p of ['p0', 'p1', 'p2']) state = act(state, { type: 'register', playerId: p, displayName: p }).state;
  return act(state, { type: 'startNow', by: 'host' }).state;
}

/** Plays one hand in which `loser` loses their whole stack to `winner`. */
function bust(state: TournamentState, loser: string, winner: string) {
  const t = state.tables[0];
  const start = Object.fromEntries(state.entries.map((e) => [e.playerId, e.stack]));
  const end = { ...start, [winner]: start[winner] + start[loser], [loser]: 0 };
  const handNumber = t.lastHandNumber + 1;
  state = act(state, { type: 'handStarted', tableId: t.id, handNumber }).state;
  return act(state, { type: 'handResult', result: { tableId: t.id, handNumber, startStacks: start, endStacks: end, knockedOutBy: { [loser]: [winner] } } }).state;
}

/** The director's refusal, or null when it accepted. Anything other than a DirectorError fails the test. */
function refusal(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(DirectorError);
    return (e as Error).message;
  }
}

/** What Postgres jsonb refuses: NUL and lone surrogates, which JSON.stringify writes as escapes. */
const storable = (value: unknown) => !/\\u0000|\\ud[89a-f][0-9a-f]{2}/i.test(JSON.stringify(value));

const scheduled = (extra: Record<string, unknown> = {}) => ({ kind: 'scheduled', startAt: T0 + 60 * MIN, ...extra });
const daily = { timeZone: 'America/New_York', startDate: '2026-10-29', time: '21:00', repeat: { freq: 'daily' } };

describe('numeric settings', () => {
  it.each([
    ['seatLeadSeconds', 'soon'],
    ['seatLeadSeconds', undefined],
    ['seatLeadSeconds', Number.NaN],
    ['seatLeadSeconds', 1.5],
    ['graceMinutes', 'x'],
    ['graceMinutes', undefined],
    ['graceMinutes', -1],
    ['seatsPerTable', '9'],
    ['maxEntrants', undefined],
    ['startingStack', MAX_CHIPS + 1],
    ['startingStack', 1e300],
    ['startingStack', 0.5],
  ])('refuses %s = %s', (key, value) => {
    expect(refusal(() => create({ start: scheduled(), [key]: value }))).not.toBeNull();
  });

  it('refuses a Sit & Go start delay that is not a whole number of seconds', () => {
    for (const startDelaySeconds of ['x', undefined, 2.5, -1])
      expect(refusal(() => create({ start: { kind: 'sng', playersNeeded: 2, startDelaySeconds, autoSpawn: false } }))).toMatch('Start delay');
  });

  it('refuses a start time a Date cannot hold, even through updateSettings', () => {
    expect(refusal(() => create({ start: scheduled({ startAt: 1e300 }) }))).toMatch('Pick a start time');
    const state = create({ start: scheduled({ schedule: daily }) });
    expect(refusal(() => update(state, { start: scheduled({ startAt: -1e300, schedule: daily }) }))).toMatch('Pick a start time');
  });

  it('refuses a start time after the year 9999, which cannot be shown or stored', () => {
    const last = Date.parse('9999-12-31T23:59:59.999Z');
    expect(refusal(() => create({ start: scheduled({ startAt: last + 1 }) }))).toMatch('Pick a start time');
    expect(refusal(() => create({ start: scheduled({ startAt: last }) }))).toBeNull();
  });

  it('accepts the largest stack and refuses more chips than that per entry', () => {
    const big = presetStructure('regular', { startingStack: MAX_CHIPS });
    expect(validateStructure(big).errors).toEqual([]);
    expect(big.at(-1)!.kind).toBe('level');
    expect(refusal(() => create({ startingStack: MAX_CHIPS, structure: big }))).toBeNull();
    const rebuys = big.map((r, i) => (i === 0 ? { ...r, rebuy: true } : r));
    expect(refusal(() => create({ startingStack: MAX_CHIPS, structure: rebuys, rebuy: { max: 1, chips: 1, approval: false, offerSeconds: 15 } }))).toMatch(
      'every rebuy and add-on',
    );
  });
});

describe('rebuy and add-on chips', () => {
  const rebuy = (chips: unknown, max: unknown = 3) => ({ rebuy: { max, chips, approval: false, offerSeconds: 15 } });
  const addOn = (chips: unknown, max: unknown = 1) => ({ addOn: { max, chips, approval: false } });

  it.each([0.5, 1e300, MAX_CHIPS + 1, 0, -100, '100', undefined])('refuses %s rebuy or add-on chips', (chips) => {
    expect(refusal(() => create(rebuy(chips)))).toMatch('Rebuy chips');
    expect(refusal(() => create(addOn(chips)))).toMatch('Add-on chips');
  });

  it('refuses counts that are not whole numbers', () => {
    for (const max of [1.5, -1, '2']) {
      expect(refusal(() => create(rebuy(100, max)))).not.toBeNull();
      expect(refusal(() => create(addOn(100, max)))).not.toBeNull();
    }
  });

  it('checks the chip amount even while rebuys and add-ons are off', () => {
    expect(refusal(() => create(rebuy(0.5, 0)))).toMatch('Rebuy chips');
    expect(refusal(() => create(addOn(1e300, 0)))).toMatch('Add-on chips');
    expect(refusal(() => create({ ...rebuy(1000, 0), ...addOn(1000, 0) }))).toBeNull();
  });

  // Turning rebuys or add-ons off leaves an open offer or a pending request that still pays out.
  it('keeps chip amounts whole when the host turns rebuys off with an offer open', () => {
    let state = running(rebuy(1000, 2));
    state = bust(state, 'p1', 'p0');
    expect(entryOf(state, 'p1').status).toBe('rebuy-offer');
    expect(refusal(() => update(state, rebuy(0.5, 0)))).toMatch('Rebuy chips');
    state = update(state, rebuy(500, 0));
    state = act(state, { type: 'rebuy', playerId: 'p1' }).state;
    expect(entryOf(state, 'p1').stack).toBe(500);
  });

  it('keeps chip amounts whole when the host turns add-ons off with a request pending', () => {
    let state = running({ addOn: { max: 1, chips: 1000, approval: true } });
    state = tick(state, T0 + 10 * MIN).state;
    const asked = act(state, { type: 'addOn', playerId: 'p1' });
    expect(asked.events.map((e) => e.type)).toContain('requestPending');
    state = asked.state;
    expect(refusal(() => update(state, addOn(1e300, 0)))).toMatch('Add-on chips');
    state = update(state, addOn(250, 0));
    state = act(state, { type: 'approve', by: 'host', requestId: state.requests[0].id }).state;
    expect(entryOf(state, 'p1').stack).toBe(1250);
  });

  it('refuses fractional chips through updateSettings too', () => {
    const state = create(rebuy(100));
    expect(refusal(() => update(state, rebuy(0.5)))).toMatch('Rebuy chips');
    expect(refusal(() => update(state, addOn(1e300)))).toMatch('Add-on chips');
  });
});

describe('late registration, re-entry, rotation and switches', () => {
  it('refuses missing late registration or re-entry settings', () => {
    expect(refusal(() => create({ lateRegistration: undefined }))).toMatch('lateRegistration');
    expect(refusal(() => create({ reEntry: undefined }))).toMatch('reEntry');
    expect(refusal(() => update(create(), { lateRegistration: null }))).toMatch('lateRegistration');
  });

  it.each([
    { lateRegistration: { enabled: 'yes', throughLevel: 2 } },
    { lateRegistration: { enabled: true, throughLevel: 0 } },
    { lateRegistration: { enabled: true, throughLevel: 1.5 } },
    { lateRegistration: { enabled: true, throughLevel: '3' } },
    { reEntry: { enabled: true, throughLevel: null, max: 0, approval: false } },
    { reEntry: { enabled: true, throughLevel: null, max: 2.5, approval: false } },
    { reEntry: { enabled: true, throughLevel: -1, max: null, approval: false } },
    { reEntry: { enabled: true, throughLevel: null, max: null, approval: 'no' } },
    { allowQuit: 'yes' },
    { registrationApproval: 1 },
  ])('refuses %o', (overrides) => {
    expect(refusal(() => create(overrides))).not.toBeNull();
  });

  it('accepts open-ended windows', () => {
    expect(refusal(() => create({ lateRegistration: { enabled: true, throughLevel: null } }))).toBeNull();
    expect(refusal(() => create({ reEntry: { enabled: true, throughLevel: 3, max: null, approval: true } }))).toBeNull();
  });

  it('accepts stopRotationAtLevel only when unset, null or a level number', () => {
    for (const ok of [undefined, null, 2]) expect(refusal(() => create({ games: ['nlhe', 'plo'], stopRotationAtLevel: ok }))).toBeNull();
    for (const bad of [0, 1.5, '2', -1]) expect(refusal(() => create({ games: ['nlhe', 'plo'], stopRotationAtLevel: bad }))).toMatch('Rotation');
  });

  it('refuses games that are not ids', () => {
    for (const games of [[''], ['nlhe', 5], 'nlhe', undefined]) expect(refusal(() => create({ games }))).toMatch('game');
  });
});

describe('schedules', () => {
  it('validates a schedule when one is set', () => {
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, timeZone: 'Mars/Olympus' } }) }))).toMatch('Unknown time zone');
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, startDate: '2026-02-30' } }) }))).toMatch('startDate');
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, repeat: { freq: 'weekly' } } }) }))).toMatch('weekday');
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, repeat: { freq: 'yearly' } } }) }))).toMatch('Repeat');
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, repeat: { freq: 'monthly', nth: 2, weekday: 9 } } }) }))).toMatch('Weekdays');
    expect(refusal(() => create({ start: scheduled({ schedule: daily }) }))).toBeNull();
  });

  // Intl accepts any capitalisation of a zone, so each spelling is a new cache key.
  const spellings = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      let bit = 0;
      return 'america/argentina/comodrivadavia'.replace(/[a-z]/g, (ch) => ((i >> bit++) & 1 ? ch.toUpperCase() : ch));
    });

  it('validating a time zone does not cache a formatter for it', () => {
    const state = create({ start: scheduled({ schedule: daily }) });
    const before = formatterCacheSize();
    for (const timeZone of spellings(200)) {
      update(state, { start: scheduled({ schedule: { ...daily, timeZone } }) });
      expect(refusal(() => create({ name: 42, start: scheduled({ schedule: { ...daily, timeZone } }) }))).toMatch('Name');
    }
    expect(formatterCacheSize()).toBe(before);
  });

  it('keeps the formatter cache bounded', () => {
    for (const timeZone of spellings(1500)) toLocal(T0, timeZone);
    expect(formatterCacheSize()).toBeLessThanOrEqual(1000);
  });

  it('refuses an unknown start kind', () => {
    expect(refusal(() => create({ start: { kind: 'whenever' } }))).toMatch('starts');
  });
});

describe('a new start time during the grace period', () => {
  it('starts the wait over instead of leaving a wake time in the past', () => {
    let state = create({ start: scheduled() });
    state = act(state, { type: 'register', playerId: 'p1', displayName: 'p1' }).state;
    state = tick(state, T0 + 60 * MIN).state;
    expect(state.graceUntil).toBe(T0 + 75 * MIN);
    // The same start time, as the web form resends it with any change, keeps the grace period.
    expect(update(state, { name: 'Renamed', start: scheduled() }).graceUntil).toBe(T0 + 75 * MIN);
    state = update(state, { start: scheduled({ startAt: T0 + 660 * MIN }) });
    state = tick(state, T0 + 76 * MIN).state;
    expect(state.status).toBe('registering');
    expect(nextWakeAt(state)).toBe(T0 + 660 * MIN);
    const delayed = tick(state, T0 + 660 * MIN);
    expect(delayed.events.map((e) => e.type)).toEqual(['startDelayed']);
    expect(nextWakeAt(delayed.state)).toBe(T0 + 675 * MIN);
    expect(tick(delayed.state, T0 + 675 * MIN).state.status).toBe('cancelled');
  });
});

describe('chips in play', () => {
  const reEntry = { enabled: true, throughLevel: null, max: null, approval: false };

  /** The same state with `total` chips in play, as if many re-entries had passed their chips to `holder`. */
  function withChipsInPlay(state: TournamentState, holder: string, total: number) {
    const next = structuredClone(state);
    const others = aliveEntries(next).filter((e) => e.playerId !== holder);
    entryOf(next, holder).stack = total - others.reduce((sum, e) => sum + e.stack, 0);
    return next;
  }

  /** Accepted with exactly room for `chips`, refused with one chip less. */
  function expectLimit(state: TournamentState, cmd: Command, chips: number) {
    expect(refusal(() => act(withChipsInPlay(state, 'p0', MAX_CHIPS_IN_PLAY - chips), cmd))).toBeNull();
    expect(refusal(() => act(withChipsInPlay(state, 'p0', MAX_CHIPS_IN_PLAY - chips + 1), cmd))).toMatch('cannot hold any more chips');
  }

  it('keeps the limit within what the engine can add up', () => {
    expect(MAX_CHIPS_IN_PLAY * 4).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(MAX_CHIPS_IN_PLAY).toBeGreaterThan(600 * MAX_CHIPS);
  });

  it('refuses a re-entry or late registration past the limit', () => {
    const state = bust(running({ reEntry }), 'p1', 'p0');
    expectLimit(state, { type: 'reEnter', playerId: 'p1' }, 1000);
    expectLimit(state, { type: 'register', playerId: 'p3', displayName: 'p3' }, 1000);
  });

  it('refuses to approve a re-entry past the limit', () => {
    let state = bust(running({ reEntry: { ...reEntry, approval: true } }), 'p1', 'p0');
    state = act(state, { type: 'reEnter', playerId: 'p1' }).state;
    expectLimit(state, { type: 'approve', by: 'host', requestId: state.requests[0].id }, 1000);
  });

  it('refuses rebuys and add-ons past the limit', () => {
    const offered = bust(running({ rebuy: { max: 1, chips: 500, approval: false, offerSeconds: 15 } }), 'p1', 'p0');
    expectLimit(offered, { type: 'rebuy', playerId: 'p1' }, 500);
    const onBreak = tick(running({ addOn: { max: 1, chips: 700, approval: false } }), T0 + 10 * MIN).state;
    expectLimit(onBreak, { type: 'addOn', playerId: 'p1' }, 700);
  });
});

describe('free text', () => {
  it('strips NUL, control characters and lone surrogates from the name', () => {
    expect(create({ name: 'Cup\u0000' }).settings.name).toBe('Cup');
    expect(create({ name: ' Friday\u0007\u2028 Cup ' }).settings.name).toBe('Friday Cup');
    expect(create({ name: 'Abcdefghijklmnopqrs\ud83c' }).settings.name).toBe('Abcdefghijklmnopqrs');
    expect(create({ name: 'Club \u{1F0CF}' }).settings.name).toBe('Club \u{1F0CF}');
    expect(storable(create({ name: '\ud800Cup\udfff\u0000' }))).toBe(true);
  });

  it('counts the name in whole characters', () => {
    expect(create({ name: '\u{1F0CF}'.repeat(40) }).settings.name).toBe('\u{1F0CF}'.repeat(40));
    expect(refusal(() => create({ name: '\u{1F0CF}'.repeat(41) }))).toMatch('Name');
    expect(refusal(() => create({ name: '\u0000\u0007 \ud800' }))).toMatch('Name');
    expect(refusal(() => create({ name: 42 }))).toMatch('Name');
  });

  it('cleans the name in updateSettings', () => {
    expect(update(create(), { name: 'Cup\u0000\udc00' }).settings.name).toBe('Cup');
  });

  it('cleans the payout structure name and cuts it by whole characters', () => {
    const structure = { ...payoutPreset('winner-take-all', 600), name: `Top\u0000\ud800${'\u{1F0CF}'.repeat(45)}` };
    const state = create({ payouts: { structure, money: { buyIn: 100 } } });
    expect(state.settings.payouts!.structure.name).toBe(`Top${'\u{1F0CF}'.repeat(37)}`);
    expect(storable(state)).toBe(true);
  });

  it('refuses prize money that standings cannot use', () => {
    const structure = payoutPreset('winner-take-all', 600);
    expect(refusal(() => create({ payouts: { structure } }))).toMatch('Prize money');
    expect(refusal(() => create({ payouts: { structure, money: { buyIn: 'lots' } } }))).toMatch('Prize money');
    expect(refusal(() => create({ payouts: { structure, money: { buyIn: 100, feePercent: 101 } } }))).toMatch('fee');
  });

  it('refuses text that cannot be saved anywhere else in the settings', () => {
    expect(refusal(() => create({ games: ['nlhe\u0000'] }))).toMatch('cannot be saved');
    expect(refusal(() => update(create(), { games: ['\ud800'] }))).toMatch('cannot be saved');
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, timeZone: '\u0000' } }) }))).toMatch('cannot be saved');
  });

  it('drops unsaveable text in fields that are not settings instead of keeping it', () => {
    const created = create({ rebuy: { max: 0, chips: 1000, approval: false, offerSeconds: 15, note: '\u0000' } });
    expect(created.settings.rebuy).toEqual({ max: 0, chips: 1000, approval: false, offerSeconds: 15 });
    const updated = update(created, { addOn: { max: 0, chips: 1000, approval: false, ['\ud800']: 1 } });
    expect(updated.settings.addOn).toEqual({ max: 0, chips: 1000, approval: false });
    expect(storable(updated)).toBe(true);
  });
});

describe('unknown settings', () => {
  it('drops keys that are not tournament settings', () => {
    const created = create({ junk: '\u0000', name: 'Cup' });
    expect(created.settings).not.toHaveProperty('junk');
    const next = update(created, { name: 'New', alsoJunk: '\ud800' });
    expect(next.settings.name).toBe('New');
    expect(next.settings).not.toHaveProperty('alsoJunk');
    expect(storable(next)).toBe(true);
  });
});

describe('unknown nested settings (#273)', () => {
  const junk = { junk: 'x'.repeat(100) };
  const lv = (extra: Record<string, unknown> = {}) => ({ kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 10, ...extra });

  it('drops keys that are not part of a nested setting', () => {
    const preset = payoutPreset('winner-take-all', 600);
    const state = create({
      start: scheduled({ ...junk, schedule: { ...daily, ...junk, repeat: { freq: 'weekly', weekdays: [1], ...junk } } }),
      structure: [lv({ rebuy: true, limit: { smallBet: 100, bigBet: 200, ...junk }, ...junk }), { kind: 'break', minutes: 5, addOn: true, ...junk }, lv()],
      lateRegistration: { enabled: true, throughLevel: 4, ...junk },
      reEntry: { enabled: false, throughLevel: null, max: null, approval: false, ...junk },
      rebuy: { max: 0, chips: 1000, approval: false, offerSeconds: 15, ...junk },
      addOn: { max: 0, chips: 1000, approval: false, ...junk },
      payouts: { ...junk, structure: { ...preset, ...junk, ranges: preset.ranges.map((r) => ({ ...r, ...junk })) }, money: { buyIn: 100, ...junk } },
      bounty: { amount: 500, progressivePercent: 0, ...junk },
      invites: { required: false, autoApprove: true, ...junk },
      checkIn: { groups: [{ firstN: null, waitMinutes: 10, ...junk }], opensMinutesBefore: 60, ...junk },
    });
    expect(JSON.stringify(state.settings)).not.toContain('junk');
    expect(state.settings.start).toEqual({ kind: 'scheduled', startAt: T0 + 60 * MIN, schedule: { ...daily, repeat: { freq: 'weekly', weekdays: [1] } } });
    expect(state.settings.structure[0]).toEqual(lv({ rebuy: true, limit: { smallBet: 100, bigBet: 200 } }));
    expect(state.settings.payouts).toEqual({ structure: preset, money: { buyIn: 100 } });
  });

  it('keeps only the fields of the start rule that was picked', () => {
    expect(create({ start: { kind: 'manual', startAt: 5 } }).settings.start).toEqual({ kind: 'manual' });
    const sng = { kind: 'sng', playersNeeded: 2, startDelaySeconds: 0, autoSpawn: false };
    expect(create({ start: { ...sng, schedule: daily } }).settings.start).toEqual(sng);
    // A monthly rule is told apart by which of its keys are there, so none are added.
    const monthly = { ...daily, repeat: { freq: 'monthly', nth: -1, weekday: 5 } };
    expect(create({ start: scheduled({ schedule: monthly }) }).settings.start).toEqual(scheduled({ schedule: monthly }));
  });

  it('drops them in updateSettings and editStructure too', () => {
    const state = create();
    expect(update(state, { rebuy: { max: 0, chips: 1000, approval: false, offerSeconds: 15, ...junk } }).settings.rebuy).not.toHaveProperty('junk');
    const edited = apply(state, { type: 'editStructure', by: 'host', structure: [lv(junk) as StructureRow] }, T0).state;
    expect(edited.settings.structure).toEqual([lv()]);
  });

  it('still edits an event saved with extra fields before they were dropped', () => {
    let state = running();
    // As saved before this change: extra fields in the rows and the start rule.
    state = { ...state, settings: { ...state.settings, start: { kind: 'manual', ...junk } as TournamentSettings['start'], structure: state.settings.structure.map((r) => ({ ...r, ...junk })) } };
    const rows = state.settings.structure;
    const next = act(state, { type: 'editStructure', by: 'host', structure: [...rows, lv()] as StructureRow[] });
    expect(next.state.settings.structure).toEqual([...levels, lv()]);
    expect(update(state, { start: state.settings.start }).settings.start).toEqual({ kind: 'manual' });
  });

  it('refuses game ids longer than any real one', () => {
    expect(refusal(() => create({ games: ['x'.repeat(41)] }))).toMatch('game id');
    expect(refusal(() => create({ structure: [lv({ gameId: 'x'.repeat(41) })] }))).toMatch('game');
    expect(validateStructure([lv({ gameId: 'x'.repeat(40) }) as StructureRow]).errors).toEqual([]);
  });
});

describe('payout ranges and prize money (#273)', () => {
  const winner = (maxEntries: number) => ({ name: 'custom', ranges: [{ minEntries: 2, maxEntries, percents: [100] }] });

  it('lets ranges run past max entrants, as re-entries can, but not past 10,000 entries', () => {
    expect(refusal(() => create({ maxEntrants: 50, payouts: { structure: winner(600), money: { buyIn: 100 } } }))).toBeNull();
    expect(refusal(() => create({ payouts: { structure: winner(10_000), money: { buyIn: 100 } } }))).toBeNull();
    expect(refusal(() => create({ payouts: { structure: winner(5_000_000), money: { buyIn: 100 } } }))).toMatch('Range 2-5000000: must end by 10,000 entries');
  });

  it('caps each prize amount and the bounty at $100,000, so pools stay exact', () => {
    const structure = payoutPreset('winner-take-all', 600);
    for (const money of [{ buyIn: 10_000_001 }, { buyIn: 0, rebuy: 10_000_001 }, { buyIn: 0, addOn: 10_000_001 }, { buyIn: 0, added: Number.MAX_SAFE_INTEGER }])
      expect(refusal(() => create({ payouts: { structure, money } }))).toMatch('at most $100,000');
    const top = { buyIn: 10_000_000, rebuy: 10_000_000, addOn: 10_000_000, added: 10_000_000 };
    expect(refusal(() => create({ payouts: { structure, money: top } }))).toBeNull();
    expect(refusal(() => create({ bounty: { amount: 10_000_001, progressivePercent: 0 } }))).toMatch('The bounty must be at most $100,000');
    expect(refusal(() => create({ bounty: { amount: 10_000_000, progressivePercent: 0 } }))).toBeNull();
  });
});

describe('structure rows', () => {
  const lv = (extra: Record<string, unknown>) => ({ kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 10, ...extra }) as StructureRow;

  it('needs a non-empty game id when a level names one', () => {
    for (const gameId of ['', 7, null]) expect(validateStructure([lv({ gameId })]).errors).toEqual(['Level 1: game must be a game id']);
    expect(validateStructure([lv({ gameId: 'plo' }), lv({ gameId: undefined })]).errors).toEqual([]);
    const state = create();
    expect(refusal(() => apply(state, { type: 'editStructure', by: 'host', structure: [lv({ gameId: '' })] }, T0))).toMatch('game');
  });

  it('refuses unknown row kinds and ante types', () => {
    expect(validateStructure([lv({}), { kind: 'pause', minutes: 5 } as unknown as StructureRow, lv({})]).errors).toEqual(['Row 2: must be a level or a break']);
    expect(validateStructure([lv({ anteType: 'sometimes', ante: 10 })]).errors).toEqual(['Level 1: unknown ante type']);
  });

  it('caps blinds at the engine chip limit', () => {
    expect(validateStructure([lv({ sb: MAX_CHIPS, bb: MAX_CHIPS + 2 })]).errors).toEqual(['Level 1: blinds and ante must be whole chip amounts']);
    expect(validateStructure([lv({ limit: { smallBet: 10, bigBet: MAX_CHIPS * 2 } })]).errors).toEqual(['Level 1: limit bets must be whole chip amounts above 0']);
  });

  it('reports a malformed structure instead of throwing', () => {
    for (const rows of [undefined, 'levels', [null]]) expect(validateStructure(rows as unknown as StructureRow[]).errors).toEqual(['The structure must be a list of levels and breaks']);
    expect(refusal(() => create({ structure: undefined }))).toMatch('structure');
    expect(validateStructure([lv({ note: '\u0000' })]).errors).toEqual(['The structure contains characters that cannot be saved']);
  });
});
