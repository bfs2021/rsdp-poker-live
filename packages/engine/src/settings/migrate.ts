import { cloneJson, getOwn, isPlainObject, joinPath, type JsonObject } from './json';
import { getModifierSchema } from './modifiers';
import { SettingsError, defaultSettings, parseSettings } from './parse';
import { SETTINGS_VERSION, type TableMode, type TableSettings } from './schema';

/**
 * Version 0 is anything without a version: the MVP's flat room config
 * ({ smallBlind, bigBlind, turnSeconds, maxSeats }). Nested sections pass
 * through, and win over a flat key that says the same thing.
 */
function fromMvpConfig(raw: JsonObject): JsonObject {
  const { smallBlind, bigBlind, turnSeconds, maxSeats, ...rest } = raw;
  const out: JsonObject = { ...rest };
  const put = (section: string, key: string, value: unknown) => {
    if (value === undefined) return;
    const existing = out[section];
    const copy: JsonObject = isPlainObject(existing) ? { ...existing } : {};
    if (copy[key] === undefined) copy[key] = value;
    out[section] = copy;
  };
  put('stakes', 'smallBlind', smallBlind);
  put('stakes', 'bigBlind', bigBlind);
  put('timing', 'decisionSeconds', mvpClock(turnSeconds));
  put('table', 'maxSeats', maxSeats);
  return out;
}

/** The MVP allowed a 1-4 second clock and fractions; the clock is now 0 or 5-600 whole seconds. */
function mvpClock(seconds: unknown): unknown {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return seconds;
  const whole = Math.floor(seconds);
  if (whole > 0 && whole < 5) return 5;
  return Math.min(whole, 600);
}

/** MIGRATIONS[n] upgrades a version-n object to version n + 1. */
const MIGRATIONS: ((raw: JsonObject) => JsonObject)[] = [fromMvpConfig];

/** Defaults for array items, keyed by the array's path. Undefined means required: no default is guessed. */
const ITEM_TEMPLATES: Record<string, JsonObject> = {
  'game.rotation.steps': { gameId: undefined, betting: undefined, length: undefined, unit: 'hands' },
  'game.dealersChoice.games': { gameId: undefined, betting: undefined },
  'blindSchedule.levels': { smallBlind: undefined, bigBlind: undefined, ante: 0, minutes: 15, hands: 20 },
};

export interface MigrateOptions {
  /** Called with the paths of unknown fields that were dropped (unregistered modifiers included), for logging. */
  onDropped?(paths: string[]): void;
}

/**
 * Turns stored or imported settings of any version into current settings:
 * runs the version steps, drops unknown fields, fills missing ones from
 * defaultSettings(mode), then validates. A present but invalid value is not
 * guessed at: it throws SettingsError, so tightening a range needs a version
 * step that fixes old values. Null or undefined gives cash defaults.
 */
export function migrateSettings(raw: unknown, options: MigrateOptions = {}): TableSettings {
  const input = raw ?? {};
  if (!isPlainObject(input)) throw new SettingsError([{ path: '(root)', message: 'settings must be a JSON object' }]);

  const from = input.version ?? 0;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
    throw new SettingsError([{ path: 'version', message: 'must be a whole number' }]);
  }
  if (from > SETTINGS_VERSION) {
    throw new SettingsError([{ path: 'version', message: `${from} is newer than this build supports (${SETTINGS_VERSION})` }]);
  }

  let data: JsonObject = input;
  for (let v = from; v < SETTINGS_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no settings migration from version ${v}`);
    data = { ...step(data), version: v + 1 };
  }

  const table = getOwn(data, 'table');
  const mode: TableMode = isPlainObject(table) && table.mode === 'tournament' ? 'tournament' : 'cash';
  const dropped: string[] = [];
  const filled = conform(defaultSettings(mode), data, '', dropped);
  if (dropped.length > 0) options.onDropped?.(dropped);
  return parseSettings(filled);
}

/** Keeps the keys `template` knows, fills the ones `raw` lacks, and records the rest in `dropped`. */
function conform(template: unknown, raw: unknown, path: string, dropped: string[]): unknown {
  if (raw === undefined) return cloneJson(template);
  if (path === 'modifiers' && isPlainObject(raw)) return conformModifiers(raw, dropped);
  if (isPlainObject(template) && isPlainObject(raw)) {
    const out: JsonObject = {};
    for (const key of Object.keys(template)) {
      const value = conform(template[key], getOwn(raw, key), joinPath(path, key), dropped);
      if (value !== undefined) out[key] = value;
    }
    for (const key of Object.keys(raw)) if (!Object.hasOwn(template, key)) dropped.push(joinPath(path, key));
    return out;
  }
  if (Array.isArray(template) && Array.isArray(raw)) {
    const item = ITEM_TEMPLATES[path];
    return item ? raw.map((el, i) => conform(item, el, joinPath(path, i), dropped)) : cloneJson(raw);
  }
  // Wrong shapes and plain values pass through for the schema to judge.
  return cloneJson(raw);
}

/**
 * Registered sections are laid over their defaults (the modifier's own schema
 * strips or rejects unknown keys inside them); unregistered ids are dropped.
 * Absent registered ids are filled when the result is parsed.
 */
function conformModifiers(raw: JsonObject, dropped: string[]): JsonObject {
  const out: JsonObject = {};
  for (const [id, section] of Object.entries(raw)) {
    const entry = getModifierSchema(id);
    if (!entry) {
      dropped.push(joinPath('modifiers', id));
      continue;
    }
    out[id] = isPlainObject(section) ? { ...entry.defaults(), ...cloneJson(section) } : cloneJson(section);
  }
  return out;
}
