// The tournament director: a pure state machine over a whole tournament.
//
//   createTournament(...)            -> TournamentState
//   apply(state, command, now)       -> { state, events }
//   tick(state, now)                 -> { state, events }
//   nextWakeAt(state)                -> when the server must call tick next
//   tableGate(state, tableId, now)   -> may this table deal its next hand?
//   levelFor(state, tableId)         -> game and stakes for that next hand
//   standings(state)                 -> places, stacks and prizes
//
// The server checks that a command's `by` may act as host before applying it.
// Invalid commands throw DirectorError and leave the state unchanged. After
// every apply or tick the server re-reads nextWakeAt. Level changes, breaks,
// scheduled starts and offer expiries only take effect in tick, so the server
// must wake at nextWakeAt (a 1 s tick is a fine fallback).

import { handOver, RoleError, withCoHost, withoutCoHost } from '@rsdp/engine/roles';
import {
  checkInActive,
  checkInGroupOf,
  checkInScheduledAt,
  drawCodes,
  groupOpensAt,
  isCodeFormat,
  MAX_INVITE_CODES,
  MAX_INVITES_PER_BATCH,
  MAX_REGISTRATION_LIST,
  mayCheckIn,
  normalizeCode,
  readyEntries,
  splitBounty,
  usableCode,
  validateFormats,
} from './formats';
import { MAX_PRIZE_AMOUNT, placePrizes, prizePool, prizesForPlaces, rangeFor, validatePayoutStructure, type PrizeMoney } from './payouts';
import { nextOccurrence, validateSchedule } from './recurrence';
import { drawSeats, nextBalanceStep, seatToFill, seatToMove, type TableLoad } from './seating';
import { clockAt, levelEndMs, MAX_CHIPS, presetStructure, rowStartMs, validateStructure, type LevelRow, type StructureRow } from './structure';
import { cleanText, hasUnstorableText, isId } from './text';
import {
  STATE_VERSION,
  type Command,
  type DirectorEvent,
  type Entry,
  type EntryId,
  type Gate,
  type HandResult,
  type LevelStakes,
  type PendingRequest,
  type PlayerId,
  type RequestKind,
  type Result,
  type SeatInfo,
  type Standing,
  type TableId,
  type TableRules,
  type TableState,
  type TournamentSettings,
  type EliminationGroup,
  type TournamentState,
} from './types';

export class DirectorError extends Error {}

const fail = (message: string): never => {
  throw new DirectorError(message);
};

// ---------------------------------------------------------------------------
// Settings

export function defaultSettings(overrides: Partial<TournamentSettings> = {}): TournamentSettings {
  const startingStack = overrides.startingStack ?? 10_000;
  return {
    name: 'Tournament',
    start: { kind: 'manual' },
    games: ['nlhe'],
    structure: presetStructure('regular', { startingStack }),
    startingStack,
    seatsPerTable: 9,
    maxEntrants: 600,
    seatLeadSeconds: 60,
    graceMinutes: 15,
    registrationApproval: false,
    lateRegistration: { enabled: true, throughLevel: 4 },
    reEntry: { enabled: false, throughLevel: null, max: null, approval: false },
    rebuy: { max: 0, chips: startingStack, approval: false, offerSeconds: 15 },
    addOn: { max: 0, chips: startingStack, approval: false },
    allowQuit: false,
    handForHand: true,
    ...overrides,
  };
}

const NAME_MAX = 40;
/**
 * Longest settings, as JSON: what a saved structure may hold, so any tournament that can be made can be saved
 * too. Real ones are a few kilobytes; a big preset payout table takes most of the rest.
 */
export const MAX_SETTINGS_LENGTH = 64 * 1024;
/** The end of year 9999: later start times cannot be shown, stored in Postgres, or handled by the time-zone maths. */
const MAX_DATE_MS = 253_402_300_799_999;
const CHIPS_LABEL = MAX_CHIPS.toLocaleString('en-US');
/** Most chips the whole field may hold, so any stack or pot the engine adds up stays a safe integer. */
export const MAX_CHIPS_IN_PLAY = Math.floor(Number.MAX_SAFE_INTEGER / 4);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isWhole = (n: unknown, min: number, max: number) => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
/** A level number or count of at least 1, or null for no limit. */
const isLimit = (n: unknown) => n === null || isWhole(n, 1, Number.MAX_SAFE_INTEGER);

/** Every setting, so unknown keys never reach the saved state. */
const SETTINGS_KEYS: Record<keyof TournamentSettings, true> = {
  name: true,
  start: true,
  games: true,
  stopRotationAtLevel: true,
  structure: true,
  startingStack: true,
  seatsPerTable: true,
  maxEntrants: true,
  seatLeadSeconds: true,
  graceMinutes: true,
  registrationApproval: true,
  lateRegistration: true,
  reEntry: true,
  rebuy: true,
  addOn: true,
  allowQuit: true,
  payouts: true,
  handForHand: true,
  bounty: true,
  invites: true,
  checkIn: true,
  season: true,
  tableRules: true,
};

/**
 * An object with only the given keys, in its own order. Anything that is not an object is left for validation
 * to refuse.
 */
function only<T>(value: T, keys: readonly string[]): T {
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => keys.includes(k))) as T;
}

const onlyEach = <T>(list: T, clean: (item: unknown) => unknown): T => (Array.isArray(list) ? (list.map(clean) as T) : list);

const START_KEYS: Record<string, readonly string[]> = {
  manual: ['kind'],
  scheduled: ['kind', 'startAt', 'schedule'],
  sng: ['kind', 'playersNeeded', 'startDelaySeconds', 'autoSpawn'],
};

/** A structure row with only the keys a level or a break has. */
function cleanRow(row: unknown): unknown {
  if (!isObject(row)) return row;
  if (row.kind === 'break') return only(row, ['kind', 'minutes', 'addOn']);
  if (row.kind !== 'level') return row;
  const out = only(row, ['kind', 'sb', 'bb', 'ante', 'anteType', 'minutes', 'gameId', 'limit', 'rebuy']);
  if (isObject(out.limit)) out.limit = only(out.limit, ['smallBet', 'bigBet', 'bringIn']);
  return out;
}

/** Levels and breaks with nothing but their own fields, so no junk rides along to every table. */
const cleanStructure = (rows: StructureRow[]): StructureRow[] => onlyEach(rows, cleanRow);

/** Only the known settings, nested ones included, with the free text cleaned (names are cut by whole characters). */
function cleanSettings(raw: Partial<TournamentSettings>): Partial<TournamentSettings> {
  const out: Partial<TournamentSettings> = Object.fromEntries(Object.entries(raw ?? {}).filter(([k]) => Object.hasOwn(SETTINGS_KEYS, k)));
  if (isObject(out.start) && typeof out.start.kind === 'string' && Object.hasOwn(START_KEYS, out.start.kind)) {
    out.start = only(out.start, START_KEYS[out.start.kind]);
    if (out.start.kind === 'scheduled' && isObject(out.start.schedule)) {
      const schedule = only(out.start.schedule, ['timeZone', 'startDate', 'time', 'repeat', 'until']);
      if (isObject(schedule.repeat)) schedule.repeat = only(schedule.repeat, ['freq', 'interval', 'weekdays', 'monthDay', 'nth', 'weekday']);
      out.start = { ...out.start, schedule };
    }
  }
  if ('structure' in out) out.structure = cleanStructure(out.structure!);
  if ('lateRegistration' in out) out.lateRegistration = only(out.lateRegistration!, ['enabled', 'throughLevel']);
  if ('reEntry' in out) out.reEntry = only(out.reEntry!, ['enabled', 'throughLevel', 'max', 'approval']);
  if ('rebuy' in out) out.rebuy = only(out.rebuy!, ['max', 'chips', 'approval', 'offerSeconds']);
  if ('addOn' in out) out.addOn = only(out.addOn!, ['max', 'chips', 'approval']);
  if ('bounty' in out) out.bounty = only(out.bounty, ['amount', 'progressivePercent']);
  if ('invites' in out) out.invites = only(out.invites, ['required', 'autoApprove']);
  if (isObject(out.checkIn)) {
    out.checkIn = only(out.checkIn, ['groups', 'opensMinutesBefore']);
    out.checkIn.groups = onlyEach(out.checkIn.groups, (g) => only(g, ['firstN', 'waitMinutes']));
  }
  if (isObject(out.payouts)) {
    out.payouts = only(out.payouts, ['structure', 'money']);
    out.payouts.money = only(out.payouts.money, ['buyIn', 'rebuy', 'addOn', 'feePercent', 'added']);
    if (isObject(out.payouts.structure)) {
      const structure = only(out.payouts.structure, ['name', 'ranges', 'roundTo']);
      structure.ranges = onlyEach(structure.ranges, (r) => only(r, ['minEntries', 'maxEntries', 'percents']));
      out.payouts.structure = structure;
    }
  }
  if (typeof out.name === 'string') out.name = cleanText(out.name);
  if (isObject(out.season)) {
    const { id, name } = out.season;
    out.season = { id, name: typeof name === 'string' ? Array.from(cleanText(name)).slice(0, NAME_MAX).join('') : name };
  }
  const payoutName = out.payouts?.structure?.name;
  if (typeof payoutName === 'string') {
    const name = Array.from(cleanText(payoutName)).slice(0, NAME_MAX).join('');
    out.payouts = { ...out.payouts!, structure: { ...out.payouts!.structure, name } };
  }
  // Only the four rules are kept, so nothing else rides along to every table.
  if (isObject(out.tableRules)) {
    const { decisionSeconds, timeBankSeconds, timeBankRefillHands, rabbitHunt } = out.tableRules;
    out.tableRules = { decisionSeconds, timeBankSeconds, timeBankRefillHands, rabbitHunt };
  }
  return out;
}

