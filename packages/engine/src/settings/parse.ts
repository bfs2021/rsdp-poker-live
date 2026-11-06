import { z } from 'zod';
import { formatPath, joinPath } from './json';
import { settingsErrorMap } from './messages';
import { defaultModifierSections } from './modifiers';
import { SETTINGS_VERSION, TableSettingsSchema, type TableMode, type TableSettings } from './schema';

/** One bad field: `path` is printed like "stakes.bigBlind" or "blindSchedule.levels[2].ante". */
export interface SettingsIssue {
  path: string;
  message: string;
}

/** Thrown for settings that fail validation. `issues` has one entry per bad path, so forms can mark each field. */
export class SettingsError extends Error {
  readonly issues: SettingsIssue[];

  constructor(issues: SettingsIssue[], heading = 'Invalid table settings') {
    super(`${heading}:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'SettingsError';
    this.issues = issues;
  }
}

/**
 * Flattens zod issues to one entry per path, splitting unknown-key issues so
 * each key gets its own path. A value of the wrong type gets only that
 * message: zod still checks the length of one that has a length, so a list
 * given for a name would also be told "must not be blank".
 */
export function issuesFromZod(error: z.ZodError): SettingsIssue[] {
  const byPath = new Map<string, string[]>();
  const add = (path: string, message: string) => {
    const messages = byPath.get(path) ?? [];
    if (!messages.includes(message)) messages.push(message);
    byPath.set(path, messages);
  };
  const wrongType = new Set(error.issues.filter((i) => i.code === 'invalid_type').map((i) => formatPath(i.path)));
  for (const issue of error.issues) {
    const path = formatPath(issue.path);
    if (issue.code !== 'invalid_type' && wrongType.has(path)) continue;
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) add(joinPath(path, key), 'unknown field');
    } else {
      add(path || '(root)', issue.message);
    }
  }
  return [...byPath].map(([path, messages]) => ({ path, message: messages.join('; ') }));
}

/**
 * Validates a complete settings object (what the web sends, or a merged
 * patch) and returns the parsed copy. Throws SettingsError listing every bad
 * field. Registered modifier sections that are absent get their defaults.
 */
export function parseSettings(input: unknown): TableSettings {
  const result = TableSettingsSchema.safeParse(input, { error: settingsErrorMap });
  if (!result.success) throw new SettingsError(issuesFromZod(result.error));
  return result.data;
}

/**
 * Fresh defaults for a new table. Tournament defaults already pass the
 * tournament gates (run it twice off, modifiers off) and deal to away players.
 * Tournament tables get their blinds from the director, so the stakes here
 * only matter until the first level is applied.
 */
export function defaultSettings(mode: TableMode): TableSettings {
  if (mode !== 'cash' && mode !== 'tournament') throw new Error(`unknown table mode "${String(mode)}"`);
  const tournament = mode === 'tournament';
  return {
    version: SETTINGS_VERSION,
    table: { name: tournament ? 'Tournament table' : 'Poker night', maxSeats: 10, mode, felt: 'green' },
    game: { gameId: 'nlhe', betting: 'no-limit', rotation: { enabled: false, steps: [] }, dealersChoice: { enabled: false, games: [], hands: 0, pickSeconds: 20 } },
    stakes: {
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      anteType: 'none',
      bringIn: 0,
      smallBet: 2,
      bigBet: 4,
      centsMode: false,
    },
    blindSchedule: { enabled: false, countdown: 'per-level-timer', levels: [] },
    timing: {
      decisionSeconds: 30,
      timeBankSeconds: 30,
      timeBankRefillHands: 10,
      autoActivateTimeBank: true,
      autoStartNextHand: true,
      showdownSeconds: 6,
      nextHandDelaySeconds: 3,
    },
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
    play: {
      runItTwice: tournament ? 'off' : 'ask',
      rabbitHunt: true,
      straddle: 'utg',
      revealAllAtShowdown: false,
      trimExcessBets: false,
      fixedLimitCap: 4,
      uncappedHeadsUp: true,
    },
    chat: { guestChat: true, profanityFilter: false },
    spectators: { allowed: true, seeAllCards: false, delaySeconds: 0 },
    modifiers: defaultModifierSections(),
  };
}
