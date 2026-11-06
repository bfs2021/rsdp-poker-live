import { z } from 'zod';
import type { AnteType, BettingKind } from '../core/types';
import { isSectionEnabled, listModifierSchemas, parseModifierSections } from './modifiers';

/** Layout version stored in every settings object. Bump it with a new step in migrate.ts. */
export const SETTINGS_VERSION = 1;

/** Largest chip amount a setting may hold; ten such stacks still sum far inside safe integers. */
export const MAX_CHIPS = 1_000_000_000_000;

export const TABLE_MODES = ['cash', 'tournament'] as const;
export const BETTING_KINDS = ['no-limit', 'pot-limit', 'fixed-limit'] as const satisfies readonly BettingKind[];
export const ANTE_TYPES = ['none', 'per-player', 'big-blind'] as const satisfies readonly AnteType[];
export const ROTATION_UNITS = ['hands', 'orbits'] as const;
export const LEVEL_COUNTDOWNS = ['per-level-timer', 'hands'] as const;
export const RUN_IT_TWICE_OPTIONS = ['off', 'ask', 'always'] as const;
export const STRADDLE_OPTIONS = ['off', 'utg', 'utg-and-button'] as const;
export const SHOWDOWN_SECONDS = [3, 6, 9] as const;
/** Table felt colours the host can pick. Each player may still see their own. */
export const FELTS = ['green', 'blue', 'red', 'purple', 'charcoal', 'teal'] as const;

export type TableMode = (typeof TABLE_MODES)[number];

/** Ranges the schema enforces, exported so forms show the same limits. All inclusive. */
export const SETTINGS_LIMITS = {
  tableName: { min: 1, max: 40 },
  maxSeats: { min: 2, max: 10 },
  chips: { min: 0, max: MAX_CHIPS },
  gameId: { min: 1, max: 40 },
  rotationSteps: { min: 1, max: 20 },
  rotationLength: { min: 1, max: 1000 },
  /** Dealer's choice: games on the menu. */
  choiceGames: { min: 2, max: 20 },
  /** Dealer's choice: hands each pick lasts; 0 means one orbit. */
  choiceHands: { min: 0, max: 100 },
  /** Dealer's choice: seconds the chooser has to pick. */
  pickSeconds: { min: 10, max: 60 },
  blindLevels: { min: 1, max: 100 },
  levelMinutes: { min: 2, max: 240 },
  levelHands: { min: 1, max: 1000 },
  /** 0 turns the clock off; otherwise this range. */
  decisionSeconds: { min: 5, max: 600 },
  timeBankSeconds: { min: 0, max: 300 },
  timeBankRefillHands: { min: 0, max: 200 },
  nextHandDelaySeconds: { min: 0, max: 30 },
  ratholeMinutes: { min: 0, max: 1440 },
  awayAfterTimeouts: { min: 0, max: 10 },
  offlineGraceSeconds: { min: 0, max: 300 },
  releaseOfflineSeatMinutes: { min: 0, max: 1440 },
  fixedLimitCap: { min: 2, max: 10 },
  spectatorDelaySeconds: { min: 0, max: 600 },
} as const;

const L = SETTINGS_LIMITS;

/**
 * A whole number. zod's .int() stops checking at a fraction, so -1.5 would
 * only be "must be a whole number"; this lets the range checks run too
 * ("must be a whole number; must be at least 0"), so a host sees every
 * problem at once.
 */
const whole = () => z.number().refine(Number.isInteger, 'must be a whole number');

/** A whole number in an inclusive range. Modifier sections use it too, so every setting reads the same way. */
export const wholeNumber = (range: { min: number; max: number }) => whole().min(range.min).max(range.max);

const chips = wholeNumber(L.chips);

/** Cross-field rules only compare amounts that are valid on their own, so one bad field gives one error. */
const isChips = (v: number) => chips.safeParse(v).success;