export function validateSettings(s: TournamentSettings): string[] {
  if (!isObject(s)) return ['The settings are missing'];
  const missing = (['start', 'lateRegistration', 'reEntry', 'rebuy', 'addOn'] as const).filter((k) => !isObject(s[k]));
  if (missing.length) return [`Missing settings: ${missing.join(', ')}`];
  const { start, lateRegistration: late, reEntry, rebuy, addOn } = s;
  const errors: string[] = [];
  const nameLength = typeof s.name === 'string' ? Array.from(cleanText(s.name)).length : 0;
  if (nameLength < 1 || nameLength > NAME_MAX) errors.push(`Name must be 1-${NAME_MAX} characters`);
  if (!isWhole(s.seatsPerTable, 2, 10)) errors.push('Seats per table must be 2-10');
  if (!isWhole(s.maxEntrants, 2, 600)) errors.push('Max entrants must be 2-600');
  if (!isWhole(s.startingStack, 1, MAX_CHIPS)) errors.push(`Starting stack must be a whole number from 1 to ${CHIPS_LABEL}`);
  if (!Array.isArray(s.games) || !s.games.length) errors.push('Pick at least one game');
  else if (!s.games.every(isId)) errors.push('Every game must be a game id');
  if (s.stopRotationAtLevel != null && !isLimit(s.stopRotationAtLevel)) errors.push('Rotation must stop at level 1 or later');
  errors.push(...validateStructure(s.structure, { maxRebuys: rebuy.max }).errors);
  if (!isWhole(rebuy.max, 0, Number.MAX_SAFE_INTEGER)) errors.push('Rebuys per player must be a whole number');
  // Checked even while off: an open rebuy offer or a pending request still pays these out.
  if (!isWhole(rebuy.chips, 1, MAX_CHIPS)) errors.push(`Rebuy chips must be a whole number from 1 to ${CHIPS_LABEL}`);
  if (!isWhole(addOn.chips, 1, MAX_CHIPS)) errors.push(`Add-on chips must be a whole number from 1 to ${CHIPS_LABEL}`);
  if (!isWhole(rebuy.offerSeconds, 1, 300)) errors.push('Rebuy offer window must be 1-300 seconds');
  if (!isWhole(addOn.max, 0, Number.MAX_SAFE_INTEGER)) errors.push('Add-ons per player must be a whole number');
  if (addOn.max > 0 && (!Array.isArray(s.structure) || !s.structure.some((r) => r?.kind === 'break' && r.addOn)))
    errors.push('Add-ons are on, but no break offers them');
  // All the chips one entry can be given, so stacks stay safe integers in the engine.
  const extra = (b: { max: number; chips: number }) => (b.max > 0 && isWhole(b.max, 0, Number.MAX_SAFE_INTEGER) && isWhole(b.chips, 1, MAX_CHIPS) ? b.max * b.chips : 0);
  if (isWhole(s.startingStack, 1, MAX_CHIPS) && s.startingStack + extra(rebuy) + extra(addOn) > MAX_CHIPS)
    errors.push(`The starting stack plus every rebuy and add-on must be at most ${CHIPS_LABEL} chips`);
  if (!isWhole(s.graceMinutes, 0, 24 * 60)) errors.push('Grace period must be 0-1440 minutes');
  if (!isWhole(s.seatLeadSeconds, 0, 3600)) errors.push('Seating lead must be 0-3600 seconds');
  if (!isLimit(late.throughLevel)) errors.push('Late registration must close at level 1 or later');
  if (!isLimit(reEntry.throughLevel)) errors.push('Re-entry must close at level 1 or later');
  if (!isLimit(reEntry.max)) errors.push('Re-entries per player must be at least 1');
  const flags = [s.registrationApproval, s.allowQuit, s.handForHand, late.enabled, reEntry.enabled, reEntry.approval, rebuy.approval, addOn.approval];
  if (start.kind === 'sng') flags.push(start.autoSpawn);
  if (!flags.every((f) => typeof f === 'boolean')) errors.push('On/off settings must be true or false');
  if (start.kind === 'sng') {
    const { playersNeeded, startDelaySeconds } = start;
    if (!isWhole(playersNeeded, 2, s.maxEntrants)) errors.push('Players needed must be 2 up to max entrants');
    if (!isWhole(startDelaySeconds, 0, 900)) errors.push('Start delay must be 0-900 seconds');
  } else if (start.kind === 'scheduled') {
    if (!isWhole(start.startAt, 0, MAX_DATE_MS)) errors.push('Pick a start time');
    if (start.schedule != null) errors.push(...validateSchedule(start.schedule));
  } else if (start.kind !== 'manual') errors.push('Pick how the tournament starts');
  if (s.payouts) {
    errors.push(...validatePayoutStructure(s.payouts.structure, s.maxEntrants));
    // Standings read these on every finish, so they must be usable numbers.
    const m: Partial<PrizeMoney> = isObject(s.payouts.money) ? s.payouts.money : {};
    const amounts = [m.buyIn, m.rebuy ?? 0, m.addOn ?? 0, m.added ?? 0];
    if (!amounts.every((n) => isWhole(n, 0, Number.MAX_SAFE_INTEGER))) errors.push('Prize money must be whole amounts of 0 or more');
    else if (amounts.some((n) => n! > MAX_PRIZE_AMOUNT)) errors.push('Prize money amounts must be at most $100,000 each');
    if (m.feePercent !== undefined && !(typeof m.feePercent === 'number' && m.feePercent >= 0 && m.feePercent <= 100)) errors.push('The fee must be 0-100%');
  }
  if (s.tableRules !== undefined) errors.push(...validateTableRules(s.tableRules));
  errors.push(...validateFormats(s));
  // The structure checks its own rows.
  if (hasUnstorableText({ ...s, structure: null })) errors.push('Settings contain characters that cannot be saved');
  if (JSON.stringify(s).length > MAX_SETTINGS_LENGTH) errors.push('These settings are too big to keep: use fewer payout ranges or blind levels');
  return errors;
}

/** What is wrong with an event's table rules (clock, time bank, rabbit hunting), if anything. */
export function validateTableRules(rules: unknown): string[] {
  const t: Partial<TableRules> = isObject(rules) ? rules : {};
  const errors: string[] = [];
  if (!(t.decisionSeconds === 0 || isWhole(t.decisionSeconds, 5, 600))) errors.push('Decision clock must be 0 (no clock) or 5-600 seconds');
  if (!isWhole(t.timeBankSeconds, 0, 300)) errors.push('Time bank must be 0-300 seconds');
  if (!isWhole(t.timeBankRefillHands, 0, 200)) errors.push('Time bank refill must be 0-200 hands');
  if (typeof t.rabbitHunt !== 'boolean') errors.push('On/off settings must be true or false');
  return errors;
}

export interface CreateInput {
  id: string;
  hostId: PlayerId;
  settings: TournamentSettings;
  now: number;
  /** Any 32-bit integer; the server should pick it with a CSPRNG. */
  seed: number;
}

export function createTournament({ id, hostId, settings: raw, now, seed }: CreateInput): TournamentState {
  const settings = cleanSettings(raw) as TournamentSettings;
  const errors = validateSettings(settings);
  if (settings.start?.kind === 'scheduled' && settings.start.startAt <= now) errors.push('The start time has already passed');
  if (errors.length) fail(errors.join('; '));
  // A new season is named after the event that starts it.
  if (settings.season?.id === '') settings.season = { ...settings.season, id };
  return {
    version: STATE_VERSION,
    id,
    hostId,
    settings: structuredClone(settings),
    status: 'registering',
    createdAt: now,
    startAt: settings.start.kind === 'scheduled' ? settings.start.startAt : null,
    graceUntil: null,
    startedAt: null,
    finishedAt: null,
    clock: { elapsedMs: 0, runningSince: null, rowIndex: 0 },
    entries: [],
    tables: [],
    requests: [],
    eliminations: [],
    handForHand: { active: false, round: 0 },
    counters: { entry: 0, table: 0, request: 0 },
    rng: seed >>> 0,
  };
}

// ---------------------------------------------------------------------------
// Queries

const ALIVE = new Set(['registered', 'seated', 'rebuy-offer']);
const isAlive = (e: Entry) => ALIVE.has(e.status);

export const aliveEntries = (s: TournamentState) => s.entries.filter(isAlive);

function activeEntry(s: TournamentState, playerId: PlayerId): Entry | undefined {
  return s.entries.find((e) => e.playerId === playerId && isAlive(e));
}

function latestEntry(s: TournamentState, playerId: PlayerId): Entry | undefined {
  return s.entries.filter((e) => e.playerId === playerId).sort((a, b) => b.entryNo - a.entryNo)[0];
}

/** Entries that count toward max entrants and finishing places (re-entries replace the busted entry). */
const rankedEntries = (s: TournamentState) => s.entries.filter((e) => !e.supersededBy);
/** A player who asked to rebuy in time, with approval on: the offer waits for the host's answer. */
const rebuyAsked = (s: TournamentState, e: Entry) => s.requests.some((r) => r.kind === 'rebuy' && r.entryId === e.id);

function table(s: TournamentState, tableId: TableId): TableState {
  return s.tables.find((t) => t.id === tableId) ?? fail(`Unknown table ${tableId}`);
}

function entry(s: TournamentState, id: EntryId): Entry {
  return s.entries.find((e) => e.id === id)!;
}

const tablePlayers = (s: TournamentState, t: TableState) => t.seats.filter((x): x is EntryId => x !== null).map((id) => entry(s, id));

