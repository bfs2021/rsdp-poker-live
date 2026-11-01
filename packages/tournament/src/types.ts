// Tournament director contracts. State is plain JSON and is snapshotted by the
// server (see STATE_VERSION before changing its shape).

import type { CoHost, HostPower } from '@rsdp/engine/roles';
import type { PayoutStructure, PrizeMoney } from './payouts';
import type { Schedule } from './recurrence';
import type { AnteType, StructureRow } from './structure';

/**
 * Layout version of a saved TournamentState. Don't bump it to mark a new field: the server ignores any saved
 * tournament with another version (`usable` in apps/server/src/tournament/store.ts), so after a bump every running
 * and past tournament would vanish from the lobby, players' histories and season boards.
 *
 * Keep old states readable instead: add fields as optional ("missing in state saved before ...") and fill them in
 * where a tournament is loaded (as the store does for `spawnedFrom`, and the manager for an event's table rules).
 * Only a change old states can't be read under at all needs a bump, and then the store must convert the old version
 * first. RUNTIME_VERSION for tables (apps/server/src/runtime/types.ts) works the same way.
 */
export const STATE_VERSION = 1;

/** Opaque account or guest id from the server. */
export type PlayerId = string;
/** Minted by the director: `${tournamentId}:e${n}`. One player can hold several entries (re-entry). */
export type EntryId = string;
/** Minted by the director: `${tournamentId}:t${n}`. */
export type TableId = string;

export type StartRule =
  /** The host starts with startNow. */
  | { kind: 'manual' }
  /** Starts by itself at startAt. `schedule` makes it one occurrence of a series. */
  | { kind: 'scheduled'; startAt: number; schedule?: Schedule }
  /** Seats as soon as playersNeeded register, deals after startDelaySeconds. */
  | { kind: 'sng'; playersNeeded: number; startDelaySeconds: number; autoSpawn: boolean };

export interface TournamentSettings {
  name: string;
  start: StartRule;
  /** Games in rotation, one per level; one entry for a single game. */
  games: string[];
  /** Stop rotating from this level on and stay on that level's game. */
  stopRotationAtLevel?: number;
  structure: StructureRow[];
  startingStack: number;
  /** 2-10. */
  seatsPerTable: number;
  /** 2-600. */
  maxEntrants: number;
  /** Scheduled start: tables are created and seated this long before startAt. Default 60 s. */
  seatLeadSeconds: number;
  /** Scheduled start with fewer than 2 entrants: keep registration open this long, then cancel. Default 15. */
  graceMinutes: number;
  /** Host must approve registrations (including late ones). */
  registrationApproval: boolean;
  /** Closes at the end of throughLevel; null keeps it open while the event has room. */
  lateRegistration: { enabled: boolean; throughLevel: number | null };
  reEntry: { enabled: boolean; throughLevel: number | null; /** Re-entries per player; null = unlimited. */ max: number | null; approval: boolean };
  /** Rebuys are allowed during levels marked `rebuy` in the structure. max 0 = off. */
  rebuy: { max: number; chips: number; approval: boolean; offerSeconds: number };
  /** Add-ons are allowed during breaks marked `addOn`. max 0 = off. */
  addOn: { max: number; chips: number; approval: boolean };
  /** Players may leave for good before busting. */
  allowQuit: boolean;
  /** Display-only prize pool and payouts. */
  payouts?: { structure: PayoutStructure; money: PrizeMoney };
  /** Play hand-for-hand on the bubble when payouts are set. */
  handForHand: boolean;
  /** Display-only bounty on every entry; absent = no bounties. */
  bounty?: BountySettings;
  /** Invite codes; absent = codes are optional and only skip approval when a code is used. */
  invites?: InviteSettings;
  /** Check-in groups (not for Sit & Go); absent = registering holds a seat. */
  checkIn?: CheckInSettings;
  /** Counts toward a season leaderboard. An empty id starts a new season named after this event's id. */
  season?: { id: string; name: string };
  /** Clock, time bank and rabbit hunting at this event's tables (straddles are always off in tournaments); absent = the site's table defaults. */
  tableRules?: TableRules;
}

