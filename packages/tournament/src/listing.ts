import type { BettingKind } from '@rsdp/engine/core';
// One line per tournament for the home page lists: what it is, when it starts
// or how far it has got, and where the viewer stands in it.

import { standings } from './director';
import { summarize } from './summary';
import type { PlayerId, TournamentState, TournamentStatus } from './types';

export interface TournamentListing {
  id: string;
  name: string;
  status: TournamentStatus;
  start: 'manual' | 'scheduled' | 'sng';
  /** Deal time once known; for a running or finished event, when it started. */
  startAt: number | null;
  finishedAt: number | null;
  games: string[];
  /** Betting for each game, as in the settings; left out when every game plays its usual betting. */
  gameBetting?: (BettingKind | null)[];
  startingStack: number;
  entrants: number;
  maxEntrants: number;
  playersLeft: number;
  /** Sit & Go still filling: players still needed. */
  playersNeeded: number | null;
  /** Running: the level being played. */
  levelNumber: number | null;
  winner: string | null;
  /** The next event of a series or Sit & Go, once made. */
  nextId: string | null;
  me: {
    hosting: boolean;
    /** Holds an entry (any status) or a pending registration. */
    registered: boolean;
    /** Still in: registered, seated or deciding on a rebuy. */
    alive: boolean;
    place: number | null;
  };
}

const OVER = new Set<TournamentStatus>(['finished', 'cancelled']);

export function tournamentListing(s: TournamentState, me: PlayerId | null, now: number, nextId: string | null = null): TournamentListing {
  const sum = summarize(s, now);
  const mine = me ? s.entries.filter((e) => e.playerId === me).sort((a, b) => b.entryNo - a.entryNo)[0] : undefined;
  const pending = !!me && s.requests.some((r) => r.playerId === me && r.kind === 'register');
  const ranks = OVER.has(s.status) || mine ? standings(s) : [];
  const place = mine ? (ranks.find((r) => r.entryId === mine.id)?.place ?? null) : null;
  return {
    id: s.id,
    name: s.settings.name,
    status: s.status,
    start: s.settings.start.kind,
    startAt: s.startedAt ?? s.startAt,
    finishedAt: s.finishedAt,
    games: s.settings.games,
    ...(s.settings.gameBetting ? { gameBetting: s.settings.gameBetting } : {}),
    startingStack: s.settings.startingStack,
    entrants: sum.entrants,
    maxEntrants: s.settings.maxEntrants,
    playersLeft: sum.playersLeft,
    playersNeeded: sum.playersNeeded,
    levelNumber: sum.clock && !OVER.has(s.status) ? sum.clock.levelNumber : null,
    winner: s.status === 'finished' ? (ranks.find((r) => r.place === 1)?.displayName ?? null) : null,
    nextId,
    me: {
      hosting: !!me && s.hostId === me,
      registered: !!mine || pending,
      alive: !!mine && ['registered', 'seated', 'rebuy-offer'].includes(mine.status),
      place,
    },
  };
}

/** Still to come or under way. */
export const isLive = (s: { status: TournamentStatus }) => !OVER.has(s.status);

/**
 * Home page order: running events first, then the soonest start, with
 * start-when-ready events after the dated ones; finished events newest first.
 */
export function sortListings(list: TournamentListing[]): TournamentListing[] {
  const rank = (t: TournamentListing) => (t.status === 'running' || t.status === 'paused' ? 0 : t.status === 'seating' ? 1 : isLive(t) ? 2 : 3);
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    if (rank(a) === 3) return (b.finishedAt ?? b.startAt ?? 0) - (a.finishedAt ?? a.startAt ?? 0);
    if (a.startAt !== b.startAt) return (a.startAt ?? Infinity) - (b.startAt ?? Infinity);
    return a.name.localeCompare(b.name);
  });
}

/**
 * Shown to everyone on the home page. Archived and invite-only events never
 * are; finished ones only show under the viewer's own tournaments.
 */
export function listedPublicly(s: TournamentState): boolean {
  if (isArchived(s)) return false;
  // Invite-only events are found through their link.
  if (s.settings.invites?.required) return false;
  return isLive(s);
}

/** Archived by its host (host tools): off every list. */
export const isArchived = (s: TournamentState) => !!(s as { archivedAt?: number | null }).archivedAt;
