import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PlanForcedBets } from '../../src/core/api';
import type { BettingKind, HandOptions, Stakes } from '../../src/core/types';
import {
  MAX_CHIPS,
  SETTINGS_LIMITS,
  SETTINGS_VERSION,
  SettingsError,
  TableSettingsSchema,
  defaultSettings,
  migrateSettings,
  parseSettings,
  type TableMode,
  type TableSettings,
} from '../../src/settings';
import { issuesOf, pathsOf, withField } from './helpers';

const cash = () => defaultSettings('cash');
const tournament = () => defaultSettings('tournament');

/** Settings with several fields set at once. */
function withFields(base: TableSettings, fields: Record<string, unknown>): TableSettings {
  return Object.entries(fields).reduce((s, [path, value]) => withField(s, path, value), base);
}

const level = (smallBlind: number, bigBlind: number, ante = 0) => ({ smallBlind, bigBlind, ante, minutes: 15, hands: 20 });

describe('defaults', () => {
  it.each<TableMode>(['cash', 'tournament'])('%s defaults parse unchanged', (mode) => {
    const settings = defaultSettings(mode);
    expect(parseSettings(settings)).toEqual(settings);
    expect(TableSettingsSchema.safeParse(settings).success).toBe(true);
  });

  it('match the owner-requested values', () => {
    const s = cash();
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.table).toMatchObject({ maxSeats: 10, mode: 'cash' });
    expect(s.game).toEqual({ gameId: 'nlhe', betting: 'no-limit', rotation: { enabled: false, steps: [] }, dealersChoice: { enabled: false, games: [], hands: 0, pickSeconds: 20 } });
    expect(s.timing).toEqual({
      decisionSeconds: 30,
      timeBankSeconds: 30,
      timeBankRefillHands: 10,
      autoActivateTimeBank: true,
      autoStartNextHand: true,
      showdownSeconds: 6,
      nextHandDelaySeconds: 3,
    });
    expect(s.seating).toMatchObject({
      requireApproval: true,
      allowRebuys: true,
      rebuyRequiresApproval: true,
      minBuyIn: 0,
      maxBuyIn: 0,
      ratholeMinutes: 0,
      waitlist: false,
      randomSeats: false,
      allowPlayerBots: true,
      dealToAway: false,
      awayAfterTimeouts: 2,
      offlineGraceSeconds: 15,
      releaseOfflineSeatMinutes: 0,
    });
    expect(s.play).toEqual({
      runItTwice: 'ask',
      rabbitHunt: true,
      straddle: 'utg',
      revealAllAtShowdown: false,
      trimExcessBets: false,
      fixedLimitCap: 4,
      uncappedHeadsUp: true,
    });
    expect(s.chat).toEqual({ guestChat: true, profanityFilter: false });
    expect(s.spectators).toEqual({ allowed: true, seeAllCards: false, delaySeconds: 0 });
    expect(s.blindSchedule.enabled).toBe(false);
    expect(s.modifiers).toEqual({});
  });

  it('fixed-limit sizes default to the big blind and twice the big blind', () => {
    const { stakes } = cash();
    expect(stakes.smallBet).toBe(stakes.bigBlind);
    expect(stakes.bigBet).toBe(2 * stakes.bigBlind);
  });

  it('differ by mode only where the mode needs it', () => {
    const c = cash();
    const t = tournament();
    expect(t.table.mode).toBe('tournament');
    expect(t.play.runItTwice).toBe('off');
    expect(t.seating.dealToAway).toBe(true);
    expect(c.seating.dealToAway).toBe(false);
    expect({ ...t.stakes }).toEqual(c.stakes);
  });

  it('are a fresh copy every time', () => {
    const a = cash();
    a.game.rotation.steps.push({ gameId: 'plo', betting: 'pot-limit', length: 1, unit: 'orbits' });
    a.stakes.bigBlind = 50;
    expect(cash().game.rotation.steps).toEqual([]);
    expect(cash().stakes.bigBlind).toBe(2);
  });

  it('reject an unknown mode', () => {
    expect(() => defaultSettings('ring' as TableMode)).toThrow(/unknown table mode/);
  });
});