function elapsed(s: TournamentState, now: number): number {
  return s.clock.elapsedMs + (s.clock.runningSince === null ? 0 : now - s.clock.runningSince);
}

/** Where the clock stood at the last tick. */
function position(s: TournamentState) {
  return clockAt(s.settings.structure, rowStartMs(s.settings.structure, s.clock.rowIndex));
}

const started = (s: TournamentState) => s.status === 'running' || s.status === 'paused';

/** Open while the current level is at most `through` (a break after `through` counts as closed). */
function withinLevel(s: TournamentState, through: number | null): boolean {
  if (through === null || !started(s)) return true;
  const p = position(s);
  return p.levelNumber < through || (p.levelNumber === through && !p.onBreak);
}

/** Room on the list: with check-in it can run past max entrants, since seats go to whoever checks in first. */
const hasRoom = (s: TournamentState) =>
  checkInActive(s) ? aliveEntries(s).length < MAX_REGISTRATION_LIST : rankedEntries(s).length < s.settings.maxEntrants;

export function registrationOpen(s: TournamentState): boolean {
  if (!hasRoom(s)) return false;
  if (s.status === 'registering' || s.status === 'seating') return true;
  if (!started(s)) return false;
  return s.settings.lateRegistration.enabled && withinLevel(s, s.settings.lateRegistration.throughLevel);
}

export function rebuysOpen(s: TournamentState): boolean {
  if (s.settings.rebuy.max <= 0 || !started(s)) return false;
  const rows = s.settings.structure;
  const i = s.clock.rowIndex;
  const row = rows[i];
  if (row.kind === 'level') return !!row.rebuy;
  const before = rows.slice(0, i).reverse().find((r): r is LevelRow => r.kind === 'level');
  return !!before?.rebuy;
}

export function addOnsOpen(s: TournamentState): boolean {
  const row = s.settings.structure[s.clock.rowIndex];
  return s.settings.addOn.max > 0 && started(s) && row.kind === 'break' && !!row.addOn;
}

export function reEntryOpen(s: TournamentState): boolean {
  return s.settings.reEntry.enabled && started(s) && withinLevel(s, s.settings.reEntry.throughLevel);
}

/** With re-entry open to the end, how long the last player left waits after the latest player went out. */
const RE_ENTRY_WAIT_MS = 60_000;

/**
 * Until when a lone survivor waits for a busted player to re-enter, or null when nobody can. With a closing level it
 * waits until re-entry closes (Infinity: the clock ends the wait). Open to the end, it waits RE_ENTRY_WAIT_MS after the
 * latest player went out, and for as long as a re-entry waits for the host, so an event nobody comes back to still ends.
 * Closing at the last level or later is open to the end, since the last level never ends.
 */
function reEntryWaitEnds(s: TournamentState): number | null {
  const { throughLevel, max } = s.settings.reEntry;
  const canReEnter = s.entries.some((e) => e.status === 'busted' && !e.supersededBy && (max === null || e.entryNo - 1 < max));
  if (!reEntryOpen(s) || !canReEnter) return null;
  const closes = throughLevel !== null && levelEndMs(s.settings.structure, throughLevel) !== null;
  if (closes || s.requests.some((r) => r.kind === 're-entry')) return Infinity;
  return Math.max(...s.eliminations.map((g) => g.at)) + RE_ENTRY_WAIT_MS;
}

/** Places paid: re-entries count toward them, but only one entry per player can finish, so never more than that. */
export function paidPlaces(s: TournamentState): number {
  if (!s.settings.payouts) return 0;
  return Math.min(rangeFor(s.settings.payouts.structure, s.entries.length)?.percents.length ?? 0, rankedEntries(s).length);
}

/**
 * The prize for each finishing place, 1st first. Re-entries count towards the places paid, but only one entry per
 * player can finish: prizes for places nobody can reach go to 1st, like any other remainder, so the prizes still add
 * up to the pool.
 */
export function finishPrizes(s: TournamentState): number[] {
  if (!s.settings.payouts) return [];
  const prizes = placePrizes(currentPrizePool(s), s.settings.payouts.structure, s.entries.length);
  const reachable = rankedEntries(s).length;
  if (prizes.length > reachable && reachable > 0) prizes[0] += prizes.splice(reachable).reduce((a, b) => a + b, 0);
  return prizes;
}

export function currentPrizePool(s: TournamentState): number {
  if (!s.settings.payouts) return 0;
  const sum = (f: (e: Entry) => number) => s.entries.reduce((a, e) => a + f(e), 0);
  return prizePool(s.settings.payouts.money, { entries: s.entries.length, rebuys: sum((e) => e.rebuys), addOns: sum((e) => e.addOns) });
}

/**
 * Finishing places. Elimination groups are ranked from the bottom up in the
 * order they happened. Within a group, players at the same table are ordered
 * by their stack at the start of the hand (bigger places higher, equal stacks
 * tie); players at different tables with the same rank at their table tie
 * (hand-for-hand busts). Tied players share the best place of their block.
 */
function places(s: TournamentState): Map<EntryId, number> {
  const out = new Map<EntryId, number>();
  let next = rankedEntries(s).length;
  for (const group of s.eliminations) {
    const members = group.members.filter((m) => !entry(s, m.entryId).supersededBy);
    const tier = (m: (typeof members)[number]) =>
      new Set(members.filter((o) => o.tableId === m.tableId && o.startStack > m.startStack).map((o) => o.startStack)).size;
    const tiers = members.map(tier);
    const first = next - members.length + 1;
    members.forEach((m, i) => out.set(m.entryId, first + tiers.filter((t) => t < tiers[i]).length));
    next -= members.length;
  }
  return out;
}

export function standings(s: TournamentState): Standing[] {
  const placeOf = places(s);
  const prizeOf = prizesForPlaces(Object.fromEntries(placeOf), finishPrizes(s));
  // Rebuys, add-ons, bounties and knockouts follow the player through re-entries.
  const ofPlayer = (playerId: PlayerId, f: (e: Entry) => number) => s.entries.reduce((a, e) => a + (e.playerId === playerId ? f(e) : 0), 0);
  return s.entries
    .filter((e) => !e.supersededBy)
    .map((e) => ({
      entryId: e.id,
      playerId: e.playerId,
      displayName: e.displayName,
      entryNo: e.entryNo,
      place: placeOf.get(e.id) ?? null,
      stack: isAlive(e) ? e.stack : 0,
      rebuys: ofPlayer(e.playerId, (x) => x.rebuys),
      addOns: ofPlayer(e.playerId, (x) => x.addOns),
      prize: prizeOf[e.id] ?? 0,
      eliminatedBy: e.bust?.by ?? [],
      bounties: ofPlayer(e.playerId, (x) => x.bountiesWon ?? 0),
      knockouts: ofPlayer(e.playerId, (x) => x.knockouts ?? 0),
      bounty: isAlive(e) ? (e.bounty ?? 0) : 0,
    }))
    .sort((a, b) => (a.place ?? 0) - (b.place ?? 0) || b.stack - a.stack);
}

/** Two or more players with chips are seated at the table. */
const enoughToDeal = (s: TournamentState, t: TableState) => tablePlayers(s, t).filter((e) => e.status === 'seated' && e.stack > 0).length >= 2;

/** The table may still have a hand to play: counting a busted player who may yet rebuy, two or more could play. */
const mayDeal = (s: TournamentState, t: TableState) => tablePlayers(s, t).filter((e) => (e.status === 'seated' && e.stack > 0) || e.status === 'rebuy-offer').length >= 2;

/** May this table deal its next hand? */
export function tableGate(s: TournamentState, tableId: TableId, _now: number): Gate {
  if (s.status !== 'running') return 'hold';
  const t = s.tables.find((x) => x.id === tableId);
  if (!t) return 'hold';
  if (position(s).onBreak) return 'hold';
  const players = tablePlayers(s, t);
  if (players.some((e) => e.status === 'rebuy-offer')) return 'hold';
  if (!enoughToDeal(s, t)) return 'hold';
  if (s.handForHand.active && t.hfhPlayed >= s.handForHand.round) return 'hold';
  return 'deal';
}

/** Game and stakes for the next hand (during a break, the level after it). */
export function levelFor(s: TournamentState, _tableId: TableId): LevelStakes {
  const p = position(s);
  const level = p.level;
  const levelNumber = p.onBreak ? p.levelNumber + 1 : p.levelNumber;
  const { games, stopRotationAtLevel } = s.settings;
  const rotationLevel = stopRotationAtLevel ? Math.min(levelNumber, stopRotationAtLevel) : levelNumber;
  const gameId = level.gameId ?? games[(rotationLevel - 1) % games.length];
  const smallBet = level.limit?.smallBet ?? level.bb;
  return {
    levelNumber,
    gameId,
    sb: level.sb,
    bb: level.bb,
    ante: level.ante,
    anteType: level.anteType,
    smallBet,
    bigBet: level.limit?.bigBet ?? smallBet * 2,
    bringIn: level.limit?.bringIn ?? Math.max(1, Math.floor(smallBet / 3)),
  };
}

