import { describe, expect, it } from 'vitest';
// The real modifier sections, as the server and web register them.
import '../../src/modifiers';
import {
  MAX_CHIPS,
  PRESET_FORMAT,
  SettingsError,
  defaultSettings,
  diffSettings,
  exportPreset,
  importPreset,
  migrateSettings,
  parseSettings,
  type TableMode,
  type TableSettings,
} from '../../src/settings';
import { withField } from './helpers';

/**
 * Pins what settings validation accepts, refuses and says today, field by
 * field, so a change to the validation library (or to the schema) shows up
 * here as a diff in settings-outcomes.txt. A change to that file is a change
 * players and hosts will see.
 */

/** Cash defaults with a game rotation and a blind schedule switched on, so their items are checked too. */
function busy(): TableSettings {
  const s = defaultSettings('cash');
  s.game.rotation = { enabled: true, steps: [{ gameId: 'plo', betting: 'pot-limit', length: 2, unit: 'orbits' }] };
  s.blindSchedule = { enabled: true, countdown: 'hands', levels: [{ smallBlind: 1, bigBlind: 2, ante: 0, minutes: 15, hands: 20 }] };
  return s;
}

const NUMBERS = [
  -1e20, -101, -1, -0, 0, 0.5, 1, 1.5, 2, 2.25, 2.345, 2.5, 3, 4, 5, 6, 7, 9, 10, 11, 20, 21, 24, 30, 31, 40, 41, 100, 101, 200,
  201, 240, 241, 300, 301, 600, 601, 1000, 1001, 1440, 1441, MAX_CHIPS, MAX_CHIPS + 1, 2 ** 53, 2 ** 53 + 2, 1e20, Number.NaN,
  Infinity, -Infinity,
];

const STRINGS = [
  '',
  ' ',
  'x',
  '1',
  '30',
  'NL',
  'plo',
  '  Friday  ',
  'Friday 🃏',
  'has space',
  'dot.id',
  'tab\there',
  'bell\u0007',
  'half \ud83d',
  '\udc00',
  'x'.repeat(40),
  'x'.repeat(41),
  `  ${'x'.repeat(40)}  `,
  // An emoji is two UTF-16 units: lengths are counted the way the forms' maxLength counts them.
  '🃏'.repeat(20),
  '🃏'.repeat(21),
  `${'x'.repeat(39)}🃏`,
];

/** Values sent in place of each field: every JSON type, boundaries of every range, and a few things JSON can't carry. */
const PROBES: unknown[] = [undefined, null, true, false, ...NUMBERS, ...STRINGS, [], [1], {}, { enabled: true }];

function show(value: unknown): string {
  if (value === undefined) return 'missing';
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'string') {
    const m = /^(.)\1{9,}$/u.exec(value);
    return m ? `'${m[1]}'×${[...value].length}` : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/** What a call did: the issues it was refused with, or "ok" and anything parsing changed. */
function outcome(input: unknown, run: () => unknown): string {
  try {
    const out = run();
    const changes = diffSettings(input as TableSettings, out as TableSettings);
    return changes.length ? `ok, changed ${changes.map((c) => `${c.path} ${show(c.from)} -> ${show(c.to)}`).join(', ')}` : 'ok';
  } catch (err) {
    if (err instanceof SettingsError) return err.issues.map((i) => `${i.path}: ${i.message}`).join(' | ');
    return `throws ${String(err)}`;
  }
}

/** Every path in `value`, objects and arrays included, depth first. */
function paths(value: unknown, path = ''): string[] {
  const out: string[] = [];
  const children: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [`${path}[${i}]`, v])
    : value !== null && typeof value === 'object'
      ? Object.entries(value).map(([k, v]) => [path ? `${path}.${k}` : k, v])
      : [];
  for (const [p, v] of children) out.push(p, ...paths(v, p));
  return out;
}

/** The value at a path printed like "blindSchedule.levels[0].ante". */
function getAt(value: unknown, path: string): unknown {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], value);
}

