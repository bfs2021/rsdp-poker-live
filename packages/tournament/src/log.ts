// The lobby's public record: director events turned into what everyone may
// read (names, not player ids; no approval requests), plus lobby chat.

import type { BettingKind } from '@rsdp/engine/core';
import type { AnteType } from './structure';
import type { DirectorEvent, PlayerId, TournamentState } from './types';

export type LogEvent =
  | { type: 'registered'; name: string; late: boolean; entryNo: number }
  | { type: 'unregistered'; name: string; notCheckedIn?: boolean }
  | { type: 'bountyWon'; name: string; from: string; cash: number }
  | { type: 'started' }
  | { type: 'startDelayed'; graceUntil: number }
  | { type: 'levelUp'; levelNumber: number; sb: number; bb: number; ante: number; anteType: AnteType; gameId: string; betting?: BettingKind }
  | { type: 'breakStarted'; minutes: number; addOn: boolean }
  | { type: 'breakEnded' }
  | { type: 'lateRegistrationClosed' }
  | { type: 'rebuysClosed' }
  | { type: 'reEntryClosed' }
  | { type: 'chipsAdded'; name: string; chips: number; reason: 'rebuy' | 'add-on' }
  | { type: 'eliminated'; name: string; place: number; by: string[]; reason: 'busted' | 'quit' | 'removed' }
  | { type: 'tableBroken' }
  | { type: 'handForHand'; active: boolean }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'structureEdited' }
  | { type: 'finished'; winner: string | null }
  | { type: 'cancelled'; reason: 'not-enough-players' | 'host' }
  /** Host tools: a stack edit once it lands, a swap, a seat move by the host, co-hosts, a new host, archive. */
  | { type: 'stackSet'; name: string; stack: number; previous: number }
  | { type: 'seatsSwapped'; names: string[] }
  | { type: 'seatMoved'; name: string }
  | { type: 'coHostsChanged' }
  | { type: 'hostChanged'; name: string }
  | { type: 'archived' };

export type LobbyItem =
  | { id: string; at: number; kind: 'chat'; playerId: PlayerId; name: string; text: string }
  | { id: string; at: number; kind: 'event'; event: LogEvent };

/** Longest lobby chat message. */
export const LOBBY_CHAT_MAX = 300;

/** A player's name in any of these states (an unregistered player is only in the one before). */
export function namesIn(...states: (TournamentState | null | undefined)[]) {
  return (playerId: PlayerId) => {
    for (const s of states) {
      const n =
        s?.entries.filter((x) => x.playerId === playerId).at(-1)?.displayName ??
        s?.requests.find((r) => r.playerId === playerId)?.displayName ??
        s?.coHosts?.find((c) => c.playerId === playerId)?.name;
      if (n) return n;
    }
    return 'A player';
  };
}

/** What the public log says about a director event, or null for one it leaves out. */
export function logEvent(e: DirectorEvent, name: (playerId: PlayerId) => string): LogEvent | null {
  switch (e.type) {
    case 'registered':
      return { type: 'registered', name: e.displayName, late: e.late, entryNo: e.entryNo };
    case 'unregistered':
      return e.reason === 'not-checked-in' ? { type: 'unregistered', name: name(e.playerId), notCheckedIn: true } : { type: 'unregistered', name: name(e.playerId) };
    case 'bountyWon':
      return { type: 'bountyWon', name: name(e.playerId), from: name(e.fromPlayerId), cash: e.cash };
    case 'started':
      return { type: 'started' };
    case 'startDelayed':
      return { type: 'startDelayed', graceUntil: e.graceUntil };
    case 'levelUp':
      return { type: 'levelUp', levelNumber: e.levelNumber, sb: e.sb, bb: e.bb, ante: e.ante, anteType: e.anteType, gameId: e.gameId, ...(e.betting ? { betting: e.betting } : {}) };
    case 'breakStarted':
      return { type: 'breakStarted', minutes: e.minutes, addOn: e.addOn };
    case 'breakEnded':
    case 'lateRegistrationClosed':
    case 'rebuysClosed':
    case 'reEntryClosed':
    case 'paused':
    case 'resumed':
    case 'structureEdited':
    case 'tableBroken':
      return { type: e.type };
    case 'stackAdded':
      return { type: 'chipsAdded', name: name(e.playerId), chips: e.chips, reason: e.reason };
    case 'eliminated':
      return { type: 'eliminated', name: name(e.playerId), place: e.place, by: e.by.map(name), reason: e.reason };
    case 'handForHand':
      return { type: 'handForHand', active: e.active };
    case 'finished':
      return { type: 'finished', winner: e.standings.find((x) => x.place === 1)?.displayName ?? null };
    case 'cancelled':
      return { type: 'cancelled', reason: e.reason };
    case 'stackSet':
      return e.applied ? { type: 'stackSet', name: name(e.playerId), stack: e.stack, previous: e.previous } : null;
    case 'seatsSwapped':
      return { type: 'seatsSwapped', names: e.moves.map((m) => name(m.playerId)) };
    case 'moveSeat':
      // Balancing moves are routine; a host's move is logged.
      return e.by ? { type: 'seatMoved', name: name(e.playerId) } : null;
    case 'coHostsChanged':
      return { type: 'coHostsChanged' };
    case 'hostChanged':
      return { type: 'hostChanged', name: name(e.hostId) };
    case 'archived':
      return { type: 'archived' };
    default:
      // Requests and seat moves are not news for the lobby; seating draws show at the tables.
      return null;
  }
}