describe('field ranges', () => {
  // [path, values that must be rejected, boundary values that must pass]
  const cases: [string, unknown[], unknown[]][] = [
    ['table.name', ['', '   ', 'x'.repeat(41), 'tab\tname', 'line\nbreak', 5, null, 'half \ud83d', '\udc00'], ['x', 'x'.repeat(40), 'Friday 🃏']],
    ['table.maxSeats', [1, 11, 0, -2, 2.5, '10', null], [2, 10]],
    ['table.mode', ['ring', '', 1], ['cash']],
    ['table.felt', ['plaid', '', 1, null], ['green', 'teal']],
    ['game.gameId', ['', 'has space', 'x'.repeat(41), 'dot.id', 7], ['plo5', 'stud_hilo', 'Razz', 'x'.repeat(40)]],
    ['game.betting', ['spread-limit', 'NL', null], ['pot-limit', 'no-limit']],
    ['game.rotation.enabled', ['yes', 1], [false]],
    ['game.rotation.steps', ['plo', {}], [[]]],
    ['game.dealersChoice.enabled', ['yes', 1], [false]],
    ['game.dealersChoice.games', ['plo', {}], [[]]],
    ['game.dealersChoice.hands', [-1, 101, 1.5], [0, 100]],
    ['game.dealersChoice.pickSeconds', [9, 61, 20.5, 0], [10, 60]],
    ['stakes.smallBlind', [-1, 1.5, MAX_CHIPS + 1, '1', Number.NaN], [0, 2]],
    ['stakes.bigBlind', [-1, 2.5, MAX_CHIPS + 1, Infinity], [2, MAX_CHIPS]],
    ['stakes.ante', [-1, 0.5, MAX_CHIPS + 1], [0]],
    ['stakes.anteType', ['ante', 'bb', ''], ['none']],
    ['stakes.bringIn', [-1, 1.5, MAX_CHIPS + 1], [0, MAX_CHIPS]],
    ['stakes.smallBet', [-1, 1.5, MAX_CHIPS + 1], [0, MAX_CHIPS]],
    ['stakes.bigBet', [-1, 1.5, MAX_CHIPS + 1], [0, MAX_CHIPS]],
    ['stakes.centsMode', ['yes', 1, null], [true]],
    ['blindSchedule.enabled', ['true'], [false]],
    ['blindSchedule.countdown', ['minutes', ''], ['hands', 'per-level-timer']],
    ['blindSchedule.levels', [null, 'fast'], [[]]],
    ['timing.decisionSeconds', [-1, 1, 4, 601, 30.5, '30'], [0, 5, 600]],
    ['timing.timeBankSeconds', [-1, 301, 1.5], [0, 300]],
    ['timing.timeBankRefillHands', [-1, 201, 1.5], [0, 200]],
    ['timing.autoActivateTimeBank', [null, 'true'], [false]],
    ['timing.autoStartNextHand', ['no', 0], [false]],
    ['timing.showdownSeconds', [0, 5, 7, 12, '6', 6.5], [3, 6, 9]],
    ['timing.nextHandDelaySeconds', [-1, 31, 2.5], [0, 30]],
    ['seating.requireApproval', ['no'], [false]],
    ['seating.allowRebuys', [1], [false]],
    ['seating.rebuyRequiresApproval', [null], [false]],
    ['seating.minBuyIn', [-1, 0.5, MAX_CHIPS + 1], [0, MAX_CHIPS]],
    ['seating.maxBuyIn', [-1, 0.5, MAX_CHIPS + 1], [0, MAX_CHIPS]],
    ['seating.ratholeMinutes', [-1, 1441, 1.5], [0, 1440]],
    ['seating.waitlist', ['on'], [true]],
    ['seating.randomSeats', ['yes', null], [true, false]],
    ['seating.allowPlayerBots', ['yes', null], [true, false]],
    ['seating.dealToAway', [0], [true]],
    ['seating.awayAfterTimeouts', [-1, 11, 1.5], [0, 10]],
    ['seating.offlineGraceSeconds', [-1, 301, 0.5], [0, 300]],
    ['seating.releaseOfflineSeatMinutes', [-1, 1441, 0.5], [0, 1440]],
    ['play.runItTwice', ['sometimes', true], ['off', 'always']],
    ['play.rabbitHunt', ['yes'], [false]],
    ['play.straddle', ['button', 'mississippi'], ['off', 'utg-and-button']],
    ['play.revealAllAtShowdown', [1], [true]],
    ['play.trimExcessBets', ['false'], [true]],
    ['play.fixedLimitCap', [1, 11, 3.5, 0], [2, 10]],
    ['play.uncappedHeadsUp', [null], [false]],
    ['chat.guestChat', ['yes'], [false]],
    ['chat.profanityFilter', [1], [true]],
    ['spectators.allowed', ['no'], [false]],
    ['spectators.seeAllCards', [0], [true]],
    ['spectators.delaySeconds', [-1, 601, 1.5], [0, 600]],
  ];

  for (const [path, bad, good] of cases) {
    it(`${path} rejects out-of-range values and accepts its boundaries`, () => {
      for (const value of bad) {
        const issues = issuesOf(() => parseSettings(withField(cash(), path, value)));
        expect(issues.map((i) => i.path), `${path} = ${JSON.stringify(value)}`).toEqual([path]);
      }
      for (const value of good) {
        expect(() => parseSettings(withField(cash(), path, value)), `${path} = ${JSON.stringify(value)}`).not.toThrow();
      }
    });
  }

  it('covers every field of every section', () => {
    const covered = new Set(cases.map(([path]) => path));
    const s = cash();
    const leaves = Object.entries(s)
      .filter(([section]) => section !== 'version' && section !== 'modifiers')
      .flatMap(([section, fields]) => Object.keys(fields as object).map((f) => `${section}.${f}`));
    const missing = leaves.filter((p) => !covered.has(p) && p !== 'game.rotation' && p !== 'game.dealersChoice');
    expect(missing).toEqual([]);
  });

  it('rejects out-of-range blind levels', () => {
    const base = withFields(cash(), { 'blindSchedule.enabled': true, 'blindSchedule.levels': [level(1, 2)] });
    const bad: [string, unknown][] = [
      ['minutes', 1],
      ['minutes', 241],
      ['minutes', 10.5],
      ['hands', 0],
      ['hands', 1001],
      ['smallBlind', -1],
      ['bigBlind', 2.5],
      ['ante', -5],
    ];
    for (const [field, value] of bad) {
      const path = `blindSchedule.levels[0].${field}`;
      expect(pathsOf(() => parseSettings(withField(base, path, value))), `${field} = ${value}`).toContain(path);
    }
    for (const [field, value] of [['minutes', 2], ['minutes', 240], ['hands', 1], ['hands', 1000]] as const) {
      expect(() => parseSettings(withField(base, `blindSchedule.levels[0].${field}`, value))).not.toThrow();
    }
  });

  it('allows up to 100 blind levels', () => {
    const levels = Array.from({ length: 100 }, (_, i) => level(i + 1, 2 * (i + 1)));
    expect(() => parseSettings(withFields(cash(), { 'blindSchedule.enabled': true, 'blindSchedule.levels': levels }))).not.toThrow();
    expect(pathsOf(() => parseSettings(withField(cash(), 'blindSchedule.levels', [...levels, level(1, 2)])))).toEqual([
      'blindSchedule.levels',
    ]);
  });

  it('rejects out-of-range rotation steps', () => {
    const step = { gameId: 'plo', betting: 'pot-limit', length: 2, unit: 'orbits' };
    const base = withFields(cash(), { 'game.rotation.enabled': true, 'game.rotation.steps': [step] });
    expect(() => parseSettings(base)).not.toThrow();
    for (const [field, value] of [
      ['length', 0],
      ['length', 1001],
      ['length', 1.5],
      ['unit', 'minutes'],
      ['betting', 'spread'],
      ['gameId', ''],
    ] as const) {
      const path = `game.rotation.steps[0].${field}`;
      expect(pathsOf(() => parseSettings(withField(base, path, value)))).toEqual([path]);
    }
    const steps = Array.from({ length: 21 }, () => step);
    expect(pathsOf(() => parseSettings(withField(base, 'game.rotation.steps', steps)))).toEqual(['game.rotation.steps']);
    expect(() => parseSettings(withField(base, 'game.rotation.steps', steps.slice(1)))).not.toThrow();
  });

  it('exports the limits it enforces', () => {
    expect(SETTINGS_LIMITS.maxSeats).toEqual({ min: 2, max: 10 });
    expect(SETTINGS_LIMITS.levelMinutes).toEqual({ min: 2, max: 240 });
    expect(SETTINGS_LIMITS.blindLevels.max).toBe(100);
  });
});