/** One block per path: each distinct outcome with the probes that gave it. */
function probeReport(label: string, at: (probe: unknown) => unknown, run: (input: unknown) => unknown): string {
  const groups = new Map<string, string[]>();
  for (const probe of PROBES) {
    const input = at(probe);
    const result = outcome(input, () => run(input));
    groups.set(result, [...(groups.get(result) ?? []), show(probe)]);
  }
  return [`## ${label}`, ...[...groups].map(([result, probes]) => `${result}  <=  ${probes.join(', ')}`)].join('\n');
}

const SCENARIOS: [string, () => unknown, unknown?][] = [];

/** A scenario whose result is checked against `input` for changes. */
function scenario(name: string, input: unknown, run: (input: unknown) => unknown = parseSettings) {
  SCENARIOS.push([name, () => run(input), input]);
}

const fields = (base: TableSettings, set: Record<string, unknown>) =>
  Object.entries(set).reduce((s, [path, value]) => withField(s, path, value), base);

// Several problems at once: which are reported, in what order, and how they are joined.
scenario('unknown field next to a small blind over the big blind', fields(busy(), { 'stakes.zzz': 1, 'stakes.smallBlind': 5 }));
scenario('unknown root field next to run it twice in a tournament', fields(busy(), { zzz: 1, 'table.mode': 'tournament' }));
scenario('unknown field in one section, cross-section rule broken elsewhere', fields(busy(), { 'chat.zzz': 1, 'stakes.bigBlind': 0, 'stakes.smallBlind': 0 }));
scenario('wrong type in one section, cross-section rule broken elsewhere', fields(busy(), { 'chat.guestChat': 'yes', 'stakes.bigBlind': 0, 'stakes.smallBlind': 0 }));
scenario('out of range in one section, cross-section rule broken elsewhere', fields(busy(), { 'table.maxSeats': 11, 'stakes.bigBlind': 0, 'stakes.smallBlind': 0 }));
scenario('out of range next to a small blind over the big blind', fields(busy(), { 'stakes.smallBlind': MAX_CHIPS + 1 }));
scenario('fraction below the minimum', fields(busy(), { 'stakes.ante': -1.5 }));
scenario('fraction above the maximum', fields(busy(), { 'table.maxSeats': 12.5 }));
scenario('huge fraction', fields(busy(), { 'stakes.bigBlind': 2 ** 51 + 0.5 }));
scenario('long name with a control character', fields(busy(), { 'table.name': `${'x'.repeat(41)}\u0007` }));
scenario('tab only name', fields(busy(), { 'table.name': '\t' }));
scenario('every section missing', { version: 1 });
scenario('empty object', {});
scenario('version 0 with everything else right', fields(busy(), { version: 0 }));
scenario('blind level missing fields', fields(busy(), { 'blindSchedule.levels': [{ smallBlind: 1 }] }));
scenario('blind level with an unknown field and a small blind over its big blind', fields(busy(), { 'blindSchedule.levels': [{ smallBlind: 5, bigBlind: 2, ante: 0, minutes: 15, hands: 20, zzz: 1 }] }));
scenario('blind levels: several bad at once', fields(busy(), { 'blindSchedule.levels': [{ smallBlind: 5, bigBlind: 2, ante: 3, minutes: 1, hands: 0 }, null, 'x'] }));
scenario('rotation step not an object', fields(busy(), { 'game.rotation.steps': ['plo'] }));
scenario('rotation enabled with no steps and an unknown field', fields(busy(), { 'game.rotation.steps': [], 'game.rotation.zzz': 1 }));
scenario('fixed limit rotation step with bad bet sizes', fields(busy(), { 'game.rotation.steps': [{ gameId: 'lhe', betting: 'fixed-limit', length: 1, unit: 'hands' }], 'stakes.smallBet': 8, 'stakes.bigBet': 4, 'stakes.bringIn': 9 }));
scenario('ante with ante type none, on the table and a level', fields(busy(), { 'stakes.ante': 5, 'blindSchedule.levels[0].ante': 2 }));
scenario('min buy-in over max buy-in, both fractions', fields(busy(), { 'seating.minBuyIn': 500.5, 'seating.maxBuyIn': 200.5 }));
scenario('decision clock wrong type', fields(busy(), { 'timing.decisionSeconds': '30' }));
scenario('decision clock fraction outside the range', fields(busy(), { 'timing.decisionSeconds': 2.5 }));

