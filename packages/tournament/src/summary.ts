// Read-only views for lobby pages and table overlays: the live clock, field
// stats, and what a given player may do right now.

import { addOnsOpen, aliveEntries, currentPrizePool, levelDeal, paidPlaces, reEntryOpen, rebuysOpen, registrationOpen } from './director';
import { checkInActive, checkInGroupOf, checkInScheduledAt, checkedInCount, groupOpensAt, mayCheckIn } from './formats';
import { clockAt, type LevelRow } from './structure';
import type { Entry, PendingRequest, PlayerId, TournamentState } from './types';

export interface ClockSummary {
  levelNumber: number;
  onBreak: boolean;
  /** Blinds in force (during a break, the level after it), with the ante its game posts (see levelDeal). */
  level: LevelRow;
  nextLevel: LevelRow | null;
  /** Null when the last level runs with no end. */
  msLeft: number | null;
  msToBreak: number | null;
  rowIndex: number;
  running: boolean;
}

export interface TournamentSummary {
  status: TournamentState['status'];
  /** Before the start: time to the scheduled or Sit & Go deal, if known. */
  msToStart: number | null;
  /** Scheduled start waiting for a second player: time left before it cancels. */
  msToCancel: number | null;
  /** Sit & Go still filling: players still needed. */
  playersNeeded: number | null;
  clock: ClockSummary | null;
  entrants: number;
  entries: number;
  playersLeft: number;
  averageStack: number;
  chipLeader: { playerId: PlayerId; displayName: string; stack: number } | null;
  totalRebuys: number;
  totalAddOns: number;
  prizePool: number;
  paidPlaces: number;
  tables: number;
  handForHand: boolean;
  registrationOpen: boolean;
  rebuysOpen: boolean;
  addOnsOpen: boolean;
  reEntryOpen: boolean;
  /** Check-in events before the draw; null otherwise. */
  checkIn: {
    checkedIn: number;
    notCheckedIn: number;
    groupsOpen: number;
    groups: number;
    /** Time until the first group opens (null once open, or when the host opens it). */
    msToOpen: number | null;
    /** Time until the next group opens, once check-in is open. */
    msToNextGroup: number | null;
  } | null;
  /** Bounty events: money still on heads in play. */
  bountiesInPlay: number;
}

/** A level row with the ante its game posts, so the clock shows what the tables deal. */
function levelAsDealt(s: TournamentState, levelNumber: number, row: LevelRow): LevelRow {
  const { ante, anteType } = levelDeal(s.settings, levelNumber, row);
  return ante === row.ante && anteType === row.anteType ? row : { ...row, ante, anteType };
}

/** Elapsed running time on the tournament clock at `now`. */
export function clockElapsed(s: TournamentState, now: number): number {
  return s.clock.elapsedMs + (s.clock.runningSince === null ? 0 : now - s.clock.runningSince);
}

export function summarize(s: TournamentState, now: number): TournamentSummary {
  const alive = aliveEntries(s);
  const ranked = s.entries.filter((e) => !e.supersededBy);
  const chips = alive.reduce((a, e) => a + e.stack, 0);
  const leader = [...alive].sort((a, b) => b.stack - a.stack)[0];
  const started = s.status === 'running' || s.status === 'paused';
  let clock: ClockSummary | null = null;
  if (started || s.status === 'finished') {
    const p = clockAt(s.settings.structure, clockElapsed(s, now));
    // During a break both are the level after it.
    const n = p.onBreak ? p.levelNumber + 1 : p.levelNumber;
    clock = {
      levelNumber: p.levelNumber,
      onBreak: p.onBreak,
      level: levelAsDealt(s, n, p.level),
      nextLevel: p.nextLevel && levelAsDealt(s, p.onBreak ? n : n + 1, p.nextLevel),
      msLeft: p.msLeft,
      msToBreak: p.msToBreak,
      rowIndex: p.rowIndex,
      running: s.status === 'running',
    };
  }
  const { start } = s.settings;
  return {
    status: s.status,
    msToStart: !started && s.startAt !== null && s.status !== 'finished' && s.status !== 'cancelled' ? Math.max(0, s.startAt - now) : null,
    msToCancel: s.graceUntil !== null && s.status === 'registering' ? Math.max(0, s.graceUntil - now) : null,
    playersNeeded: start.kind === 'sng' && s.status === 'registering' ? Math.max(0, start.playersNeeded - alive.length) : null,
    clock,
    entrants: ranked.length,
    entries: s.entries.length,
    playersLeft: alive.length,
    averageStack: alive.length ? Math.round(chips / alive.length) : 0,
    chipLeader: leader && started ? { playerId: leader.playerId, displayName: leader.displayName, stack: leader.stack } : null,
    totalRebuys: s.entries.reduce((a, e) => a + e.rebuys, 0),
    totalAddOns: s.entries.reduce((a, e) => a + e.addOns, 0),
    prizePool: currentPrizePool(s),
    paidPlaces: paidPlaces(s),
    tables: s.tables.length,
    handForHand: s.handForHand.active,
    registrationOpen: s.status !== 'finished' && s.status !== 'cancelled' && registrationOpen(s),
    rebuysOpen: rebuysOpen(s),
    addOnsOpen: addOnsOpen(s),
    reEntryOpen: reEntryOpen(s),
    checkIn: checkInSummary(s, now),
    bountiesInPlay: alive.reduce((a, e) => a + (e.bounty ?? 0), 0),
  };
}