describe('shape', () => {
  it('trims the table name', () => {
    expect(parseSettings(withField(cash(), 'table.name', '  Friday game  ')).table.name).toBe('Friday game');
  });

  it('reports each unknown key at its own path', () => {
    const input = withFields(cash(), { colour: 'green', 'stakes.straddle': 4, 'chat.emoji': true });
    const issues = issuesOf(() => parseSettings(input));
    expect(issues).toEqual([
      { path: 'stakes.straddle', message: 'unknown field' },
      { path: 'chat.emoji', message: 'unknown field' },
      { path: 'colour', message: 'unknown field' },
    ]);
  });

  it('reports missing fields', () => {
    expect(issuesOf(() => parseSettings(withField(cash(), 'timing.showdownSeconds', undefined)))).toEqual([
      { path: 'timing.showdownSeconds', message: 'required' },
    ]);
    expect(issuesOf(() => parseSettings(withField(cash(), 'chat', undefined)))).toEqual([{ path: 'chat', message: 'required' }]);
    expect(issuesOf(() => parseSettings(withField(cash(), 'timing.showdownSeconds', 5)))).toEqual([
      { path: 'timing.showdownSeconds', message: 'must be 3, 6 or 9' },
    ]);
  });

  it('rejects other versions', () => {
    for (const version of [0, 2, '1', undefined]) {
      expect(pathsOf(() => parseSettings(withField(cash(), 'version', version)))).toEqual(['version']);
    }
  });

  it('rejects a non-object', () => {
    for (const input of [null, undefined, 'settings', 42, []]) {
      expect(pathsOf(() => parseSettings(input))).toEqual(['(root)']);
    }
  });

  it('lists every bad field in one error, one entry per path', () => {
    const input = withFields(cash(), {
      'table.maxSeats': 12,
      'stakes.ante': -1.5,
      'timing.decisionSeconds': 3,
      'spectators.delaySeconds': 9000,
    });
    let error: unknown;
    try {
      parseSettings(input);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SettingsError);
    const { issues, message } = error as SettingsError;
    expect(issues.map((i) => i.path)).toEqual(['table.maxSeats', 'stakes.ante', 'timing.decisionSeconds', 'spectators.delaySeconds']);
    expect(issues.find((i) => i.path === 'stakes.ante')!.message).toBe('must be a whole number; must be at least 0');
    expect(issues.find((i) => i.path === 'table.maxSeats')!.message).toBe('must be at most 10');
    expect(issues.find((i) => i.path === 'timing.decisionSeconds')!.message).toBe('must be 0 (no clock) or 5-600');
    expect(message).toContain('Invalid table settings:');
    expect(message).toContain('- table.maxSeats: ');
    expect(message).toContain('- spectators.delaySeconds: ');
  });

  it('uses plain messages', () => {
    const message = (path: string, value: unknown) => issuesOf(() => parseSettings(withField(cash(), path, value)))[0].message;
    expect(message('table.mode', 'ring')).toBe("must be one of 'cash', 'tournament'");
    expect(message('chat.guestChat', 'yes')).toBe('must be true or false, not string');
    expect(message('table.maxSeats', '6')).toBe('must be a number, not string');
    expect(message('table.maxSeats', 1)).toBe('must be at least 2');
    expect(message('table.maxSeats', 6.5)).toBe('must be a whole number');
    expect(message('table.name', 'x'.repeat(41))).toBe('must be at most 40 characters');
    expect(message('table.name', ' ')).toBe('must not be blank');
    expect(message('stakes', [])).toBe('must be an object, not array');
    expect(message('blindSchedule.levels', Array(101).fill(level(1, 2)))).toBe('must have at most 100 items');
    expect(message('version', 0)).toBe('must be 1 (use migrateSettings for older settings)');
  });

  it('returns a copy and leaves the input alone', () => {
    const input = cash();
    const before = structuredClone(input);
    const out = parseSettings(input);
    expect(out).not.toBe(input);
    out.stakes.bigBlind = 99;
    expect(input).toEqual(before);
  });
});