// Lists at and over their limit, next to other problems. A list over its limit is refused before its items
// are read, so problems inside it and the rules across sections only show once it is short enough.
const steps = (n: number) => Array.from({ length: n }, () => ({ gameId: 'plo', betting: 'pot-limit', length: 2, unit: 'orbits' }));
const levels = (n: number) => Array.from({ length: n }, () => ({ smallBlind: 1, bigBlind: 2, ante: 0, minutes: 15, hands: 20 }));
const badStep = { ...steps(1)[0], length: 0 };
scenario('20 rotation steps, the last one bad', fields(busy(), { 'game.rotation.steps': [...steps(19), badStep] }));
scenario('21 rotation steps, the last one bad', fields(busy(), { 'game.rotation.steps': [...steps(20), badStep] }));
scenario('100 blind levels, the last one not an object', fields(busy(), { 'blindSchedule.levels': [...levels(99), 'x'] }));
scenario('101 blind levels, the last one not an object', fields(busy(), { 'blindSchedule.levels': [...levels(100), 'x'] }));
scenario('21 rotation steps, bad fields in other sections', fields(busy(), { 'game.rotation.steps': steps(21), 'table.maxSeats': 11, 'stakes.smallBlind': 5 }));
scenario('21 rotation steps, bad fields beside them', fields(busy(), { 'game.rotation.steps': steps(21), 'game.rotation.enabled': 'yes', 'game.rotation.zzz': 1 }));
scenario('21 rotation steps, big blind 0', fields(busy(), { 'game.rotation.steps': steps(21), 'stakes.bigBlind': 0, 'stakes.smallBlind': 0 }));
scenario('101 blind levels switched off, ante with no ante type', fields(busy(), { 'blindSchedule.enabled': false, 'blindSchedule.levels': levels(101), 'stakes.ante': 5 }));
scenario(
  '101 blind levels in a tournament, run it twice on',
  fields(defaultSettings('tournament'), { 'blindSchedule.enabled': true, 'blindSchedule.levels': levels(101), 'play.runItTwice': 'ask' }),
);
scenario('101 blind levels, side-game field bad', fields(busy(), { 'blindSchedule.levels': levels(101), 'modifiers.rake.percent': 101 }));

// Modifiers: the registered sections, the tournament gate, and odd keys.
const tournamentWith = (set: Record<string, unknown>) => fields(defaultSettings('tournament'), set);
scenario('every cash-only modifier on in a tournament', tournamentWith(Object.fromEntries(['bomb-pot', 'nit', 'bounty-72', 'rake', 'double-board'].map((id) => [`modifiers.${id}.enabled`, true]))));
scenario('bad modifier field in a tournament with the modifier on', tournamentWith({ 'modifiers.rake.enabled': true, 'modifiers.rake.percent': 101 }));
scenario('unknown modifier field in a tournament with the modifier on', tournamentWith({ 'modifiers.nit.enabled': true, 'modifiers.nit.zzz': 1 }));
scenario('modifier on in a tournament, and run it twice on', tournamentWith({ 'modifiers.nit.enabled': true, 'play.runItTwice': 'ask' }));
scenario('bad modifier field in a tournament, and run it twice on', tournamentWith({ 'modifiers.rake.percent': 101, 'play.runItTwice': 'ask' }));
scenario('unregistered modifier in a tournament, and run it twice on', tournamentWith({ 'modifiers.sparkles': { enabled: true }, 'play.runItTwice': 'ask' }));
scenario('modifiers missing entirely', withField(busy(), 'modifiers', undefined));
scenario('modifiers empty', withField(busy(), 'modifiers', {}));
scenario('only one modifier given', withField(busy(), 'modifiers', { nit: { enabled: true, prizeBigBlinds: 2, minPlayers: 2 } }));
scenario('unregistered modifier', withField(busy(), 'modifiers.sparkles', { enabled: true }));
scenario('modifier section missing its switch', withField(busy(), 'modifiers.double-board', { when: 'always' }));
scenario('rake with two bad percents and a bad cap', fields(busy(), { 'modifiers.rake.percent': 2.345, 'modifiers.rake.shortHanded.percent': -1, 'modifiers.rake.cap': -1 }));
scenario('rake short-handed section not an object', fields(busy(), { 'modifiers.rake.shortHanded': [] }));
scenario('bomb pot game id with a dot', fields(busy(), { 'modifiers.bomb-pot.gameId': 'plo.5' }));