export interface TableRules {
  /** Seconds per decision: 0 for no clock, otherwise 5-600. */
  decisionSeconds: number;
  /** Time bank each player can draw on, 0-300 seconds. */
  timeBankSeconds: number;
  /** Hands between time bank refills, 0-200 (0 = never refills). */
  timeBankRefillHands: number;
  /** Players may see the cards that would have come after a hand ends early. */
  rabbitHunt: boolean;
}

export interface BountySettings {
  /** Money (cents) on each entry's head, paid to whoever knocks it out. Each rebuy and re-entry buys a fresh one. */
  amount: number;
  /** Progressive knockout: this share (0-100) of each bounty won goes onto the winner's own head. 0 = a regular bounty. */
  progressivePercent: number;
}

export interface InviteSettings {
  /** Registering needs a valid code. */
  required: boolean;
  /** A valid code skips host approval of the registration. */
  autoApprove: boolean;
}

export interface CheckInGroup {
  /** Who may check in: the first N on the registration list, or null for everyone registered. */
  firstN: number | null;
  /** Minutes after this group opens that the next one opens. */
  waitMinutes: number;
}

export interface CheckInSettings {
  /** 1-15 groups, opened in order; once open a group stays open. */
  groups: CheckInGroup[];
  /** Scheduled start: the first group opens this long before startAt. Other starts open check-in by host command. */
  opensMinutesBefore: number;
}

export interface InviteCode {
  code: string;
  /** null = any number of players (a code to share in a group chat). */
  maxUses: number | null;
  createdAt: number;
  cancelled: boolean;
  usedBy: { playerId: PlayerId; displayName: string; at: number }[];
}

export type TournamentStatus = 'registering' | 'seating' | 'running' | 'paused' | 'finished' | 'cancelled';

export type EntryStatus =
  /** Registered, not seated yet. */
  | 'registered'
  | 'seated'
  /** Busted with a rebuy offer open. Keeps the seat; the table holds. */
  | 'rebuy-offer'
  | 'busted'
  | 'quit'
  | 'removed';

export interface Entry {
  id: EntryId;
  playerId: PlayerId;
  displayName: string;
  /** 1 for the first entry, 2 for the first re-entry, ... */
  entryNo: number;
  status: EntryStatus;
  stack: number;
  tableId: TableId | null;
  seat: number | null;
  rebuys: number;
  addOns: number;
  registeredAt: number;
  /** Set when a re-entry replaced this busted entry; it then takes no finishing place. */
  supersededBy?: EntryId;
  rebuyOfferExpiresAt?: number;
  /** Quit or host removal waiting for the current hand to end. */
  leaveRequested?: 'quit' | 'removed';
  /** A host stack edit waiting for the current hand to end, and who made it. */
  pendingStack?: number;
  pendingStackBy?: PlayerId;
  /** The hand that took their last chip (or when they left), and the hand-for-hand round it was in. */
  bust?: { at: number; startStack: number; tableId: TableId | null; by: PlayerId[]; hfhRound?: number };
  /** Bounty tournaments: money (cents) on this entry's head now. */
  bounty?: number;
  /** Bounty money (cents) this entry has collected. */
  bountiesWon?: number;
  /** Players this entry has knocked out (a split pot counts for every winner). */
  knockouts?: number;
  /** Check-in tournaments: when this entry checked in. */
  checkedInAt?: number;
}

export interface TableState {
  id: TableId;
  /** Entry id per seat. */
  seats: (EntryId | null)[];
  inHand: boolean;
  lastHandNumber: number;
  /** Button seat of the last hand, if the runtime reported it. */
  button: number | null;
  /** Hand-for-hand round this table last dealt in. */
  hfhPlayed: number;
  /** Hand-for-hand round of the hand in progress, or null when it is a normal hand. */
  hfhHand: number | null;
}