/** a > b, for two otherwise valid amounts. */
const exceeds = (a: number, b: number) => isChips(a) && isChips(b) && a > b;

/** v < min, for an otherwise valid amount. */
const below = (v: number, min: number) => isChips(v) && v < min;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const label = (range: { min: number; max: number }) =>
  z
    .string()
    .trim()
    .min(range.min, 'must not be blank')
    // Counted like the form's maxLength, an emoji as two: zod's .max() would count it as one.
    .refine((s) => s.length <= range.max, `must be at most ${range.max} characters`)
    .refine((s) => !CONTROL_CHARS.test(s), 'must not contain control characters')
    // A lone UTF-16 surrogate (half an emoji) can't be stored: the table could no longer be saved.
    .refine((s) => !/\p{Cs}/u.test(s), 'must not contain half of an emoji');

/** Variant id from the variants registry; the server checks that it exists. */
const gameId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, 'must be 1-40 letters, digits, dashes or underscores');

const custom = (ctx: z.RefinementCtx, path: (string | number)[], message: string) =>
  ctx.addIssue({ code: 'custom', path, message });

const TableSection = z
  .object({
    /** Shown in the lobby and the table header. 1-40 characters. */
    name: label(L.tableName),
    /** Seats around the table, 2-10. */
    maxSeats: wholeNumber(L.maxSeats),
    /** Cash game, or a table run by the tournament director. */
    mode: z.enum(TABLE_MODES),
    /** Felt colour everyone sees unless they pick their own (green when left out). */
    felt: z.enum(FELTS).optional(),
  })
  .strict();

const RotationStepSchema = z
  .object({
    /** Game played during this step. */
    gameId,
    /** Betting structure during this step. */
    betting: z.enum(BETTING_KINDS),
    /** How long the step lasts, in `unit`s (1-1000). */
    length: wholeNumber(L.rotationLength),
    /** Count hands, or full orbits of the button. */
    unit: z.enum(ROTATION_UNITS),
  })
  .strict();

/** A game on a Dealer's choice menu: the chooser picks the game with this betting. */
const ChoiceGameSchema = z
  .object({
    gameId,
    betting: z.enum(BETTING_KINDS),
  })
  .strict();

const DealersChoiceSchema = z
  .object({
    /** Players take turns choosing the game (cash tables; not with a rotation). */
    enabled: z.boolean(),
    /** The menu: 2-20 games, each with its betting, none twice. */
    games: z.array(ChoiceGameSchema).max(L.choiceGames.max),
    /** Hands each pick lasts; 0 (the default) means one orbit. */
    hands: wholeNumber(L.choiceHands),
    /** Seconds the chooser has to pick (10-60, default 20). */
    pickSeconds: wholeNumber(L.pickSeconds),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.enabled && d.games.length < L.choiceGames.min) custom(ctx, ['games'], 'put at least two games on the menu');
    const seen = new Set<string>();
    d.games.forEach((g, i) => {
      const key = `${g.gameId}/${g.betting}`;
      if (seen.has(key)) custom(ctx, ['games', i], 'is on the menu twice');
      seen.add(key);
    });
  });

const GameSection = z
  .object({
    /** Game dealt when no rotation is running (default 'nlhe'). */
    gameId,
    /** Betting structure (default no-limit). */
    betting: z.enum(BETTING_KINDS),
    /** Mixed games: cycle through `steps` in order. */
    rotation: z
      .object({
        /** Rotate games (needs at least one step). */
        enabled: z.boolean(),
        /** Up to 20 steps. */
        steps: z.array(RotationStepSchema).max(L.rotationSteps.max),
      })
      .strict()
      .superRefine((r, ctx) => {
        if (r.enabled && r.steps.length < L.rotationSteps.min) custom(ctx, ['steps'], 'add at least one step to rotate games');
      }),
    /**
     * Dealer's choice (D31). Optional because settings saved with a table
     * before it existed aren't migrated: missing means off. New settings
     * always have it.
     */
    dealersChoice: DealersChoiceSchema.optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.rotation.enabled && g.dealersChoice?.enabled) custom(ctx, ['dealersChoice', 'enabled'], "turn off rotating games to use Dealer's choice");
  });