/** When the server must call tick next, or null when nothing is scheduled. */
export function nextWakeAt(s: TournamentState): number | null {
  const times: number[] = [];
  const { start } = s.settings;
  if (s.status === 'registering' && start.kind === 'scheduled' && s.startAt !== null) {
    if (s.graceUntil !== null) times.push(s.graceUntil);
    else if (readyEntries(s).length >= 2) times.push(s.startAt - s.settings.seatLeadSeconds * 1000);
    else times.push(s.startAt);
  }
  if (s.status === 'seating' && s.startAt !== null) times.push(s.startAt);
  if (s.status === 'registering' && s.settings.checkIn) {
    const open = s.checkIn?.groupsOpen ?? 0;
    const at = open === 0 ? checkInScheduledAt(s) : open < s.settings.checkIn.groups.length ? groupOpensAt(s, open) : null;
    if (at !== null) times.push(at);
  }
  if (started(s)) {
    for (const e of s.entries) if (e.status === 'rebuy-offer' && e.rebuyOfferExpiresAt !== undefined && !rebuyAsked(s, e)) times.push(e.rebuyOfferExpiresAt);
    // The last player left wins once nobody has re-entered in time. While something else holds them too (a rebuy
    // offer, a registration waiting for the host), that time passing changes nothing, so it is not a time to wake for.
    const alive = aliveEntries(s);
    const reEntryWait = alive.length === 1 && alive[0].status !== 'rebuy-offer' && !lateRegistrationHolds(s) ? reEntryWaitEnds(s) : null;
    if (reEntryWait !== null && Number.isFinite(reEntryWait)) times.push(reEntryWait);
    if (s.status === 'running' && s.clock.runningSince !== null) {
      const rows = s.settings.structure;
      const lastLevel = rows.map((r) => r.kind).lastIndexOf('level');
      if (s.clock.rowIndex < lastLevel) {
        times.push(s.clock.runningSince + rowStartMs(rows, s.clock.rowIndex + 1) - s.clock.elapsedMs);
      }
    }
  }
  return times.length ? Math.min(...times) : null;
}

/** Wall time at which a level ends, if the clock keeps running from now. */
export function levelEndsAt(s: TournamentState, levelNumber: number, now: number): number | null {
  const end = levelEndMs(s.settings.structure, levelNumber);
  return end === null ? null : now + end - elapsed(s, now);
}

// ---------------------------------------------------------------------------
// Mutations. Each runs on a private copy through a context.

interface Ctx {
  s: TournamentState;
  events: DirectorEvent[];
  now: number;
}

const emit = (c: Ctx, e: DirectorEvent) => c.events.push(e);

function seatInfo(c: Ctx, e: Entry): SeatInfo {
  return { tableId: e.tableId!, seat: e.seat!, entryId: e.id, playerId: e.playerId, displayName: e.displayName, stack: e.stack };
}

/** Each entry is capped, but unlimited re-entries are not, and their chips can all end up in one stack. */
function checkChipsInPlay(s: TournamentState, chips: number) {
  const inPlay = aliveEntries(s).reduce((sum, e) => sum + e.stack, 0);
  if (inPlay + chips > MAX_CHIPS_IN_PLAY) fail('The tournament cannot hold any more chips');
}

function newEntry(c: Ctx, playerId: PlayerId, displayName: string, entryNo: number, stack = c.s.settings.startingStack): Entry {
  checkChipsInPlay(c.s, stack);
  const e: Entry = {
    id: `${c.s.id}:e${++c.s.counters.entry}`,
    playerId,
    displayName,
    entryNo,
    status: 'registered',
    stack,
    tableId: null,
    seat: null,
    rebuys: 0,
    addOns: 0,
    registeredAt: c.now,
    ...(c.s.settings.bounty ? { bounty: c.s.settings.bounty.amount, bountiesWon: 0, knockouts: 0 } : {}),
  };
  c.s.entries.push(e);
  return e;
}

function newTable(c: Ctx): TableState {
  const t: TableState = {
    id: `${c.s.id}:t${++c.s.counters.table}`,
    seats: new Array(c.s.settings.seatsPerTable).fill(null),
    inHand: false,
    lastHandNumber: 0,
    button: null,
    hfhPlayed: c.s.handForHand.round,
    hfhHand: null,
  };
  c.s.tables.push(t);
  return t;
}

/** A stack the host approves in place of the starting stack. */
const customStack = (s: TournamentState, stack: number | undefined) => (stack === undefined || stack === s.settings.startingStack ? {} : { stack });

function register(c: Ctx, playerId: PlayerId, displayName: string, stack?: number) {
  const s = c.s;
  const late = started(s);
  const e = newEntry(c, playerId, displayName, 1, stack);
  emit(c, { type: 'registered', entryId: e.id, playerId, displayName, late, entryNo: 1, ...customStack(s, stack) });
  if (s.tables.length) seatLate(c, e, 'late-registration');
  afterRegistration(c);
}

/** Starts a delayed scheduled event or a full Sit & Go once enough players are in. */
function afterRegistration(c: Ctx) {
  const s = c.s;
  if (s.status !== 'registering') return;
  const count = readyEntries(s).length;
  if (s.settings.start.kind === 'scheduled' && s.graceUntil !== null && count >= 2) {
    seatAll(c);
    begin(c);
  } else if (s.settings.start.kind === 'sng' && count >= s.settings.start.playersNeeded) {
    seatAll(c);
    s.startAt = c.now + s.settings.start.startDelaySeconds * 1000;
    if (s.settings.start.autoSpawn) emit(c, { type: 'spawnNext' });
    if (s.startAt <= c.now) begin(c);
  }
}

function seatAll(c: Ctx) {
  const s = c.s;
  // Anyone who did not check in loses their place on the list.
  if (checkInActive(s)) {
    for (const e of s.entries.filter((x) => x.status === 'registered' && x.checkedInAt === undefined)) dropEntry(c, e, 'not-checked-in');
  }
  const waiting = s.entries.filter((e) => e.status === 'registered');
  const [draw, rng] = drawSeats(waiting.map((e) => e.id), s.settings.seatsPerTable, s.rng);
  s.rng = rng;
  const created: { tableId: TableId; seats: SeatInfo[] }[] = [];
  for (const seats of draw) {
    const t = newTable(c);
    t.seats = seats;
    seats.forEach((id, seat) => {
      if (id === null) return;
      const e = entry(s, id);
      Object.assign(e, { status: 'seated', tableId: t.id, seat });
    });
    created.push({ tableId: t.id, seats: tablePlayers(s, t).map((e) => seatInfo(c, e)) });
  }
  s.status = 'seating';
  emit(c, { type: 'tablesCreated', tables: created });
}

function begin(c: Ctx) {
  const s = c.s;
  s.status = 'running';
  s.startedAt = c.now;
  s.startAt ??= c.now;
  s.graceUntil = null;
  s.clock = { elapsedMs: 0, runningSince: c.now, rowIndex: 0 };
  emit(c, { type: 'started', at: c.now });
  emitLevel(c);
  const { start } = s.settings;
  if (start.kind === 'scheduled' && start.schedule?.repeat) {
    const next = nextOccurrence(start.schedule, start.startAt);
    if (next !== null) emit(c, { type: 'scheduleNext', startAt: next });
  }
  updateHandForHand(c);
}

function emitLevel(c: Ctx) {
  const l = levelFor(c.s, '');
  emit(c, { type: 'levelUp', levelNumber: l.levelNumber, sb: l.sb, bb: l.bb, ante: l.ante, anteType: l.anteType, gameId: l.gameId });
}

/** Seats one player at the table with the fewest players, opening a table if all are full. */
function seatLate(c: Ctx, e: Entry, reason: 'late-registration' | 're-entry') {
  const s = c.s;
  const open = s.tables.filter((t) => t.seats.includes(null)).sort((a, b) => tablePlayers(s, a).length - tablePlayers(s, b).length);
  let t = open[0];
  if (!t) {
    t = newTable(c);
    emit(c, { type: 'tableOpened', tableId: t.id });
  }
  const seat = seatToFill(t.seats, t.button);
  t.seats[seat] = e.id;
  Object.assign(e, { status: 'seated', tableId: t.id, seat });
  emit(c, { type: 'seatPlayer', seat: seatInfo(c, e), reason });
  rebalance(c);
}

/** Takes a registration back before the draw, freeing any invite code it used. */
function dropEntry(c: Ctx, e: Entry, reason?: 'not-checked-in') {
  const s = c.s;
  s.entries = s.entries.filter((x) => x !== e);
  for (const code of s.invites ?? []) code.usedBy = code.usedBy.filter((u) => u.playerId !== e.playerId);
  emit(c, { type: 'unregistered', playerId: e.playerId, ...(reason ? { reason } : {}) });
}

function unseat(c: Ctx, e: Entry) {
  if (e.tableId) {
    const t = table(c.s, e.tableId);
    if (t.seats[e.seat!] === e.id) t.seats[e.seat!] = null;
  }
}

/** Players who lost their last chip (not leavers); groups saved before they were marked are told by their members. */
const bustGroup = (s: TournamentState, g: EliminationGroup) => !!g.busted || (g.busted === undefined && g.members.every((m) => entry(s, m.entryId).status === 'busted'));

/** When a group went out, which is the order groups place in (see EliminationGroup.bustAt). */
const outAt = (g: EliminationGroup) => g.bustAt ?? g.at;

/**
 * A busted player whose rebuy offer ended goes out with the hand that busted them: into that hand's group (so
 * starting stacks still order them, and equal ones tie), or a new group where that hand falls among the others.
 */