export type RequestKind = 'register' | 're-entry' | 'rebuy' | 'add-on';

export interface PendingRequest {
  id: string;
  kind: RequestKind;
  playerId: PlayerId;
  displayName: string;
  /** For rebuy, add-on and re-entry: the entry it applies to. */
  entryId?: EntryId;
  at: number;
  /** Invite code given with a registration; used when the host approves. */
  code?: string;
}

export interface EliminationGroup {
  /** Entries knocked out together, with what decides their order. */
  members: { entryId: EntryId; startStack: number; tableId: TableId | null }[];
  /** When the last of them was knocked out (a rebuy offer can end well after the hand). */
  at: number;
  /**
   * When they went out at the table, where that was before `at`: the hand that busted players who were then offered
   * a rebuy and didn't take it. Groups are kept in this order (bustAt, else at), so they place by when they busted.
   */
  bustAt?: number;
  /** Players who lost their last chip in one hand (not leavers): a busted player whose rebuy offer ends later joins it. */
  busted?: true;
  /** Set for hand-for-hand busts. */
  hfhRound?: number;
}

export interface TournamentState {
  version: typeof STATE_VERSION;
  id: string;
  hostId: PlayerId;
  /** Players the host shares some powers with. Missing in state saved before co-hosts. */
  coHosts?: CoHost[];
  /** Hidden from lists; set by the host or by cleanup. Missing or null: not archived. */
  archivedAt?: number | null;
  /**
   * The event before this one, when the server opened it as the next of a series or Sit & Go. Missing: the host made
   * it (states saved before this field existed get it from the event before's saved link when the server loads them).
   */
  spawnedFrom?: string;
  /**
   * Why the server could not open the next event of this series or Sit & Go, for the lobby to show. Set and cleared by
   * the server, never by the director. Missing: nothing went wrong (or the state was saved before this was kept).
   */
  nextError?: string;
  settings: TournamentSettings;
  status: TournamentStatus;
  createdAt: number;
  /** Deal time once known (scheduled start, or SNG seat time + delay). */
  startAt: number | null;
  /** Scheduled start with fewer than 2 entrants: when to give up. */
  graceUntil: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  clock: {
    /** Running time banked before runningSince. */
    elapsedMs: number;
    /** Wall time the clock last started, or null while stopped. */
    runningSince: number | null;
    /** Row of the structure that tick last moved to. */
    rowIndex: number;
  };
  entries: Entry[];
  tables: TableState[];
  requests: PendingRequest[];
  eliminations: EliminationGroup[];
  handForHand: { active: boolean; round: number };
  counters: { entry: number; table: number; request: number };
  /** mulberry32 state for seating draws. */
  rng: number;
  /** Invite codes the host has made. Only the host is sent these. */
  invites?: InviteCode[];
  /** Check-in progress: when the first group opened, and how many groups are open. */
  checkIn?: { openedAt: number | null; groupsOpen: number };
}

// ---------------------------------------------------------------------------
// Inputs

/** What the runtime reports after each hand on a tournament table. */
export interface HandResult {
  tableId: TableId;
  handNumber: number;
  startStacks: Record<PlayerId, number>;
  endStacks: Record<PlayerId, number>;
  /** Who won chips from each busted player (several when the busting pot was split). */
  knockedOutBy?: Record<PlayerId, PlayerId[]>;
  /** Button seat of this hand; used to pick who moves when balancing. */
  button?: number;
}