const StakesSection = z
  .object({
    /** Small blind; 0 allowed for ante-only and stud games. */
    smallBlind: chips,
    /** Big blind; at least 1 for no-limit and pot-limit (it is the minimum bet). */
    bigBlind: chips,
    /** Ante amount; must be 0 when anteType is 'none'. */
    ante: chips,
    /** Who posts the ante: nobody, every player, or the big blind for the table. */
    anteType: z.enum(ANTE_TYPES),
    /** Stud bring-in. */
    bringIn: chips,
    /** Fixed-limit bet on the early streets. */
    smallBet: chips,
    /** Fixed-limit bet on the late streets. */
    bigBet: chips,
    /** Display chips divided by 100 as dollars and cents. Formatting only. */
    centsMode: z.boolean(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (exceeds(s.smallBlind, s.bigBlind)) custom(ctx, ['smallBlind'], `must not exceed the big blind (${s.bigBlind})`);
  });

const BlindLevelSchema = z
  .object({
    /** Small blind for this level. */
    smallBlind: chips,
    /** Big blind for this level. */
    bigBlind: chips,
    /** Ante for this level, posted the way stakes.anteType says. */
    ante: chips,
    /** Level length when countdown is 'per-level-timer' (2-240). */
    minutes: wholeNumber(L.levelMinutes),
    /** Level length when countdown is 'hands' (1-1000). */
    hands: wholeNumber(L.levelHands),
  })
  .strict()
  .superRefine((lv, ctx) => {
    if (exceeds(lv.smallBlind, lv.bigBlind)) custom(ctx, ['smallBlind'], `must not exceed the big blind (${lv.bigBlind})`);
  });

const BlindScheduleSection = z
  .object({
    /** Raise the blinds through `levels` (needs at least one level). */
    enabled: z.boolean(),
    /** Move up a level on a clock, or after a number of hands. */
    countdown: z.enum(LEVEL_COUNTDOWNS),
    /** Up to 100 levels, played in order. */
    levels: z.array(BlindLevelSchema).max(L.blindLevels.max),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.enabled && b.levels.length < L.blindLevels.min) custom(ctx, ['levels'], 'add at least one level');
  });

const TimingSection = z
  .object({
    /** Seconds per decision: 0 for no clock, otherwise 5-600. */
    decisionSeconds: whole().refine(
      (v) => v === 0 || (v >= L.decisionSeconds.min && v <= L.decisionSeconds.max),
      `must be 0 (no clock) or ${L.decisionSeconds.min}-${L.decisionSeconds.max}`,
    ),
    /** Extra seconds each player can draw on, 0-300. */
    timeBankSeconds: wholeNumber(L.timeBankSeconds),
    /** Hands between time bank refills, 0-200 (0 = never refills). */
    timeBankRefillHands: wholeNumber(L.timeBankRefillHands),
    /** Start the time bank automatically when the decision clock runs out. */
    autoActivateTimeBank: z.boolean(),
    /** Deal the next hand without the host pressing start. */
    autoStartNextHand: z.boolean(),
    /** How long a showdown stays on screen: 3, 6 or 9 seconds. */
    showdownSeconds: z.literal(SHOWDOWN_SECONDS, {
      error: (issue) => (issue.input === undefined ? 'required' : 'must be 3, 6 or 9'),
    }),
    /** Pause between hands, 0-30 seconds. */
    nextHandDelaySeconds: wholeNumber(L.nextHandDelaySeconds),
  })
  .strict();