describe('cross-field rules', () => {
  it('small blind may not exceed the big blind', () => {
    expect(issuesOf(() => parseSettings(withFields(cash(), { 'stakes.smallBlind': 3, 'stakes.bigBlind': 2 })))).toEqual([
      { path: 'stakes.smallBlind', message: 'must not exceed the big blind (2)' },
    ]);
    expect(() => parseSettings(withFields(cash(), { 'stakes.smallBlind': 2, 'stakes.bigBlind': 2 }))).not.toThrow();
  });

  it('no-limit and pot-limit need a big blind of at least 1', () => {
    for (const betting of ['no-limit', 'pot-limit']) {
      const s = withFields(cash(), { 'game.betting': betting, 'stakes.smallBlind': 0, 'stakes.bigBlind': 0 });
      expect(pathsOf(() => parseSettings(s))).toEqual(['stakes.bigBlind']);
    }
    expect(() => parseSettings(withFields(cash(), { 'stakes.smallBlind': 0, 'stakes.bigBlind': 1 }))).not.toThrow();
  });

  it('allows ante-only fixed-limit games with no blinds (stud)', () => {
    const stud = withFields(cash(), {
      'game.gameId': 'stud',
      'game.betting': 'fixed-limit',
      'stakes.smallBlind': 0,
      'stakes.bigBlind': 0,
      'stakes.ante': 1,
      'stakes.anteType': 'per-player',
      'stakes.bringIn': 2,
      'stakes.smallBet': 5,
      'stakes.bigBet': 10,
    });
    expect(parseSettings(stud).stakes.bigBlind).toBe(0);
  });

  it('fixed limit needs positive bet sizes in order, and a bring-in no bigger than the small bet', () => {
    const fl = withField(cash(), 'game.betting', 'fixed-limit');
    expect(() => parseSettings(fl)).not.toThrow();
    expect(pathsOf(() => parseSettings(withField(fl, 'stakes.smallBet', 0)))).toEqual(['stakes.smallBet']);
    expect(pathsOf(() => parseSettings(withFields(fl, { 'stakes.smallBet': 0, 'stakes.bigBet': 0 })))).toEqual([
      'stakes.smallBet',
      'stakes.bigBet',
    ]);
    expect(issuesOf(() => parseSettings(withFields(fl, { 'stakes.smallBet': 8, 'stakes.bigBet': 4 })))).toEqual([
      { path: 'stakes.smallBet', message: 'must not exceed the big bet (4)' },
    ]);
    expect(pathsOf(() => parseSettings(withField(fl, 'stakes.bringIn', 3)))).toEqual(['stakes.bringIn']);
    expect(() => parseSettings(withField(fl, 'stakes.bringIn', 2))).not.toThrow();
  });

  it('bet sizes are not checked when no fixed-limit game is in play', () => {
    expect(() => parseSettings(withFields(cash(), { 'stakes.smallBet': 0, 'stakes.bigBet': 0, 'stakes.bringIn': 9 }))).not.toThrow();
  });

  it('checks the stakes every game in an enabled rotation needs', () => {
    const steps = [
      { gameId: 'nlhe', betting: 'no-limit', length: 1, unit: 'orbits' },
      { gameId: 'lhe', betting: 'fixed-limit', length: 8, unit: 'hands' },
    ];
    const rotating = withFields(cash(), { 'game.rotation.steps': steps, 'stakes.smallBet': 0 });
    expect(() => parseSettings(rotating)).not.toThrow();
    expect(pathsOf(() => parseSettings(withField(rotating, 'game.rotation.enabled', true)))).toEqual(['stakes.smallBet']);

    const flOnly = withFields(cash(), {
      'game.betting': 'fixed-limit',
      'stakes.smallBlind': 0,
      'stakes.bigBlind': 0,
      'game.rotation.steps': [steps[1], { ...steps[0], betting: 'pot-limit' }],
    });
    expect(() => parseSettings(flOnly)).not.toThrow();
    expect(pathsOf(() => parseSettings(withField(flOnly, 'game.rotation.enabled', true)))).toEqual(['stakes.bigBlind']);
  });

  it("Dealer's choice needs two games, none twice, no rotation, and a cash table; its betting needs its stakes", () => {
    const nl = { gameId: 'nlhe', betting: 'no-limit' };
    const razz = { gameId: 'razz', betting: 'fixed-limit' };
    expect(issuesOf(() => parseSettings(withFields(cash(), { 'game.dealersChoice.enabled': true, 'game.dealersChoice.games': [nl] })))).toEqual([
      { path: 'game.dealersChoice.games', message: 'put at least two games on the menu' },
    ]);
    expect(pathsOf(() => parseSettings(withFields(cash(), { 'game.dealersChoice.games': [nl, razz, nl] })))).toEqual(['game.dealersChoice.games[2]']);
    const on = withFields(cash(), { 'game.dealersChoice.enabled': true, 'game.dealersChoice.games': [nl, razz] });
    expect(() => parseSettings(on)).not.toThrow();
    expect(pathsOf(() => parseSettings(withFields(on, { 'game.rotation.enabled': true, 'game.rotation.steps': [{ ...nl, length: 1, unit: 'hands' }] })))).toEqual([
      'game.dealersChoice.enabled',
    ]);
    expect(pathsOf(() => parseSettings(withField(on, 'stakes.smallBet', 0)))).toEqual(['stakes.smallBet']);
    // Off, its menu's betting asks nothing of the stakes.
    expect(() => parseSettings(withFields(on, { 'game.dealersChoice.enabled': false, 'stakes.smallBet': 0 }))).not.toThrow();
    const tour = withFields(defaultSettings('tournament'), { 'game.dealersChoice.enabled': true, 'game.dealersChoice.games': [nl, razz] });
    expect(pathsOf(() => parseSettings(tour))).toContain('game.dealersChoice.enabled');
  });

  it('settings from before Dealer\u2019s choice load with it left out, and migrate with it off', () => {
    const old = cash() as Record<string, unknown> & { game: Record<string, unknown> };
    delete old.game.dealersChoice;
    expect(parseSettings(old).game.dealersChoice).toBeUndefined();
    expect(migrateSettings(old).game.dealersChoice).toEqual({ enabled: false, games: [], hands: 0, pickSeconds: 20 });
  });

  it('an enabled rotation needs a step and an enabled schedule needs a level', () => {
    expect(issuesOf(() => parseSettings(withField(cash(), 'game.rotation.enabled', true)))).toEqual([
      { path: 'game.rotation.steps', message: 'add at least one step to rotate games' },
    ]);
    expect(issuesOf(() => parseSettings(withField(cash(), 'blindSchedule.enabled', true)))).toEqual([
      { path: 'blindSchedule.levels', message: 'add at least one level' },
    ]);
  });

  it('checks blind levels: small blind order, and a big blind for no-limit', () => {
    const levels = [level(1, 2), level(5, 4), level(0, 0)];
    const s = withFields(cash(), { 'blindSchedule.enabled': true, 'blindSchedule.levels': levels });
    expect(pathsOf(() => parseSettings(s))).toEqual(['blindSchedule.levels[1].smallBlind', 'blindSchedule.levels[2].bigBlind']);
  });

  it('antes must be 0 when the ante type is none', () => {
    expect(issuesOf(() => parseSettings(withField(cash(), 'stakes.ante', 5)))).toEqual([
      { path: 'stakes.ante', message: "must be 0 when stakes.anteType is 'none'" },
    ]);
    expect(() => parseSettings(withFields(cash(), { 'stakes.ante': 5, 'stakes.anteType': 'big-blind' }))).not.toThrow();
    expect(() => parseSettings(withField(cash(), 'stakes.anteType', 'per-player'))).not.toThrow();

    const withAntes = withField(cash(), 'blindSchedule.levels', [level(1, 2), level(2, 4, 4)]);
    expect(() => parseSettings(withAntes)).not.toThrow();
    const enabled = withField(withAntes, 'blindSchedule.enabled', true);
    expect(pathsOf(() => parseSettings(enabled))).toEqual(['blindSchedule.levels[1].ante']);
    expect(() => parseSettings(withField(enabled, 'stakes.anteType', 'big-blind'))).not.toThrow();
  });

  it('minimum buy-in may not exceed the maximum when both are set', () => {
    expect(issuesOf(() => parseSettings(withFields(cash(), { 'seating.minBuyIn': 500, 'seating.maxBuyIn': 200 })))).toEqual([
      { path: 'seating.minBuyIn', message: 'must not exceed the maximum buy-in (200)' },
    ]);
    expect(() => parseSettings(withFields(cash(), { 'seating.minBuyIn': 500, 'seating.maxBuyIn': 0 }))).not.toThrow();
    expect(() => parseSettings(withFields(cash(), { 'seating.minBuyIn': 0, 'seating.maxBuyIn': 200 }))).not.toThrow();
    expect(() => parseSettings(withFields(cash(), { 'seating.minBuyIn': 200, 'seating.maxBuyIn': 200 }))).not.toThrow();
  });

  it('reports field errors and cross-field errors together when types are right', () => {
    const s = withFields(cash(), { 'table.maxSeats': 11, 'stakes.smallBlind': 5 });
    expect(pathsOf(() => parseSettings(s))).toEqual(['table.maxSeats', 'stakes.smallBlind']);
  });
});

