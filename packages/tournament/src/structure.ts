// Blind structures (TRN-11, TRN-12, TRN-15): level and break rows,
// validation, built-in presets, a generator from a target duration, and the
// pure clock lookup that says which row is live after some elapsed play time.

import { hasUnstorableText, isId } from './text';
import type { TableRules, TournamentSettings } from './types';

export type AnteType = 'none' | 'per-player' | 'big-blind';

/** Fixed-limit and stud betting amounts, for levels that play those games. */
export interface LimitBets {
  smallBet: number;
  bigBet: number;
  /** Stud bring-in. */
  bringIn?: number;
}

export interface LevelRow {
  kind: 'level';
  sb: number;
  bb: number;
  /** Per-player ante, or the single big-blind ante, depending on anteType. 0 when anteType is 'none'. */
  ante: number;
  anteType: AnteType;
  minutes: number;
  /** Game played this level in a mixed rotation; omitted means the tournament's game. */
  gameId?: string;
  /** Needed only when this level's game is fixed limit or stud. */
  limit?: LimitBets;
  /** Rebuys allowed during this level. */
  rebuy?: boolean;
}

export interface BreakRow {
  kind: 'break';
  minutes: number;
  /** Add-ons are offered during this break. */
  addOn?: boolean;
}

export type StructureRow = LevelRow | BreakRow;

export interface StructureIssues {
  errors: string[];
  warnings: string[];
}

export const MAX_LEVELS = 100;
export const MIN_ROW_MINUTES = 1;
export const MAX_ROW_MINUTES = 240;
/** Largest chip amount in any setting, the same as the engine's MAX_CHIPS (this package does not depend on the engine). */
export const MAX_CHIPS = 1_000_000_000_000;

const ANTE_TYPES: readonly AnteType[] = ['none', 'per-player', 'big-blind'];
const isChips = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_CHIPS;

/**
 * Checks a structure. Errors block saving; warnings are shown to the host.
 * `maxRebuys` > 0 requires at least one rebuy level.
 */