const SeatingSection = z
  .object({
    /** The host approves every seat request. */
    requireApproval: z.boolean(),
    /** Busted or short players may add chips between hands. */
    allowRebuys: z.boolean(),
    /** Rebuys wait for the host's approval. */
    rebuyRequiresApproval: z.boolean(),
    /** Smallest buy-in; 0 = no minimum (buy-ins are not enforced by default). */
    minBuyIn: chips,
    /** Largest buy-in; 0 = no maximum. */
    maxBuyIn: chips,
    /** Minutes a player who left must come back with at least their old stack; 0 = off. */
    ratholeMinutes: wholeNumber(L.ratholeMinutes),
    /** Queue players for full tables. */
    waitlist: z.boolean(),
    /** New players get a random open seat instead of the one they picked (false when left out). */
    randomSeats: z.boolean().optional(),
    /** Seated players may add practice bots; the host always can (true when left out). */
    allowPlayerBots: z.boolean().optional(),
    /** Keep dealing to away players (they auto check or fold). */
    dealToAway: z.boolean(),
    /** Consecutive timeouts before a player is marked away, 0-10 (0 = never). */
    awayAfterTimeouts: wholeNumber(L.awayAfterTimeouts),
    /** Seconds a disconnected player keeps acting normally before being marked away, 0-300. */
    offlineGraceSeconds: wholeNumber(L.offlineGraceSeconds),
    /** Minutes offline before the seat is released, 0-1440 (0 = never). */
    releaseOfflineSeatMinutes: wholeNumber(L.releaseOfflineSeatMinutes),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.minBuyIn > 0 && s.maxBuyIn > 0 && exceeds(s.minBuyIn, s.maxBuyIn)) {
      custom(ctx, ['minBuyIn'], `must not exceed the maximum buy-in (${s.maxBuyIn})`);
    }
  });

const PlaySection = z
  .object({
    /** Run it twice when all in before the river: never, by vote, or every time. Must be 'off' in tournaments. */
    runItTwice: z.enum(RUN_IT_TWICE_OPTIONS),
    /** Players may reveal the cards that would have come after the hand ended. */
    rabbitHunt: z.boolean(),
    /** Optional straddles players may post. */
    straddle: z.enum(STRADDLE_OPTIONS),
    /** Show every live hand at showdown; when false, losing hands may muck. */
    revealAllAtShowdown: z.boolean(),
    /** Cut a bet down to the most any opponent can call, returning the excess at once. */
    trimExcessBets: z.boolean(),
    /** Fixed-limit bets per round, the bet included (2-10). */
    fixedLimitCap: wholeNumber(L.fixedLimitCap),
    /** No fixed-limit cap when two players are left in the hand. */
    uncappedHeadsUp: z.boolean(),
  })
  .strict();

const ChatSection = z
  .object({
    /** People who are not seated (spectators, players waiting for a seat) may chat. The host always can. */
    guestChat: z.boolean(),
    /** Mask common profanity in chat. */
    profanityFilter: z.boolean(),
    /** Players may throw gestures at each other (on when left out). */
    gestures: z.boolean().optional(),
  })
  .strict();

const SpectatorsSection = z
  .object({
    /** People who are not seated may watch. */
    allowed: z.boolean(),
    /** Spectators see every hole card (after the delay). */
    seeAllCards: z.boolean(),
    /** Seconds spectators run behind the table, 0-600. */
    delaySeconds: wholeNumber(L.spectatorDelaySeconds),
  })
  .strict();

/** Registered modifier sections by id; see modifiers.ts. */
const ModifiersSection = z.record(z.string(), z.unknown()).transform(parseModifierSections);

const SettingsObject = z
  .object({
    /** Layout version; migrateSettings upgrades older ones. */
    version: z.literal(SETTINGS_VERSION, { error: `must be ${SETTINGS_VERSION} (use migrateSettings for older settings)` }),
    table: TableSection,
    game: GameSection,
    stakes: StakesSection,
    blindSchedule: BlindScheduleSection,
    timing: TimingSection,
    seating: SeatingSection,
    play: PlaySection,
    chat: ChatSection,
    spectators: SpectatorsSection,
    modifiers: ModifiersSection,
  })
  .strict();