function checkInSummary(s: TournamentState, now: number): TournamentSummary['checkIn'] {
  const c = s.settings.checkIn;
  if (!c || !checkInActive(s)) return null;
  const open = s.checkIn?.groupsOpen ?? 0;
  const checkedIn = checkedInCount(s);
  const scheduled = checkInScheduledAt(s);
  const next = open > 0 && open < c.groups.length ? groupOpensAt(s, open) : null;
  return {
    checkedIn,
    notCheckedIn: s.entries.filter((e) => e.status === 'registered').length - checkedIn,
    groupsOpen: open,
    groups: c.groups.length,
    msToOpen: open === 0 && scheduled !== null ? Math.max(0, scheduled - now) : null,
    msToNextGroup: next !== null ? Math.max(0, next - now) : null,
  };
}

export interface PlayerOptions {
  entry: Entry | null;
  pending: PendingRequest[];
  canRegister: boolean;
  canUnregister: boolean;
  canRebuy: boolean;
  canDeclineRebuy: boolean;
  canAddOn: boolean;
  canReEnter: boolean;
  canQuit: boolean;
  /** Check-in events: may check in now. */
  canCheckIn: boolean;
  checkedIn: boolean;
  /** When this player's check-in group opens (null when it is open, or unknown until the host opens check-in). */
  checkInOpensAt: number | null;
}

/** What a player may do now. Mirrors the checks in apply(), for showing buttons. */
export function playerOptions(s: TournamentState, playerId: PlayerId): PlayerOptions {
  const mine = s.entries.filter((e) => e.playerId === playerId).sort((a, b) => b.entryNo - a.entryNo);
  const entry = mine[0] ?? null;
  const pending = s.requests.filter((r) => r.playerId === playerId);
  const over = s.status === 'finished' || s.status === 'cancelled';
  const alive = !!entry && ['registered', 'seated', 'rebuy-offer'].includes(entry.status);
  const { reEntry, addOn, allowQuit } = s.settings;
  return {
    entry,
    pending,
    canRegister: !over && !entry && !pending.some((r) => r.kind === 'register') && registrationOpen(s),
    canUnregister: !over && ((entry?.status === 'registered' && s.status === 'registering') || pending.some((r) => r.kind === 'register')),
    canRebuy: !over && entry?.status === 'rebuy-offer' && !pending.some((r) => r.kind === 'rebuy'),
    canDeclineRebuy: !over && entry?.status === 'rebuy-offer',
    canAddOn: !over && entry?.status === 'seated' && addOnsOpen(s) && entry.addOns < addOn.max && !pending.some((r) => r.kind === 'add-on'),
    canReEnter:
      !over &&
      entry?.status === 'busted' &&
      !entry.supersededBy &&
      reEntryOpen(s) &&
      (reEntry.max === null || entry.entryNo - 1 < reEntry.max) &&
      !pending.some((r) => r.kind === 're-entry'),
    canQuit: !over && allowQuit && alive && entry!.status !== 'registered',
    canCheckIn: !over && !!entry && mayCheckIn(s, entry) && checkedInCount(s) < s.settings.maxEntrants,
    checkedIn: entry?.checkedInAt !== undefined && entry.status === 'registered',
    checkInOpensAt: myGroupOpensAt(s, entry),
  };
}

function myGroupOpensAt(s: TournamentState, entry: Entry | null): number | null {
  if (!entry || !checkInActive(s) || entry.status !== 'registered' || entry.checkedInAt !== undefined) return null;
  const group = checkInGroupOf(s, entry);
  if (group < 0 || group < (s.checkIn?.groupsOpen ?? 0)) return null;
  return groupOpensAt(s, group);
}