// Keys named __proto__ arrive as own keys from JSON.parse.
const json = (text: string) => JSON.parse(text) as Record<string, unknown>;
scenario('__proto__ key in a section', { ...busy(), stakes: { ...busy().stakes, ...json('{"__proto__": {"x": 1}}') } });
scenario('__proto__ key at the root', { ...busy(), ...json('{"__proto__": {"x": 1}}') });
scenario('__proto__ modifier id', { ...busy(), modifiers: { ...busy().modifiers, ...json('{"__proto__": {"enabled": true}}') } });
scenario('constructor modifier id', { ...busy(), modifiers: { ...busy().modifiers, constructor: { enabled: true } } });
scenario('settings with a null prototype', Object.assign(Object.create(null) as object, busy()));
scenario('a class instance for settings', new (class Settings {})());
scenario('a date for a number', fields(busy(), { 'table.maxSeats': new Date(0) }));
scenario('a bigint for a number', fields(busy(), { 'table.maxSeats': 6n }));
scenario('a function for a boolean', fields(busy(), { 'chat.guestChat': () => true }));
scenario('a symbol for text', fields(busy(), { 'table.name': Symbol('x') }));
scenario('sparse blind levels', fields(busy(), { 'blindSchedule.levels': [, { smallBlind: 1, bigBlind: 2, ante: 0, minutes: 15, hands: 20 }] }));

// Stored settings from older versions, and partial ones, through migrateSettings.
const migrate = (raw: unknown) => {
  const dropped: string[] = [];
  const settings = migrateSettings(raw, { onDropped: (p) => dropped.push(...p) });
  return { settings, dropped };
};
function migration(name: string, raw: unknown) {
  SCENARIOS.push([
    `migrate: ${name}`,
    () => {
      const { settings, dropped } = migrate(raw);
      return { settings, dropped };
    },
  ]);
}
migration('nothing stored', undefined);
migration('MVP flat config', { smallBlind: 5, bigBlind: 10, turnSeconds: 20, maxSeats: 9 });
migration('MVP flat config with a fractional short clock', { smallBlind: 1, bigBlind: 2, turnSeconds: 1.5, maxSeats: 6 });
migration('MVP flat config with bad values', { smallBlind: '5', bigBlind: -10, turnSeconds: 'fast', maxSeats: 99 });
migration('MVP flat config with a huge clock', { turnSeconds: 1e9 });
migration('MVP flat config with an infinite clock', { turnSeconds: Infinity });
migration('MVP flat config with nested sections and unknown keys', { bigBlind: 10, stakes: { smallBlind: 2, bigBlind: 4 }, theme: 'dark' });
migration('version 1 tournament, partial', { version: 1, table: { mode: 'tournament', name: 'Final' }, timing: { decisionSeconds: 45 } });
migration('version 1 partial modifiers', { version: 1, modifiers: { rake: { enabled: true, percent: 2.5 }, retired: { enabled: true } } });
migration('version 1 modifier section not an object', { version: 1, modifiers: { rake: 'on' } });
migration('version 1 levels and steps missing fields', {
  version: 1,
  blindSchedule: { enabled: true, levels: [{ smallBlind: 1, bigBlind: 2 }, { smallBlind: 2, bigBlind: 4, colour: 'red' }] },
  game: { rotation: { enabled: true, steps: [{ gameId: 'plo', betting: 'pot-limit', length: 2 }] } },
});
migration('version 1 with a wrong section type', { version: 1, seating: [] });
migration('version 1 with several bad fields', { version: 1, table: { maxSeats: 1, name: '' }, stakes: { smallBlind: 3, bigBlind: 2 } });
migration('newer version', { version: 2 });
migration('fractional version', { version: 0.5 });