export function validateStructure(rows: StructureRow[], opts: { maxRebuys?: number } = {}): StructureIssues {
  if (!Array.isArray(rows) || !rows.every((r) => typeof r === 'object' && r !== null))
    return { errors: ['The structure must be a list of levels and breaks'], warnings: [] };
  const errors: string[] = [];
  const warnings: string[] = [];
  if (hasUnstorableText(rows)) errors.push('The structure contains characters that cannot be saved');
  const levels = rows.filter((r): r is LevelRow => r.kind === 'level');
  if (!levels.length) errors.push('The structure needs at least one level');
  if (levels.length > MAX_LEVELS) errors.push(`At most ${MAX_LEVELS} levels`);

  let levelNo = 0;
  let prev: LevelRow | undefined;
  rows.forEach((row, i) => {
    if (row.kind !== 'level' && row.kind !== 'break') {
      errors.push(`Row ${i + 1}: must be a level or a break`);
      return;
    }
    const label = row.kind === 'level' ? `Level ${++levelNo}` : `Break after level ${levelNo}`;
    if (!Number.isInteger(row.minutes) || row.minutes < MIN_ROW_MINUTES || row.minutes > MAX_ROW_MINUTES)
      errors.push(`${label}: length must be ${MIN_ROW_MINUTES}-${MAX_ROW_MINUTES} minutes`);
    if (row.kind === 'break') {
      if (i === 0) errors.push('A break cannot be first');
      if (i === rows.length - 1) errors.push('A break cannot be last');
      if (rows[i - 1]?.kind === 'break') errors.push(`${label}: two breaks in a row`);
      return;
    }
    if (!ANTE_TYPES.includes(row.anteType)) errors.push(`${label}: unknown ante type`);
    if (row.gameId !== undefined && !isId(row.gameId)) errors.push(`${label}: game must be a game id`);
    if (![row.sb, row.bb, row.ante].every(isChips)) {
      errors.push(`${label}: blinds and ante must be whole chip amounts`);
      return;
    }
    if (row.bb <= 0) errors.push(`${label}: big blind must be above 0`);
    if (row.sb > row.bb) errors.push(`${label}: small blind is larger than the big blind`);
    if (row.anteType === 'none' && row.ante > 0) errors.push(`${label}: ante set but ante type is none`);
    if (row.anteType !== 'none' && row.ante <= 0) errors.push(`${label}: ante type set but ante is 0`);
    if (row.ante > row.bb) warnings.push(`${label}: ante is larger than the big blind`);
    if (row.limit) {
      const { smallBet, bigBet, bringIn } = row.limit;
      if (![smallBet, bigBet, bringIn ?? 0].every(isChips) || smallBet <= 0)
        errors.push(`${label}: limit bets must be whole chip amounts above 0`);
      else {
        if (bigBet < smallBet) errors.push(`${label}: big bet is smaller than the small bet`);
        if (bringIn !== undefined && bringIn > smallBet) errors.push(`${label}: bring-in is larger than the small bet`);
      }
    }
    if (prev && (row.bb < prev.bb || row.sb < prev.sb)) warnings.push(`${label}: blinds go down from the previous level`);
    prev = row;
  });

  if ((opts.maxRebuys ?? 0) > 0 && !levels.some((l) => l.rebuy))
    errors.push('Rebuys are on, but no level allows rebuys');
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Clock lookup

export interface ClockPosition {
  /** Index into the rows array. */
  rowIndex: number;
  row: StructureRow;
  /** 1-based number of the current level, or of the level just before a break. */
  levelNumber: number;
  onBreak: boolean;
  /** Blinds in force: the current level, or during a break the level that follows it. */
  level: LevelRow;
  /** Time left in the current row, or null when the last level runs on with no end. */
  msLeft: number | null;
  /** Time until the next break starts, or null when no break is ahead. */
  msToBreak: number | null;
  /** The next level row, if any. */
  nextLevel: LevelRow | null;
}

const MS_PER_MIN = 60_000;

/**
 * Where the clock stands after `elapsedMs` of running time (pauses excluded,
 * that is the runtime's job). The last level never ends.
 */
export function clockAt(rows: StructureRow[], elapsedMs: number): ClockPosition {
  if (!rows.some((r) => r.kind === 'level')) throw new Error('Structure has no levels');
  let t = Math.max(0, elapsedMs);
  let i = 0;
  let levelNumber = 0;
  const lastLevelIndex = rows.map((r) => r.kind).lastIndexOf('level');
  for (; i < rows.length; i++) {
    if (rows[i].kind === 'level') levelNumber++;
    const len = rows[i].minutes * MS_PER_MIN;
    if (i >= lastLevelIndex || t < len) break;
    t -= len;
  }
  const row = rows[i];
  const onBreak = row.kind === 'break';
  const isLast = i === lastLevelIndex;
  const findLevel = (from: number) => rows.slice(from).find((r): r is LevelRow => r.kind === 'level') ?? null;
  const msLeft = isLast ? null : row.minutes * MS_PER_MIN - t;

  let msToBreak: number | null = null;
  if (!onBreak && !isLast) {
    let acc = msLeft!;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].kind === 'break') {
        msToBreak = acc;
        break;
      }
      acc += rows[j].minutes * MS_PER_MIN;
    }
  }
  return {
    rowIndex: i,
    row,
    levelNumber,
    onBreak,
    level: onBreak ? findLevel(i + 1)! : (row as LevelRow),
    msLeft,
    msToBreak,
    nextLevel: findLevel(i + 1),
  };
}

/** Elapsed running time at which row `rowIndex` begins. */
export function rowStartMs(rows: StructureRow[], rowIndex: number): number {
  return rows.slice(0, rowIndex).reduce((ms, r) => ms + r.minutes * MS_PER_MIN, 0);
}