export type Command =
  | { type: 'register'; playerId: PlayerId; displayName: string; code?: string }
  | { type: 'checkIn'; playerId: PlayerId }
  | { type: 'unregister'; playerId: PlayerId }
  | { type: 'rebuy'; playerId: PlayerId }
  | { type: 'declineRebuy'; playerId: PlayerId }
  | { type: 'addOn'; playerId: PlayerId }
  | { type: 'reEnter'; playerId: PlayerId }
  | { type: 'quit'; playerId: PlayerId }
  /** `stack` seats a registration or re-entry with other than the starting stack (a handicap). */
  | { type: 'approve'; by: PlayerId; requestId: string; stack?: number }
  | { type: 'reject'; by: PlayerId; requestId: string }
  | { type: 'remove'; by: PlayerId; playerId: PlayerId }
  | { type: 'pause'; by: PlayerId }
  | { type: 'resume'; by: PlayerId }
  | { type: 'startNow'; by: PlayerId }
  | { type: 'editStructure'; by: PlayerId; structure: StructureRow[] }
  | { type: 'updateSettings'; by: PlayerId; settings: Partial<TournamentSettings> }
  /** Before the start: cancel. Paused with no hand running: end and rank the rest by chips. */
  | { type: 'end'; by: PlayerId }
  /** Adds a co-host or changes their powers. Only someone already in the event can be one. */
  | { type: 'setCoHost'; by: PlayerId; playerId: PlayerId; powers: HostPower[] }
  /** The host removes a co-host, or a co-host steps down. */
  | { type: 'removeCoHost'; by: PlayerId; playerId: PlayerId }
  /** Hands the host role on; the old host stays as a co-host with every power. */
  | { type: 'transferHost'; by: PlayerId; to: PlayerId; byName?: string }
  /** Sets a player's stack; during their hand it applies when the hand ends. Not a rebuy. */
  | { type: 'setStack'; by: PlayerId; playerId: PlayerId; stack: number }
  /** Moves a seated player to a seat between hands; a taken seat swaps the two players. */
  | { type: 'movePlayer'; by: PlayerId; playerId: PlayerId; tableId: TableId; seat: number }
  /** Hides the tournament from lists. Before the start it cancels it too; once started, end it first. */
  | { type: 'archive'; by: PlayerId }
  /** Makes `count` codes. The server fills in `codes` from a secure source; without them the director draws its own. */
  | { type: 'createInvites'; by: PlayerId; count: number; maxUses: number | null; codes?: string[] }
  | { type: 'cancelInvite'; by: PlayerId; code: string }
  /** Opens check-in now (events that do not open it on a schedule). */
  | { type: 'openCheckIn'; by: PlayerId }
  | { type: 'handStarted'; tableId: TableId; handNumber: number }
  | { type: 'handResult'; result: HandResult };

// ---------------------------------------------------------------------------
// Outputs

export interface SeatInfo {
  tableId: TableId;
  seat: number;
  entryId: EntryId;
  playerId: PlayerId;
  displayName: string;
  stack: number;
}