/** Rules that span sections: mode gates, and stakes the betting structures in play need. */
function checkAcrossSections(s: z.output<typeof SettingsObject>, ctx: z.RefinementCtx): void {
  if (s.table.mode === 'tournament') {
    if (s.play.runItTwice !== 'off') custom(ctx, ['play', 'runItTwice'], "must be 'off' in tournament mode");
    for (const entry of listModifierSchemas()) {
      if (entry.cashOnly && isSectionEnabled(s.modifiers[entry.id])) {
        custom(ctx, ['modifiers', entry.id, 'enabled'], 'cash games only: turn it off in tournament mode');
      }
    }
    if (s.game.dealersChoice?.enabled) custom(ctx, ['game', 'dealersChoice', 'enabled'], 'cash games only: turn it off in tournament mode');
  }

  const kinds = new Set<BettingKind>([s.game.betting]);
  if (s.game.rotation.enabled) for (const step of s.game.rotation.steps) kinds.add(step.betting);
  if (s.game.dealersChoice?.enabled) for (const g of s.game.dealersChoice.games) kinds.add(g.betting);
  const { stakes, blindSchedule } = s;
  const levels = blindSchedule.enabled ? blindSchedule.levels : [];

  if (kinds.has('no-limit') || kinds.has('pot-limit')) {
    const message = 'must be at least 1 for no-limit and pot-limit games';
    if (below(stakes.bigBlind, 1)) custom(ctx, ['stakes', 'bigBlind'], message);
    levels.forEach((lv, i) => {
      if (below(lv.bigBlind, 1)) custom(ctx, ['blindSchedule', 'levels', i, 'bigBlind'], message);
    });
  }
  if (kinds.has('fixed-limit')) {
    if (below(stakes.smallBet, 1)) custom(ctx, ['stakes', 'smallBet'], 'must be at least 1 for fixed-limit games');
    else if (exceeds(stakes.smallBet, stakes.bigBet)) {
      custom(ctx, ['stakes', 'smallBet'], `must not exceed the big bet (${stakes.bigBet})`);
    }
    if (below(stakes.bigBet, 1)) custom(ctx, ['stakes', 'bigBet'], 'must be at least 1 for fixed-limit games');
    if (exceeds(stakes.bringIn, stakes.smallBet)) {
      custom(ctx, ['stakes', 'bringIn'], `must not exceed the small bet (${stakes.smallBet})`);
    }
  }
  if (stakes.anteType === 'none') {
    const message = "must be 0 when stakes.anteType is 'none'";
    if (exceeds(stakes.ante, 0)) custom(ctx, ['stakes', 'ante'], message);
    levels.forEach((lv, i) => {
      if (exceeds(lv.ante, 0)) custom(ctx, ['blindSchedule', 'levels', i, 'ante'], message);
    });
  }
}

/**
 * The whole table settings object, shared by server and web. Every field is
 * required and unknown keys are rejected; use migrateSettings for stored or
 * partial data. Cross-section rules run once each field has the right type
 * and no list is over its limit. zod refuses an over-long list before reading
 * its items (its guard against huge lists), so problems in those items and
 * across sections show once the list is short enough.
 * parseSettings wraps this with readable messages; to use the schema directly
 * with the same messages, pass `{ error: settingsErrorMap }`.
 */
export const TableSettingsSchema = SettingsObject.superRefine(checkAcrossSections);

export type TableSettings = z.output<typeof TableSettingsSchema>;
export type BlindLevel = z.output<typeof BlindLevelSchema>;
export type RotationStep = z.output<typeof RotationStepSchema>;
export type ChoiceGame = z.output<typeof ChoiceGameSchema>;
export type DealersChoiceSettings = z.output<typeof DealersChoiceSchema>;