function joinBustGroup(s: TournamentState, e: Entry, m: EliminationGroup['members'][number], now: number) {
  const bust = e.bust!;
  // The same hand: a member busted at this table at this moment (also finds groups saved before groups were marked),
  // or in hand-for-hand, the same round at any table. Never a group of players who left.
  const sameHand = (g: EliminationGroup) =>
    bustGroup(s, g) &&
    ((bust.hfhRound !== undefined && g.hfhRound === bust.hfhRound) ||
      g.members.some((o) => o.tableId === bust.tableId && entry(s, o.entryId).bust?.at === bust.at));
  const group = s.eliminations.find(sameHand);
  if (group) {
    group.members.push(m);
    if (now > group.at) {
      group.bustAt ??= group.at;
      group.at = now;
    }
    return;
  }
  const fresh: EliminationGroup = { members: [m], at: now, busted: true, ...(now > bust.at ? { bustAt: bust.at } : {}), ...(bust.hfhRound !== undefined ? { hfhRound: bust.hfhRound } : {}) };
  // After every group that went out by then (a quit in the same hand ranks below), before any that went out later.
  // In hand-for-hand, after the round's leavers too, wherever their hand ended.
  let i = s.eliminations.findIndex((g) => outAt(g) > bust.at);
  if (bust.hfhRound !== undefined) {
    const last = s.eliminations.map((g) => g.hfhRound).lastIndexOf(bust.hfhRound);
    if (last >= 0 && (i < 0 || last >= i)) i = last + 1;
  }
  if (i < 0 || i >= s.eliminations.length) s.eliminations.push(fresh);
  else s.eliminations.splice(i, 0, fresh);
}

/**
 * Knocks out a set of entries together. The emitted place is provisional:
 * later re-entries or hand-for-hand ties can change it; standings() is final.
 */
function eliminate(c: Ctx, members: Entry[], reason: 'busted' | 'quit' | 'removed', hfhRound?: number) {
  if (!members.length) return;
  const s = c.s;
  const member = (e: Entry) => ({ entryId: e.id, startStack: e.bust?.startStack ?? e.stack, tableId: e.bust?.tableId ?? e.tableId });
  // Busted players who were offered a rebuy went out in the hand that busted them, however long the offer took.
  const late = members.filter((e) => e.status === 'rebuy-offer' && e.bust);
  const now = members.filter((e) => !late.includes(e));
  if (now.length) {
    // Hand-for-hand busts in the same round share one group, so they tie across tables. Players who leave in that
    // round have their own group, below the round's busts, as leavers are below the busts of their hand.
    const round = hfhRound !== undefined ? s.eliminations.filter((g) => g.hfhRound === hfhRound) : [];
    const existing = round.find((g) => bustGroup(s, g) === (reason === 'busted'));
    if (existing) existing.members.push(...now.map(member));
    else {
      const group: EliminationGroup = { members: now.map(member), at: c.now, ...(reason === 'busted' ? { busted: true as const } : {}), ...(hfhRound !== undefined ? { hfhRound } : {}) };
      const busts = reason === 'busted' ? -1 : s.eliminations.findIndex((g) => round.includes(g) && bustGroup(s, g));
      if (busts < 0) s.eliminations.push(group);
      else s.eliminations.splice(busts, 0, group);
    }
  }
  for (const e of late) joinBustGroup(s, e, member(e), c.now);
  const seats = members.map((e) => ({ tableId: e.tableId, seat: e.seat }));
  // Leaving with a bounty nobody won: it stays the player's own, as it does for whoever is left at the end.
  if (reason !== 'busted') {
    for (const e of members) {
      if (!e.bounty) continue;
      e.bountiesWon = (e.bountiesWon ?? 0) + e.bounty;
      e.bounty = 0;
    }
  }
  for (const e of members) {
    unseat(c, e);
    e.status = reason === 'busted' ? 'busted' : reason;
    e.bust ??= { at: c.now, startStack: e.stack, tableId: e.tableId, by: [] };
    e.stack = 0;
    e.tableId = null;
    e.seat = null;
    delete e.rebuyOfferExpiresAt;
    delete e.leaveRequested;
    delete e.pendingStack;
    delete e.pendingStackBy;
  }
  const placeOf = places(s);
  members.forEach((e, i) =>
    emit(c, { type: 'eliminated', entryId: e.id, playerId: e.playerId, place: placeOf.get(e.id)!, by: e.bust!.by, ...seats[i], reason }),
  );
  s.requests = s.requests.filter((r) => !(r.kind === 'rebuy' && members.some((e) => e.id === r.entryId)));
}

function canRebuy(s: TournamentState, e: Entry): boolean {
  return rebuysOpen(s) && e.rebuys < s.settings.rebuy.max;
}

function addChips(c: Ctx, e: Entry, chips: number, reason: 'rebuy' | 'add-on') {
  checkChipsInPlay(c.s, chips);
  e.stack += chips;
  // An add-on bought after a pending stack edit counts on top of it.
  if (e.pendingStack !== undefined) e.pendingStack += chips;
  if (reason === 'rebuy') {
    e.rebuys++;
    e.status = 'seated';
    delete e.rebuyOfferExpiresAt;
    delete e.bust;
    // A rebuy buys a fresh bounty; the old one went to whoever busted them.
    if (c.s.settings.bounty) e.bounty = c.s.settings.bounty.amount;
  } else e.addOns++;
  emit(c, { type: 'stackAdded', entryId: e.id, playerId: e.playerId, tableId: e.tableId, seat: e.seat, chips, reason });
}

function reEnter(c: Ctx, old: Entry, stack?: number) {
  const e = newEntry(c, old.playerId, old.displayName, old.entryNo + 1, stack);
  old.supersededBy = e.id;
  emit(c, { type: 'registered', entryId: e.id, playerId: e.playerId, displayName: e.displayName, late: true, entryNo: e.entryNo, ...customStack(c.s, stack) });
  seatLate(c, e, 're-entry');
}

function request(c: Ctx, kind: RequestKind, e: { playerId: PlayerId; displayName: string }, entryId?: EntryId, code?: string) {
  const r: PendingRequest = {
    id: `${c.s.id}:r${++c.s.counters.request}`,
    kind,
    playerId: e.playerId,
    displayName: e.displayName,
    at: c.now,
    ...(entryId ? { entryId } : {}),
    ...(code ? { code } : {}),
  };
  c.s.requests.push(r);
  emit(c, { type: 'requestPending', request: r });
}

/** Notes who used a code. The host approving a registration lets it through even if the code was cancelled meanwhile. */
function useCode(c: Ctx, code: string, who: { playerId: PlayerId; displayName: string }) {
  c.s.invites?.find((x) => x.code === code)?.usedBy.push({ playerId: who.playerId, displayName: who.displayName, at: c.now });
}

/** Opens the check-in groups whose time has come, telling each newly eligible player once. */
function openCheckInGroups(c: Ctx) {
  const s = c.s;
  const groups = s.settings.checkIn?.groups;
  if (!groups || s.status !== 'registering') return;
  if (s.checkIn?.openedAt == null) {
    const at = checkInScheduledAt(s);
    if (at === null || c.now < at) return;
    s.checkIn = { openedAt: at, groupsOpen: 0 };
  }
  const state = s.checkIn!;
  while (state.groupsOpen < groups.length && c.now >= groupOpensAt(s, state.groupsOpen)!) {
    const group = state.groupsOpen++;
    const playerIds = s.entries.filter((e) => e.status === 'registered' && e.checkedInAt === undefined && checkInGroupOf(s, e) === group).map((e) => e.playerId);
    emit(c, { type: 'checkInOpened', group: group + 1, playerIds });
  }
}

/** Pays the bounty on a busted entry to the players who won the busting pot. */
function payBounty(c: Ctx, e: Entry) {
  const s = c.s;
  const head = e.bounty ?? 0;
  if (!s.settings.bounty || head <= 0) return;
  const winners = (e.bust?.by ?? []).map((id) => activeEntry(s, id)).filter((w): w is Entry => !!w && w !== e);
  if (!winners.length) return;
  e.bounty = 0;
  splitBounty(head, winners.length, s.settings.bounty.progressivePercent).forEach(({ cash, headAdded }, i) => {
    const w = winners[i];
    w.bountiesWon = (w.bountiesWon ?? 0) + cash;
    w.bounty = (w.bounty ?? 0) + headAdded;
    w.knockouts = (w.knockouts ?? 0) + 1;
    emit(c, { type: 'bountyWon', entryId: w.id, playerId: w.playerId, fromEntryId: e.id, fromPlayerId: e.playerId, cash, headAdded });
  });
}

function loads(s: TournamentState): TableLoad[] {
  return s.tables.map((t) => {
    const players = tablePlayers(s, t);
    return { id: t.id, players: players.length, inHand: t.inHand || players.some((e) => e.status === 'rebuy-offer') };
  });
}

function moveEntry(c: Ctx, e: Entry, to: TableState) {
  const from = { tableId: e.tableId!, seat: e.seat! };
  unseat(c, e);
  const seat = seatToFill(to.seats, to.button);
  to.seats[seat] = e.id;
  e.tableId = to.id;
  e.seat = seat;
  emit(c, { type: 'moveSeat', entryId: e.id, playerId: e.playerId, from, to: { tableId: to.id, seat }, stack: e.stack });
}

/** Breaks tables and evens them out, only touching tables between hands. */
function rebalance(c: Ctx) {
  const s = c.s;
  if (!(s.status === 'seating' || started(s))) return;
  for (let guard = 0; guard < 1000; guard++) {
    const step = nextBalanceStep(loads(s), s.settings.seatsPerTable);
    if (!step) break;
    if (step.kind === 'break') {
      const victim = table(s, step.tableId);
      for (const e of tablePlayers(s, victim)) {
        const dest = s.tables
          .filter((t) => t !== victim && t.seats.includes(null))
          .sort((a, b) => tablePlayers(s, a).length - tablePlayers(s, b).length)[0];
        moveEntry(c, e, dest);
      }
      s.tables = s.tables.filter((t) => t !== victim);
      emit(c, { type: 'tableBroken', tableId: victim.id });
    } else {
      const from = table(s, step.from);
      const to = table(s, step.to);
      let seat = seatToMove(from.seats, from.button);
      const chosen = entry(s, from.seats[seat]!);
      if (chosen.status !== 'seated') seat = from.seats.findIndex((id) => id !== null && entry(s, id).status === 'seated');
      moveEntry(c, entry(s, from.seats[seat]!), to);
    }
  }
  updateHandForHand(c);
}