export type DirectorEvent =
  /** `stack` is set when the host approved a stack other than the starting stack. */
  | { type: 'registered'; entryId: EntryId; playerId: PlayerId; displayName: string; late: boolean; entryNo: number; stack?: number }
  | { type: 'unregistered'; playerId: PlayerId; reason?: 'not-checked-in' }
  /** A check-in group opened; `playerIds` may check in from now (nobody is told twice). */
  | { type: 'checkInOpened'; group: number; playerIds: PlayerId[] }
  | { type: 'checkedIn'; playerId: PlayerId }
  /** A knockout paid a bounty: `cash` to the winner, `headAdded` onto their own head (progressive). */
  | { type: 'bountyWon'; entryId: EntryId; playerId: PlayerId; fromEntryId: EntryId; fromPlayerId: PlayerId; cash: number; headAdded: number }
  | { type: 'invitesCreated'; codes: string[] }
  | { type: 'requestPending'; request: PendingRequest }
  | { type: 'requestRejected'; request: PendingRequest }
  | { type: 'tablesCreated'; tables: { tableId: TableId; seats: SeatInfo[] }[] }
  /** Open a new table (late registration overflow). */
  | { type: 'tableOpened'; tableId: TableId }
  | { type: 'startDelayed'; reason: 'not-enough-players'; graceUntil: number }
  | { type: 'started'; at: number }
  | { type: 'levelUp'; levelNumber: number; sb: number; bb: number; ante: number; anteType: AnteType; gameId: string }
  | { type: 'breakStarted'; minutes: number; endsAt: number; addOn: boolean }
  | { type: 'breakEnded' }
  | { type: 'lateRegistrationClosed' }
  | { type: 'rebuysClosed' }
  | { type: 'reEntryClosed' }
  /** Seat a player at a table before its next hand. */
  | { type: 'seatPlayer'; seat: SeatInfo; reason: 'late-registration' | 're-entry' }
  /** Move between hands of the source table; the player is dealt in at the destination's next hand. */
  | { type: 'moveSeat'; entryId: EntryId; playerId: PlayerId; from: { tableId: TableId; seat: number }; to: { tableId: TableId; seat: number }; stack: number; by?: PlayerId }
  /** Two players trade seats between hands (a host move onto a taken seat). Unseat both, then seat both. */
  | { type: 'seatsSwapped'; by: PlayerId; moves: Extract<DirectorEvent, { type: 'moveSeat' }>[] }
  /** A host stack edit. `applied` false: it waits for the player's hand to end, and comes again once it lands. */
  | { type: 'stackSet'; by: PlayerId; entryId: EntryId; playerId: PlayerId; tableId: TableId | null; seat: number | null; stack: number; previous: number; applied: boolean }
  | { type: 'coHostsChanged'; by: PlayerId }
  | { type: 'hostChanged'; by: PlayerId; hostId: PlayerId }
  | { type: 'archived'; by: PlayerId | null }
  | { type: 'tableBroken'; tableId: TableId }
  | { type: 'rebuyOffered'; entryId: EntryId; playerId: PlayerId; expiresAt: number; chips: number }
  /** Add chips to a seated player's stack before their next hand. */
  | { type: 'stackAdded'; entryId: EntryId; playerId: PlayerId; tableId: TableId | null; seat: number | null; chips: number; reason: 'rebuy' | 'add-on' }
  /** Leaves the table for good. */
  | { type: 'eliminated'; entryId: EntryId; playerId: PlayerId; place: number; by: PlayerId[]; tableId: TableId | null; seat: number | null; reason: 'busted' | 'quit' | 'removed' }
  | { type: 'handForHand'; active: boolean }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'structureEdited' }
  | { type: 'settingsUpdated' }
  | { type: 'finished'; standings: Standing[] }
  | { type: 'cancelled'; reason: 'not-enough-players' | 'host' }
  /** A recurring series: the server should create the next occurrence at this time with the same settings. */
  | { type: 'scheduleNext'; startAt: number }
  /** A Sit & Go with auto-spawn: the server should open a fresh copy with the same settings. */
  | { type: 'spawnNext' };

export interface Standing {
  entryId: EntryId;
  playerId: PlayerId;
  displayName: string;
  entryNo: number;
  /** Finishing place; null while still playing. Tied players share a place. */
  place: number | null;
  stack: number;
  /** Rebuys and add-ons over all of this player's entries. */
  rebuys: number;
  addOns: number;
  /** Display-only prize for a finished place (0 when out of the money or no payouts set). */
  prize: number;
  eliminatedBy: PlayerId[];
  /** Bounty money (cents) collected; 0 without bounties. */
  bounties: number;
  knockouts: number;
  /** Bounty still on this entry's head; 0 once knocked out. */
  bounty: number;
}

export interface Result {
  state: TournamentState;
  events: DirectorEvent[];
}

export type Gate = 'deal' | 'hold';

export interface LevelStakes {
  levelNumber: number;
  gameId: string;
  sb: number;
  bb: number;
  ante: number;
  anteType: AnteType;
  bringIn: number;
  smallBet: number;
  bigBet: number;
}
