import type { LogEvent } from '@rsdp/tournament';
import { blinds, gameName, money, ordinal } from './format';

const chips = (n: number) => n.toLocaleString();

/** One line of the lobby's activity log. */
export function logText(e: LogEvent): string {
  switch (e.type) {
    case 'registered':
      return e.entryNo > 1 ? `${e.name} re-entered` : `${e.name} registered${e.late ? ' (late)' : ''}`;
    case 'unregistered':
      return e.notCheckedIn ? `${e.name} didn't check in and lost their seat` : `${e.name} unregistered`;
    case 'bountyWon':
      return `${e.name} collected ${e.from}'s bounty${e.cash ? ` (${money(e.cash)})` : ''}`;
    case 'started':
      return 'Cards in the air. The tournament has started.';
    case 'startDelayed':
      return 'Waiting for a second player before starting';
    case 'levelUp':
      return `Level ${e.levelNumber}: ${blinds(e)}${e.gameId ? ` · ${gameName(e.gameId, e.betting)}` : ''}`;
    case 'breakStarted':
      return `${e.minutes}-minute break${e.addOn ? ' · add-ons open' : ''}`;
    case 'breakEnded':
      return 'Break over';
    case 'lateRegistrationClosed':
      return 'Late registration closed';
    case 'rebuysClosed':
      return 'Rebuys closed';
    case 'reEntryClosed':
      return 'Re-entry closed';
    case 'chipsAdded':
      return `${e.name} ${e.reason === 'rebuy' ? 'rebought' : 'took the add-on'} for ${chips(e.chips)}`;
    case 'eliminated': {
      const how = e.reason === 'quit' ? 'left' : e.reason === 'removed' ? 'was removed' : 'busted';
      const by = e.reason === 'busted' && e.by.length ? ` by ${e.by.join(' and ')}` : '';
      return `${e.name} ${how} in ${ordinal(e.place)}${by}`;
    }
    case 'tableBroken':
      return 'A table broke; players moved to fill seats';
    case 'handForHand':
      return e.active ? 'Hand-for-hand on the bubble' : 'Hand-for-hand over';
    case 'paused':
      return 'The host paused the tournament';
    case 'resumed':
      return 'The tournament resumed';
    case 'structureEdited':
      return 'The host changed the blind levels';
    case 'finished':
      return e.winner ? `🏆 ${e.winner} wins the tournament` : 'The tournament is over';
    case 'cancelled':
      return e.reason === 'host' ? 'The host cancelled the tournament' : 'Cancelled: not enough players';
    case 'stackSet':
      return `The host set ${e.name}'s stack to ${chips(e.stack)} (was ${chips(e.previous)})`;
    case 'seatsSwapped':
      return `The host swapped the seats of ${e.names.join(' and ')}`;
    case 'seatMoved':
      return `The host moved ${e.name} to another seat`;
    case 'coHostsChanged':
      return 'The host changed the co-hosts';
    case 'hostChanged':
      return `${e.name} is now the host`;
    case 'archived':
      return 'The tournament was archived';
    default:
      return '';
  }
}