/** Elapsed running time at which level number `levelNumber` (1-based) ends, or null for the last level. */
export function levelEndMs(rows: StructureRow[], levelNumber: number): number | null {
  let n = 0;
  const lastLevelIndex = rows.map((r) => r.kind).lastIndexOf('level');
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'level' && ++n === levelNumber) return i === lastLevelIndex ? null : rowStartMs(rows, i + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Presets and generation

/** Small-blind mantissas; big blinds are always twice the small blind. */
const SB_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const ANTE_STEPS = [1, 2, 2.5, 3, 4, 5, 6, 8];

/** Ascending integer values from a mantissa list, e.g. 1, 2, 3, 4, 5, 6, 8, 10, 15, ... */
function niceLadder(steps: number[]): (minimum: number) => number {
  return (minimum) => {
    for (let exp = 0; ; exp++) {
      for (const m of steps) {
        const v = Math.round(m * 10 ** exp);
        if (Number.isInteger(m * 10 ** exp) && v >= minimum) return v;
      }
    }
  };
}
const nextSb = niceLadder(SB_STEPS);
const nextAnte = niceLadder(ANTE_STEPS);

/** Nearest ladder value to `v` (at least 1). */
function nearestNice(v: number, next: (min: number) => number): number {
  const above = next(Math.max(1, Math.ceil(v)));
  let below = 1;
  for (let x = 1; x <= v; x = next(x + 1)) below = x;
  return v - below <= above - v ? below : above;
}

export type PresetName = 'hyper' | 'turbo' | 'regular' | 'deep';

export interface PresetSpec {
  /** Starting stack in big blinds at level 1. */
  depthBB: number;
  levelMinutes: number;
  /** Ladder steps the small blind climbs each level. */
  stepsPerLevel: number;
  /** Insert a break after every N levels; 0 for none. */
  breakEvery: number;
  breakMinutes: number;
  /** First level (1-based) with an ante. */
  anteFromLevel: number;
}

export const PRESETS: Record<PresetName, PresetSpec> = {
  hyper: { depthBB: 25, levelMinutes: 4, stepsPerLevel: 2, breakEvery: 0, breakMinutes: 0, anteFromLevel: 3 },
  turbo: { depthBB: 50, levelMinutes: 8, stepsPerLevel: 1, breakEvery: 8, breakMinutes: 5, anteFromLevel: 4 },
  regular: { depthBB: 100, levelMinutes: 15, stepsPerLevel: 1, breakEvery: 6, breakMinutes: 10, anteFromLevel: 5 },
  deep: { depthBB: 200, levelMinutes: 20, stepsPerLevel: 1, breakEvery: 6, breakMinutes: 10, anteFromLevel: 5 },
};

export interface BuildOptions {
  startingStack: number;
  /** Used to decide how many levels to generate. Default 20. */
  expectedEntrants?: number;
  /** Default 'per-player'. */
  anteType?: AnteType;
  /** Mark every level up to and including this one as a rebuy level. */
  rebuyThroughLevel?: number;
  /** Mark the first break as an add-on break. */
  addOnAtFirstBreak?: boolean;
}

/** Builds a structure from a spec. Levels run until the big blind reaches a tenth of the chips in play. */
export function buildStructure(spec: PresetSpec, opts: BuildOptions): StructureRow[] {
  const { startingStack } = opts;
  if (!Number.isSafeInteger(startingStack) || startingStack < 2) throw new Error('startingStack must be a whole number of at least 2');
  const entrants = Math.max(2, opts.expectedEntrants ?? 20);
  const anteType = opts.anteType ?? 'per-player';
  const endBB = (startingStack * entrants) / 10;

  const rows: StructureRow[] = [];
  let sb = nearestNice(startingStack / spec.depthBB / 2, nextSb);
  let firstBreak = true;
  for (let level = 1; level <= MAX_LEVELS; level++) {
    const bb = sb * 2;
    let ante = 0;
    if (anteType !== 'none' && level >= spec.anteFromLevel) {
      ante = anteType === 'big-blind' ? bb : Math.min(bb, nearestNice(bb / 8, nextAnte));
    }
    rows.push({
      kind: 'level',
      sb,
      bb,
      ante,
      anteType: ante ? anteType : 'none',
      minutes: spec.levelMinutes,
      ...(opts.rebuyThroughLevel && level <= opts.rebuyThroughLevel ? { rebuy: true } : {}),
    });
    let next = sb;
    for (let s = 0; s < spec.stepsPerLevel; s++) next = nextSb(next + 1);
    // Stop before the blinds pass the chip limit, so huge stacks still get a valid preset.
    if (bb >= endBB || next * 2 > MAX_CHIPS) break;
    if (spec.breakEvery && level % spec.breakEvery === 0) {
      rows.push({ kind: 'break', minutes: spec.breakMinutes, ...(opts.addOnAtFirstBreak && firstBreak ? { addOn: true } : {}) });
      firstBreak = false;
    }
    sb = next;
  }
  return rows;
}

export function presetStructure(name: PresetName, opts: BuildOptions): StructureRow[] {
  return buildStructure(PRESETS[name], opts);
}

/**
 * The RSDP group's own tournament blinds, from the structure they play on
 * PokerNow: 28 levels of 8 minutes, no antes and no breaks. The last level
 * runs until the end. Starts at 63,000 chips (RSDP_STACK).
 */
const RSDP_BLINDS: [sb: number, bb: number][] = [
  [100, 200], [200, 300], [200, 400], [300, 500], [300, 600], [400, 800], [500, 1000],
  [600, 1200], [800, 1600], [1000, 2000], [1200, 2400], [1500, 3000], [2000, 4000], [2500, 5000],
  [3000, 6000], [4000, 8000], [5000, 10000], [6000, 12000], [8000, 16000], [10000, 20000], [12000, 24000],
  [15000, 30000], [20000, 40000], [25000, 50000], [30000, 60000], [40000, 80000], [50000, 100000], [60000, 120000],
];
export const RSDP_STACK = 63_000;
export const RSDP_LEVEL_MINUTES = 8;
/** The RSDP table rules: 10-second decisions, a 20-second time bank refilled every 30 hands, no rabbit hunting (tournaments never have straddles). */
export const RSDP_TABLE_RULES: Readonly<TableRules> = Object.freeze({ decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30, rabbitHunt: false });
/**
 * What every tournament table did before events had their own table rules
 * (31 Oct 2026): a 30-second clock, a 30-second time bank refilled every 10
 * hands, and rabbit hunting. Events saved before then, and series and Sit &
 * Gos carried on from them, still play this way until a host changes them.
 */
export const LEGACY_TABLE_RULES: Readonly<TableRules> = Object.freeze({ decisionSeconds: 30, timeBankSeconds: 30, timeBankRefillHands: 10, rabbitHunt: true });

/** The rules this event's tables play by. */
export const tableRulesOf = (s: Pick<TournamentSettings, 'tableRules'>): TableRules => ({ ...(s.tableRules ?? LEGACY_TABLE_RULES) });

/** The RSDP blind levels. Levels up to `rebuyThroughLevel` allow rebuys. */
export function rsdpStructure(opts: Pick<BuildOptions, 'rebuyThroughLevel'> = {}): StructureRow[] {
  return RSDP_BLINDS.map(([sb, bb], i) => ({
    kind: 'level',
    sb,
    bb,
    ante: 0,
    anteType: 'none',
    minutes: RSDP_LEVEL_MINUTES,
    ...(opts.rebuyThroughLevel && i < opts.rebuyThroughLevel ? { rebuy: true } : {}),
  }));
}

/**
 * Whether these are the RSDP blind levels: its 28 blinds in order, each 8
 * minutes, with no antes. Breaks, rebuy marks and a level's own game or limit
 * bets don't count, so a host can add those and still be on the RSDP levels.
 */
export function isRsdpLevels(rows: StructureRow[]): boolean {
  const levels = rows.filter((r): r is LevelRow => r.kind === 'level');
  return (
    levels.length === RSDP_BLINDS.length &&
    levels.every((l, i) => l.sb === RSDP_BLINDS[i][0] && l.bb === RSDP_BLINDS[i][1] && l.anteType === 'none' && l.ante === 0 && l.minutes === RSDP_LEVEL_MINUTES)
  );
}

/**
 * Generates a structure aimed at finishing in about `targetMinutes` (TRN-15
 * improvement). It uses the regular ladder and stretches or shrinks level
 * length so the last generated level starts near the target time. Breaks of
 * 10 minutes are added about every 90 minutes when the target is over 2 hours.
 */
export function generateStructure(opts: BuildOptions & { targetMinutes: number; depthBB?: number }): StructureRow[] {
  const depthBB = opts.depthBB ?? 100;
  const probe = buildStructure({ ...PRESETS.regular, depthBB, breakEvery: 0, levelMinutes: 1 }, opts);
  const levels = probe.length;
  const withBreaks = opts.targetMinutes > 120;
  // Solve for level length, then place a break roughly every 90 minutes of play.
  let minutes = Math.max(MIN_ROW_MINUTES, Math.round(opts.targetMinutes / Math.max(1, levels - 1)));
  let breakEvery = withBreaks ? Math.max(2, Math.round(90 / minutes)) : 0;
  if (withBreaks) {
    const breakCount = Math.floor((levels - 1) / breakEvery);
    minutes = Math.max(MIN_ROW_MINUTES, Math.round((opts.targetMinutes - breakCount * 10) / Math.max(1, levels - 1)));
    breakEvery = Math.max(2, Math.round(90 / minutes));
  }
  minutes = Math.min(MAX_ROW_MINUTES, minutes);
  return buildStructure({ ...PRESETS.regular, depthBB, levelMinutes: minutes, breakEvery, breakMinutes: 10 }, opts);
}

/** Total scheduled minutes up to the start of the last level (the last level has no end). */
export function plannedMinutes(rows: StructureRow[]): number {
  const last = rows.map((r) => r.kind).lastIndexOf('level');
  return rowStartMs(rows, last) / MS_PER_MIN;
}