// Preset files, as saved by older builds and as shared between friends.
const preset = (fields: Record<string, unknown>) => JSON.stringify({ format: PRESET_FORMAT, version: 1, name: 'Friday', settings: defaultSettings('cash'), ...fields });
function presetImport(name: string, text: string) {
  SCENARIOS.push([`import preset: ${name}`, () => importPreset(text)]);
}
presetImport('current', preset({}));
presetImport('MVP settings inside', preset({ settings: { smallBlind: 10, bigBlind: 20, turnSeconds: 2, sparkles: true } }));
presetImport('tournament settings, partial', preset({ settings: { version: 1, table: { mode: 'tournament' }, play: { runItTwice: 'always' } } }));
presetImport('bad settings inside', preset({ settings: { version: 1, table: { maxSeats: 0 }, stakes: { ante: 1.5 } } }));
presetImport('name padded', preset({ name: '  Friday night  ' }));
for (const name of [undefined, null, 5, '', '   ', 'tab\there', 'x'.repeat(60), 'x'.repeat(61), '🃏'.repeat(30), '🃏'.repeat(31), ['Friday']]) {
  presetImport(`name ${show(name)}`, preset({ name }));
}
presetImport('wrong format', preset({ format: 'other' }));
presetImport('version 0', preset({ version: 0 }));
presetImport('version 2', preset({ version: 2 }));
presetImport('settings missing', preset({ settings: undefined }));
presetImport('settings not an object', preset({ settings: 'cash' }));
presetImport('not JSON', '{nope');
presetImport('JSON array', '[]');
SCENARIOS.push(['export preset: name with a tab', () => exportPreset(defaultSettings('cash'), 'tab\there')]);
SCENARIOS.push(['export preset: good', () => exportPreset(defaultSettings('cash'), 'Friday')]);
SCENARIOS.push(['export preset: invalid settings', () => exportPreset(withField(defaultSettings('cash'), 'table.maxSeats', 0), 'Friday')]);

/** How settings differ from the defaults of their mode, as "path = value" pairs. */
function fromDefaults(settings: TableSettings): string {
  const changes = diffSettings(defaultSettings(settings.table.mode), settings);
  return `differs from ${settings.table.mode} defaults at ${changes.map((c) => `${c.path} = ${show(c.to)}`).join(', ') || 'nothing'}`;
}

function scenarioReport(): string {
  return SCENARIOS.map(([name, run, input]) => {
    let result: string;
    try {
      const out: unknown = run();
      if (input !== undefined) result = outcome(input, () => out);
      else if (typeof out === 'string') result = `ok, ${out.length} characters`;
      else {
        const { settings, dropped, name: named } = out as { settings: TableSettings; dropped?: string[]; name?: string };
        if (dropped) result = `ok, ${fromDefaults(settings)}; dropped ${show(dropped)}`;
        else result = `ok, named ${show(named)}, ${fromDefaults(settings)}`;
      }
    } catch (err) {
      result = err instanceof SettingsError ? err.issues.map((i) => `${i.path}: ${i.message}`).join(' | ') : `throws ${String(err)}`;
    }
    return `## ${name}\n${result}`;
  }).join('\n');
}