describe('tournament gate', () => {
  it('rejects run it twice in tournament mode', () => {
    for (const value of ['ask', 'always']) {
      expect(issuesOf(() => parseSettings(withField(tournament(), 'play.runItTwice', value)))).toEqual([
        { path: 'play.runItTwice', message: "must be 'off' in tournament mode" },
      ]);
    }
  });

  it('rejects switching a cash table to tournament mode with run it twice on', () => {
    expect(pathsOf(() => parseSettings(withField(cash(), 'table.mode', 'tournament')))).toEqual(['play.runItTwice']);
    expect(() => parseSettings(withFields(cash(), { 'table.mode': 'tournament', 'play.runItTwice': 'off' }))).not.toThrow();
  });

  it('leaves cash tables free to run it twice', () => {
    expect(() => parseSettings(withField(cash(), 'play.runItTwice', 'always'))).not.toThrow();
  });
});

describe('contract types', () => {
  it('lines up with the engine core', () => {
    expectTypeOf<TableSettings['game']['betting']>().toEqualTypeOf<BettingKind>();
    expectTypeOf<TableSettings['stakes']['anteType']>().toEqualTypeOf<Stakes['anteType']>();
    expectTypeOf<TableSettings['stakes']>().toMatchTypeOf<Stakes>();
    expectTypeOf<TableSettings['play']['runItTwice']>().toEqualTypeOf<HandOptions['runItTwice']>();
    expectTypeOf<TableSettings['play']['straddle']>().toEqualTypeOf<Parameters<PlanForcedBets>[0]['straddles']>();
    expectTypeOf<TableSettings['table']['mode']>().toEqualTypeOf<Parameters<PlanForcedBets>[0]['mode']>();
    expectTypeOf<TableSettings['timing']['showdownSeconds']>().toEqualTypeOf<3 | 6 | 9>();
  });
});