function updateHandForHand(c: Ctx) {
  const s = c.s;
  const paid = paidPlaces(s);
  const shouldBeOn = started(s) && s.settings.handForHand && paid > 0 && s.tables.length > 1 && aliveEntries(s).length === paid + 1;
  if (shouldBeOn && !s.handForHand.active) {
    s.handForHand = { active: true, round: s.handForHand.round + 1 };
    for (const t of s.tables) t.hfhPlayed = s.handForHand.round - 1;
    emit(c, { type: 'handForHand', active: true });
  } else if (!shouldBeOn && s.handForHand.active) {
    s.handForHand = { ...s.handForHand, active: false };
    emit(c, { type: 'handForHand', active: false });
  }
  // A table that was waiting on a rebuy may have nothing left to play now the offer is over.
  if (s.handForHand.active) advanceHandForHand(s);
}

/**
 * Advances a hand-for-hand round once every table has played it. A table that can't deal (one player left at it, as
 * with an odd number left at two-seat tables) has nothing to play, so it doesn't hold the round up; a table waiting
 * on a busted player's rebuy still may, so it does.
 */
function advanceHandForHand(s: TournamentState) {
  const h = s.handForHand;
  if (h.active && s.tables.every((t) => !t.inHand && (t.hfhPlayed >= h.round || !mayDeal(s, t)))) h.round++;
}

function checkFinish(c: Ctx) {
  const s = c.s;
  if (!started(s)) return;
  const alive = aliveEntries(s);
  if (alive.length > 1 || alive.some((e) => e.status === 'rebuy-offer')) return;
  // A lone survivor waits while a busted player can still re-enter (see reEntryWaitEnds), and while
  // late registration holds it.
  const waitEnds = reEntryWaitEnds(s);
  if (alive.length === 1 && waitEnds !== null && c.now < waitEnds) return;
  if (alive.length === 1 && lateRegistrationHolds(s)) return;
  finish(c);
}

/**
 * Whether open late registration keeps a lone survivor from winning. Once someone has won every chip in play it no
 * longer does, unless a registration is waiting for the host; before anyone has busted (the others quit or were
 * removed) it waits for late entries.
 */
function lateRegistrationHolds(s: TournamentState): boolean {
  const someoneBusted = s.entries.some((e) => e.status === 'busted');
  const registrationWaiting = s.requests.some((r) => r.kind === 'register');
  return registrationOpen(s) && (!someoneBusted || registrationWaiting);
}

function finish(c: Ctx) {
  const s = c.s;
  const alive = aliveEntries(s);
  // Whoever is still in keeps the bounty on their own head.
  for (const e of alive) {
    if (e.bounty) {
      e.bountiesWon = (e.bountiesWon ?? 0) + e.bounty;
      e.bounty = 0;
    }
  }
  if (alive.length) {
    s.eliminations.push({ members: alive.map((e) => ({ entryId: e.id, startStack: e.stack, tableId: null })), at: c.now });
  }
  s.status = 'finished';
  s.finishedAt = c.now;
  if (s.clock.runningSince !== null) s.clock = { ...s.clock, elapsedMs: elapsed(s, c.now), runningSince: null };
  s.handForHand.active = false;
  s.requests = [];
  emit(c, { type: 'finished', standings: standings(s) });
}

function cancel(c: Ctx, reason: 'not-enough-players' | 'host') {
  c.s.status = 'cancelled';
  c.s.finishedAt = c.now;
  c.s.requests = [];
  emit(c, { type: 'cancelled', reason });
}

/** Moves the clock to `now`, announcing level changes, breaks and closing windows. */
function advanceClock(c: Ctx) {
  const s = c.s;
  if (s.status !== 'running') return;
  const target = clockAt(s.settings.structure, elapsed(s, c.now)).rowIndex;
  while (s.clock.rowIndex < target) {
    const before = { late: registrationOpen(s), rebuy: rebuysOpen(s), reEntry: reEntryOpen(s) };
    const wasBreak = s.settings.structure[s.clock.rowIndex].kind === 'break';
    s.clock.rowIndex++;
    const row = s.settings.structure[s.clock.rowIndex];
    if (wasBreak) emit(c, { type: 'breakEnded' });
    if (row.kind === 'break') {
      const endsAt = s.clock.runningSince! + rowStartMs(s.settings.structure, s.clock.rowIndex + 1) - s.clock.elapsedMs;
      emit(c, { type: 'breakStarted', minutes: row.minutes, endsAt, addOn: !!row.addOn && s.settings.addOn.max > 0 });
    } else emitLevel(c);
    if (before.late && !registrationOpen(s) && s.settings.lateRegistration.enabled) emit(c, { type: 'lateRegistrationClosed' });
    if (before.rebuy && !rebuysOpen(s)) emit(c, { type: 'rebuysClosed' });
    if (before.reEntry && !reEntryOpen(s)) emit(c, { type: 'reEntryClosed' });
  }
}

function expireOffers(c: Ctx) {
  const expired = c.s.entries.filter((e) => e.status === 'rebuy-offer' && e.rebuyOfferExpiresAt! <= c.now && !rebuyAsked(c.s, e));
  eliminate(c, expired, 'busted');
}

function settle(c: Ctx) {
  rebalance(c);
  checkFinish(c);
}

// ---------------------------------------------------------------------------
// Public transitions

function run(state: TournamentState, now: number, fn: (c: Ctx) => void): Result {
  const c: Ctx = { s: structuredClone(state), events: [], now };
  fn(c);
  return { state: c.s, events: c.events };
}

export function tick(state: TournamentState, now: number): Result {
  return run(state, now, (c) => {
    const s = c.s;
    const { start } = s.settings;
    if (s.status === 'registering' && start.kind === 'scheduled' && s.startAt !== null) {
      openCheckInGroups(c);
      const count = readyEntries(s).length;
      if (count >= 2 && now >= s.startAt - s.settings.seatLeadSeconds * 1000) seatAll(c);
      else if (now >= s.startAt) {
        if (s.graceUntil === null) {
          s.graceUntil = s.startAt + s.settings.graceMinutes * 60_000;
          emit(c, { type: 'startDelayed', reason: 'not-enough-players', graceUntil: s.graceUntil });
        }
        if (now >= s.graceUntil) cancel(c, 'not-enough-players');
      }
    }
    else if (s.status === 'registering') openCheckInGroups(c);
    if (s.status === 'seating' && s.startAt !== null && now >= s.startAt) begin(c);
    if (started(s)) {
      advanceClock(c);
      expireOffers(c);
      settle(c);
    }
  });
}