describe('settings validation, pinned', () => {
  it('fills the same defaults, modifier sections included', () => {
    const modifiers = {
      'bomb-pot': { enabled: false, chancePercent: 10, everyHands: 0, bigBlinds: 5, gameId: '', betting: 'pot-limit' },
      'double-board': { enabled: false, when: 'bomb-pots' },
      'bounty-72': { enabled: false, amount: 10, suits: 'any', autoShow: true },
      rake: { enabled: false, percent: 5, cap: 0, minPot: 0, noFlopNoDrop: true, shortHanded: { players: 0, percent: 2.5, cap: 0 }, visibleTo: 'host' },
      nit: { enabled: false, prizeBigBlinds: 10, minPlayers: 3 },
    };
    for (const mode of ['cash', 'tournament'] as TableMode[]) {
      const tournament = mode === 'tournament';
      const expected = {
        version: 1,
        table: { name: tournament ? 'Tournament table' : 'Poker night', maxSeats: 10, mode, felt: 'green' },
        game: { gameId: 'nlhe', betting: 'no-limit', rotation: { enabled: false, steps: [] }, dealersChoice: { enabled: false, games: [], hands: 0, pickSeconds: 20 } },
        stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none', bringIn: 0, smallBet: 2, bigBet: 4, centsMode: false },
        blindSchedule: { enabled: false, countdown: 'per-level-timer', levels: [] },
        timing: { decisionSeconds: 30, timeBankSeconds: 30, timeBankRefillHands: 10, autoActivateTimeBank: true, autoStartNextHand: true, showdownSeconds: 6, nextHandDelaySeconds: 3 },
        seating: {
          requireApproval: true,
          allowRebuys: true,
          rebuyRequiresApproval: true,
          minBuyIn: 0,
          maxBuyIn: 0,
          ratholeMinutes: 0,
          waitlist: false,
          randomSeats: false,
          allowPlayerBots: true,
          dealToAway: tournament,
          awayAfterTimeouts: 2,
          offlineGraceSeconds: 15,
          releaseOfflineSeatMinutes: 0,
        },
        play: { runItTwice: tournament ? 'off' : 'ask', rabbitHunt: true, straddle: 'utg', revealAllAtShowdown: false, trimExcessBets: false, fixedLimitCap: 4, uncappedHeadsUp: true },
        chat: { guestChat: true, profanityFilter: false },
        spectators: { allowed: true, seeAllCards: false, delaySeconds: 0 },
        modifiers,
      };
      expect(defaultSettings(mode)).toStrictEqual(expected);
      expect(parseSettings(defaultSettings(mode))).toStrictEqual(expected);
      expect(migrateSettings(JSON.parse(JSON.stringify(defaultSettings(mode))))).toStrictEqual(expected);
      // Optional fields left out stay left out; absent modifier sections are filled.
      const lean = withField(withField(withField(defaultSettings(mode), 'table.felt', undefined), 'chat.gestures', undefined), 'modifiers', {});
      const { felt: _, ...table } = expected.table;
      expect(parseSettings(lean)).toStrictEqual({ ...expected, table });
    }
  });

  it('accepts, refuses and words every field the same way', async () => {
    const base = busy();
    const blocks = [probeReport('(root)', (probe) => probe, parseSettings)];
    for (const path of paths(base)) blocks.push(probeReport(path, (probe) => withField(base, path, probe), parseSettings));
    for (const path of paths(base)) {
      const node = getAt(base, path);
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        const input = withField(base, `${path}.zzz`, 1);
        blocks.push(`## ${path} with an unknown field\n${outcome(input, () => parseSettings(input))}`);
      }
    }
    blocks.push(`## (root) with an unknown field\n${outcome({ ...base, zzz: 1 }, () => parseSettings({ ...base, zzz: 1 }))}`);
    blocks.push('# Scenarios', scenarioReport());
    await expect(`${blocks.join('\n')}\n`).toMatchFileSnapshot('./settings-outcomes.txt');
  });

  it('words errors for people the same way', () => {
    const error = (() => {
      try {
        parseSettings(fields(busy(), { 'table.maxSeats': 12, 'stakes.ante': -1.5, zzz: 1 }));
      } catch (err) {
        return err as SettingsError;
      }
      throw new Error('expected a SettingsError');
    })();
    expect(error.message).toBe(
      'Invalid table settings:\n- table.maxSeats: must be at most 10\n- stakes.ante: must be a whole number; must be at least 0\n- zzz: unknown field',
    );
  });
});