export function apply(state: TournamentState, cmd: Command, now: number): Result {
  if (cmd.type === 'archive') return archive(state, cmd.by, now);
  if (state.status === 'finished' || state.status === 'cancelled') fail('This tournament is over');
  return run(state, now, (c) => {
    const s = c.s;
    // Commands act on the clock as of now.
    if (started(s)) {
      advanceClock(c);
      expireOffers(c);
    }
    switch (cmd.type) {
      case 'register': {
        if (activeEntry(s, cmd.playerId)) fail('Already registered');
        if (latestEntry(s, cmd.playerId)) fail('Already played this event; use re-entry');
        if (!registrationOpen(s)) fail(hasRoom(s) ? 'Registration is closed' : 'The tournament is full');
        if (s.requests.some((r) => r.kind === 'register' && r.playerId === cmd.playerId)) fail('Already requested');
        const code = normalizeCode(cmd.code);
        if (code && !usableCode(s, code)) fail('That invite code is not valid');
        if (!code && s.settings.invites?.required) fail('You need an invite code to register');
        const skipApproval = !!code && !!s.settings.invites?.autoApprove;
        if (s.settings.registrationApproval && !skipApproval) request(c, 'register', cmd, undefined, code || undefined);
        else {
          if (code) useCode(c, code, cmd);
          register(c, cmd.playerId, cmd.displayName);
        }
        break;
      }
      case 'checkIn': {
        const e = activeEntry(s, cmd.playerId) ?? fail('Not registered');
        if (!checkInActive(s)) fail('Check-in is closed');
        if (e.checkedInAt !== undefined) fail('Already checked in');
        if (!mayCheckIn(s, e)) fail("Your check-in group isn't open yet");
        const checkedIn = s.entries.filter((x) => x.status === 'registered' && x.checkedInAt !== undefined).length;
        if (checkedIn >= s.settings.maxEntrants) fail('Every seat is taken');
        e.checkedInAt = now;
        emit(c, { type: 'checkedIn', playerId: e.playerId });
        afterRegistration(c);
        break;
      }
      case 'openCheckIn': {
        if (!s.settings.checkIn) fail('Check-in is off');
        if (s.status !== 'registering') fail('Seats are already drawn');
        if (s.checkIn?.openedAt != null) fail('Check-in is already open');
        s.checkIn = { openedAt: now, groupsOpen: 0 };
        openCheckInGroups(c);
        break;
      }
      case 'createInvites': {
        const { count, maxUses } = cmd;
        if (!Number.isSafeInteger(count) || count < 1 || count > MAX_INVITES_PER_BATCH) fail(`Make 1-${MAX_INVITES_PER_BATCH} codes at a time`);
        if (!(maxUses === null || (Number.isSafeInteger(maxUses) && maxUses >= 1 && maxUses <= MAX_INVITE_CODES))) fail('Uses per code must be 1 or more, or no limit');
        const invites = (s.invites ??= []);
        if (invites.length + count > MAX_INVITE_CODES) fail(`A tournament can have at most ${MAX_INVITE_CODES} codes`);
        const taken = new Set(invites.map((x) => x.code));
        let codes: string[];
        if (cmd.codes) {
          codes = cmd.codes.map(normalizeCode);
          if (codes.length !== count || !codes.every(isCodeFormat) || new Set([...taken, ...codes]).size !== taken.size + count) fail('Those codes are not usable');
        } else [codes, s.rng] = drawCodes(s.rng, count, taken);
        for (const code of codes) invites.push({ code, maxUses, createdAt: now, cancelled: false, usedBy: [] });
        emit(c, { type: 'invitesCreated', codes });
        break;
      }
      case 'cancelInvite': {
        const code = s.invites?.find((x) => x.code === normalizeCode(cmd.code)) ?? fail('No such code');
        code.cancelled = true;
        break;
      }
      case 'unregister': {
        const pending = s.requests.find((r) => r.kind === 'register' && r.playerId === cmd.playerId);
        if (pending) {
          s.requests = s.requests.filter((r) => r !== pending);
          emit(c, { type: 'unregistered', playerId: cmd.playerId });
          break;
        }
        const e = activeEntry(s, cmd.playerId) ?? fail('Not registered');
        if (e.status !== 'registered' || s.status !== 'registering') fail('Seats are drawn; you can only quit now');
        dropEntry(c, e);
        break;
      }
      case 'rebuy': {
        const e = activeEntry(s, cmd.playerId);
        if (!e || e.status !== 'rebuy-offer') fail('No rebuy on offer');
        if (s.settings.rebuy.approval) {
          if (!s.requests.some((r) => r.kind === 'rebuy' && r.entryId === e!.id)) request(c, 'rebuy', e!, e!.id);
        } else addChips(c, e!, s.settings.rebuy.chips, 'rebuy');
        break;
      }
      case 'declineRebuy': {
        const e = activeEntry(s, cmd.playerId);
        if (!e || e.status !== 'rebuy-offer') fail('No rebuy on offer');
        eliminate(c, [e!], 'busted');
        break;
      }
      case 'addOn': {
        const e = activeEntry(s, cmd.playerId) ?? fail('Not playing');
        if (!addOnsOpen(s)) fail('Add-ons are not open');
        if (e.status !== 'seated') fail('Not seated');
        if (e.addOns >= s.settings.addOn.max) fail('No add-ons left');
        if (s.settings.addOn.approval) {
          if (!s.requests.some((r) => r.kind === 'add-on' && r.entryId === e.id)) request(c, 'add-on', e, e.id);
        } else addChips(c, e, s.settings.addOn.chips, 'add-on');
        break;
      }
      case 'reEnter': {
        if (activeEntry(s, cmd.playerId)) fail('Still in the tournament');
        const old = latestEntry(s, cmd.playerId);
        if (!old || old.status !== 'busted') fail('Nothing to re-enter');
        if (!reEntryOpen(s)) fail('Re-entry is closed');
        const { max, approval } = s.settings.reEntry;
        if (max !== null && old!.entryNo - 1 >= max) fail('No re-entries left');
        if (approval) {
          if (!s.requests.some((r) => r.kind === 're-entry' && r.playerId === cmd.playerId)) request(c, 're-entry', old!, old!.id);
        } else reEnter(c, old!);
        break;
      }
      case 'quit':
      case 'remove': {
        const reason = cmd.type === 'quit' ? 'quit' : 'removed';
        if (cmd.type === 'quit' && !s.settings.allowQuit) fail('Quitting is not allowed in this tournament');
        const e = activeEntry(s, cmd.playerId) ?? fail('Not playing');
        if (e.status === 'registered') {
          if (s.status !== 'registering') fail('Not seated yet');
          dropEntry(c, e);
        } else if (e.status === 'seated' && e.tableId && table(s, e.tableId).inHand) {
          e.leaveRequested = reason;
        } else eliminate(c, [e], reason);
        break;
      }
      case 'approve':
      case 'reject': {
        const r = s.requests.find((x) => x.id === cmd.requestId) ?? fail('Request not found');
        s.requests = s.requests.filter((x) => x !== r);
        const e = r.entryId ? entry(s, r.entryId) : undefined;
        const stack = cmd.type === 'approve' ? cmd.stack : undefined;
        if (stack !== undefined) {
          if (r.kind !== 'register' && r.kind !== 're-entry') fail('Only registrations and re-entries take a starting stack');
          if (!isWhole(stack, 1, MAX_CHIPS)) fail(`The stack must be a whole number from 1 to ${CHIPS_LABEL}`);
        }
        if (cmd.type === 'reject') {
          emit(c, { type: 'requestRejected', request: r });
          if (r.kind === 'rebuy' && e?.status === 'rebuy-offer') eliminate(c, [e], 'busted');
          break;
        }
        if (r.kind === 'register') {
          if (activeEntry(s, r.playerId)) fail('Already registered');
          if (!hasRoom(s)) fail('The tournament is full');
          if (r.code) useCode(c, r.code, r);
          register(c, r.playerId, r.displayName, stack);
        } else if (r.kind === 'rebuy') {
          if (e?.status !== 'rebuy-offer') fail('The rebuy offer has expired');
          addChips(c, e!, s.settings.rebuy.chips, 'rebuy');
        } else if (r.kind === 'add-on') {
          if (e?.status !== 'seated') fail('Not seated');
          addChips(c, e!, s.settings.addOn.chips, 'add-on');
        } else {
          if (!e || e.status !== 'busted' || e.supersededBy || activeEntry(s, r.playerId)) fail('Nothing to re-enter');
          reEnter(c, e!, stack);
        }
        break;
      }
      case 'pause': {
        if (s.status !== 'running') fail('Not running');
        s.clock = { ...s.clock, elapsedMs: elapsed(s, now), runningSince: null };
        s.status = 'paused';
        emit(c, { type: 'paused' });
        break;
      }
      case 'resume': {
        if (s.status !== 'paused') fail('Not paused');
        s.clock = { ...s.clock, runningSince: now };
        s.status = 'running';
        emit(c, { type: 'resumed' });
        break;
      }
      case 'startNow': {
        if (s.status === 'registering') {
          if (readyEntries(s).length < 2) fail(s.settings.checkIn ? 'Need at least 2 checked-in players' : 'Need at least 2 players');
          seatAll(c);
        }
        if (s.status !== 'seating') fail('Already started');
        begin(c);
        break;
      }
      case 'editStructure': {
        const structure = cleanStructure(cmd.structure);
        const issues = validateStructure(structure, { maxRebuys: s.settings.rebuy.max });
        if (issues.errors.length) fail(issues.errors.join('; '));
        if (started(s)) {
          const keep = s.clock.rowIndex + 1;
          // Both sides cleaned: a structure saved before rows were cleaned may still hold extra fields.
          if (JSON.stringify(structure.slice(0, keep)) !== JSON.stringify(cleanStructure(s.settings.structure).slice(0, keep)))
            fail('Only levels after the current one can change');
          // The last level runs on past its length. Rows added after it would count that extra time as already
          // played and be skipped, so the current level ends now and the next row starts from the edit.
          if (clockAt(structure, elapsed(s, now)).rowIndex > s.clock.rowIndex) {
            s.clock = { ...s.clock, elapsedMs: rowStartMs(structure, keep), runningSince: s.clock.runningSince === null ? null : now };
          }
        }
        s.settings.structure = structuredClone(structure);
        emit(c, { type: 'structureEdited' });
        break;
      }
      case 'updateSettings': {
        const changes = cleanSettings(cmd.settings);
        const next = { ...s.settings, ...structuredClone(changes) };
        const locked: (keyof TournamentSettings)[] = s.tables.length
          ? ['start', 'games', 'stopRotationAtLevel', 'startingStack', 'seatsPerTable', 'structure', 'season', 'tableRules']
          : ['structure', 'season'];
        // Compared cleaned, as settings saved before nested fields were cleaned may still hold extra ones.
        const was = cleanSettings(s.settings);
        for (const k of locked) {
          if (k in changes && JSON.stringify(changes[k]) !== JSON.stringify(was[k]))
            fail(k === 'structure' ? 'Use editStructure to change levels' : k === 'season' ? 'The season is set when the tournament is created' : `${k} is locked once tables exist`);
        }
        const errors = validateSettings(next);
        if (next.maxEntrants < (next.checkIn && checkInActive(s) ? readyEntries(s) : rankedEntries(s)).length) errors.push('Max entrants is below the current field');
        if (errors.length) fail(errors.join('; '));
        s.settings = next;
        if (next.start.kind === 'scheduled' && s.status === 'registering') {
          // A new start time ends the grace period the old one began.
          if (next.start.startAt !== s.startAt) s.graceUntil = null;
          s.startAt = next.start.startAt;
        }
        emit(c, { type: 'settingsUpdated' });
        break;
      }
      case 'end': {
        if (s.status === 'registering' || s.status === 'seating') cancel(c, 'host');
        else {
          if (s.status !== 'paused') fail('Pause the tournament first');
          if (s.tables.some((t) => t.inHand)) fail('Wait for the hands in progress to finish');
          eliminate(c, s.entries.filter((e) => e.status === 'rebuy-offer'), 'busted');
          finish(c);
        }
        break;
      }
      case 'setCoHost':
      case 'removeCoHost':
      case 'transferHost':
        staffCommand(c, cmd);
        break;
      case 'setStack':
        setStack(c, cmd.by, cmd.playerId, cmd.stack);
        break;
      case 'movePlayer':
        movePlayer(c, cmd.by, cmd.playerId, cmd.tableId, cmd.seat);
        break;
      case 'handStarted': {
        const t = table(s, cmd.tableId);
        t.inHand = true;
        t.lastHandNumber = cmd.handNumber;
        t.hfhHand = s.handForHand.active ? s.handForHand.round : null;
        if (s.handForHand.active) t.hfhPlayed = s.handForHand.round;
        break;
      }
      case 'handResult':
        handResult(c, cmd.result);
        break;
    }
    if (c.s.status !== 'finished' && c.s.status !== 'cancelled') settle(c);
  });
}

function handResult(c: Ctx, r: HandResult) {
  const s = c.s;
  const t = table(s, r.tableId);
  // A hand this table already reported: a table restored from an older snapshot played it again.
  if (r.handNumber < t.lastHandNumber || (r.handNumber === t.lastHandNumber && !t.inHand && t.lastHandNumber > 0)) return;
  t.inHand = false;
  t.lastHandNumber = r.handNumber;
  if (r.button !== undefined) t.button = r.button;
  const hfhRound = t.hfhHand ?? undefined;
  t.hfhHand = null;

  const players = tablePlayers(s, t);
  for (const e of players) {
    const end = r.endStacks[e.playerId];
    if (end !== undefined && e.status === 'seated') e.stack = end;
  }
  // Host stack edits made during the hand land now, before anyone is counted out.
  for (const e of players) {
    if (e.pendingStack === undefined) continue;
    const stack = e.pendingStack;
    const by = e.pendingStackBy ?? s.hostId;
    delete e.pendingStack;
    delete e.pendingStackBy;
    if (e.status !== 'seated' || e.leaveRequested) continue;
    const previous = e.stack;
    e.stack = stack;
    emit(c, { type: 'stackSet', by, entryId: e.id, playerId: e.playerId, tableId: e.tableId, seat: e.seat, stack, previous, applied: true });
  }
  const leavers = players.filter((e) => e.leaveRequested);
  // A leaver who lost every chip in the hand was knocked out first: their bounty goes to whoever did it.
  for (const e of leavers) {
    if (e.stack > 0 || e.status !== 'seated') continue;
    e.bust = { at: c.now, startStack: r.startStacks[e.playerId] ?? 0, tableId: t.id, by: r.knockedOutBy?.[e.playerId] ?? [] };
    payBounty(c, e);
  }

  // The others who lost every chip. Their bounties are paid while the leavers are still in, so a leaver who
  // busted them collects it before going.
  const busted = players.filter((e) => e.status === 'seated' && e.stack <= 0 && !e.leaveRequested);
  const out: Entry[] = [];
  for (const e of busted) {
    e.bust = { at: c.now, startStack: r.startStacks[e.playerId] ?? 0, tableId: t.id, by: r.knockedOutBy?.[e.playerId] ?? [], ...(hfhRound !== undefined ? { hfhRound } : {}) };
    payBounty(c, e);
    if (canRebuy(s, e)) {
      e.status = 'rebuy-offer';
      e.rebuyOfferExpiresAt = c.now + s.settings.rebuy.offerSeconds * 1000;
      emit(c, { type: 'rebuyOffered', entryId: e.id, playerId: e.playerId, expiresAt: e.rebuyOfferExpiresAt, chips: s.settings.rebuy.chips });
    } else out.push(e);
  }
  for (const reason of ['quit', 'removed'] as const) eliminate(c, leavers.filter((e) => e.leaveRequested === reason), reason, hfhRound);
  eliminate(c, out, 'busted', hfhRound);
  advanceHandForHand(s);
}

// ---------------------------------------------------------------------------
// Host tools: co-hosts, stack edits, seat moves, archive

function roles<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RoleError) fail(e.message.charAt(0).toUpperCase() + e.message.slice(1));
    throw e;
  }
}

/** A name for someone the event knows: an entry, a pending request, or a co-host. */
function knownName(s: TournamentState, playerId: PlayerId): string | null {
  return (
    latestEntry(s, playerId)?.displayName ??
    s.requests.find((r) => r.playerId === playerId)?.displayName ??
    s.coHosts?.find((x) => x.playerId === playerId)?.name ??
    null
  );
}

function staffCommand(c: Ctx, cmd: Extract<Command, { type: 'setCoHost' | 'removeCoHost' | 'transferHost' }>) {
  const s = c.s;
  if (cmd.type === 'setCoHost') {
    const name = knownName(s, cmd.playerId) ?? fail('Only players in this event can be co-hosts');
    s.coHosts = roles(() => withCoHost(s, { playerId: cmd.playerId, name, powers: cmd.powers }));
    emit(c, { type: 'coHostsChanged', by: cmd.by });
  } else if (cmd.type === 'removeCoHost') {
    s.coHosts = roles(() => withoutCoHost(s, cmd.playerId));
    emit(c, { type: 'coHostsChanged', by: cmd.by });
  } else {
    if (knownName(s, cmd.to) === null) fail('Only players in this event can be the host');
    const oldName = knownName(s, s.hostId) ?? (cleanText(cmd.byName ?? '').slice(0, NAME_MAX) || 'Host');
    const next = roles(() => handOver(s, cmd.to, oldName));
    s.hostId = next.hostId;
    s.coHosts = next.coHosts;
    emit(c, { type: 'hostChanged', by: cmd.by, hostId: next.hostId });
  }
}

function setStack(c: Ctx, by: PlayerId, playerId: PlayerId, stack: number) {
  const s = c.s;
  const e = activeEntry(s, playerId) ?? fail('Not playing');
  if (!isWhole(stack, 1, MAX_CHIPS)) fail(`The stack must be a whole number from 1 to ${CHIPS_LABEL}`);
  if (e.status === 'rebuy-offer') fail('They are deciding on a rebuy; wait for that first');
  if (stack > e.stack) checkChipsInPlay(s, stack - e.stack);
  const inHand = e.status === 'seated' && !!e.tableId && table(s, e.tableId).inHand;
  const info = { by, entryId: e.id, playerId, tableId: e.tableId, seat: e.seat, stack, previous: e.stack };
  if (inHand) {
    e.pendingStack = stack;
    e.pendingStackBy = by;
    emit(c, { type: 'stackSet', ...info, applied: false });
  } else {
    delete e.pendingStack;
    delete e.pendingStackBy;
    e.stack = stack;
    emit(c, { type: 'stackSet', ...info, applied: true });
  }
}

function movePlayer(c: Ctx, by: PlayerId, playerId: PlayerId, tableId: TableId, seat: number) {
  const s = c.s;
  if (!(s.status === 'seating' || started(s))) fail('Seats are not drawn yet');
  const e = activeEntry(s, playerId) ?? fail('Not playing');
  if (e.status !== 'seated' || !e.tableId) fail('Only seated players can move');
  const from = table(s, e.tableId!);
  const to = s.tables.find((t) => t.id === tableId) ?? fail('No such table');
  if (!isWhole(seat, 0, to.seats.length - 1)) fail('No such seat');
  if (from.inHand || to.inHand) fail('Wait for the hand in progress to finish');
  if (to === from && seat === e.seat) fail('They are already in that seat');
  const otherId = to.seats[seat];
  const fromSeat = e.seat!;
  const move = (x: Entry, dest: TableState, destSeat: number) => {
    const ev = { type: 'moveSeat' as const, entryId: x.id, playerId: x.playerId, from: { tableId: x.tableId!, seat: x.seat! }, to: { tableId: dest.id, seat: destSeat }, stack: x.stack, by };
    x.tableId = dest.id;
    x.seat = destSeat;
    return ev;
  };
  if (otherId) {
    const other = entry(s, otherId);
    if (other.status !== 'seated') fail('That player is deciding on a rebuy; wait for that first');
    from.seats[fromSeat] = otherId;
    to.seats[seat] = e.id;
    const moves = [move(e, to, seat), move(other, from, fromSeat)];
    emit(c, { type: 'seatsSwapped', by, moves });
    return;
  }
  if (to !== from) {
    const counts = s.tables.map((t) => tablePlayers(s, t).length);
    const spread = (n: number[]) => Math.max(...n) - Math.min(...n);
    const after = s.tables.map((t, i) => counts[i] + (t === to ? 1 : t === from ? -1 : 0));
    if (spread(after) > 1 && spread(after) > spread(counts)) fail('That would leave the tables uneven; pick a taken seat to swap two players');
  }
  from.seats[fromSeat] = null;
  to.seats[seat] = e.id;
  emit(c, move(e, to, seat));
}

function archive(state: TournamentState, by: PlayerId, now: number): Result {
  return run(state, now, (c) => {
    const s = c.s;
    if (s.archivedAt) fail('Already archived');
    if (started(s)) fail('End the tournament first');
    if (s.status === 'registering' || s.status === 'seating') cancel(c, 'host');
    s.archivedAt = now;
    emit(c, { type: 'archived', by });
  });
}

/**
 * Cleanup (TRN-54): the newest thing that happened in an event nobody started,
 * so the server can archive one that has sat untouched for weeks.
 */
export function lastActivityAt(s: TournamentState): number {
  return Math.max(s.createdAt, ...s.entries.map((e) => e.registeredAt), ...s.requests.map((r) => r.at));
}

/** The server's cleanup: cancels an event that never started and archives it (or archives one that is over). */
export function autoArchive(state: TournamentState, now: number): Result {
  return run(state, now, (c) => {
    const s = c.s;
    if (s.archivedAt || started(s)) return;
    if (s.status === 'registering' || s.status === 'seating') cancel(c, 'host');
    s.archivedAt = now;
    emit(c, { type: 'archived', by: null });
  });
}
