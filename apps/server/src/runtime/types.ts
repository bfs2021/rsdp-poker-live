import type { BettingKind, HandFairness, HandState, PlayerId, Stakes } from '@rsdp/engine/core';
import type { SettingsChange, SettingsPatch, TableSettings } from '@rsdp/engine/settings';
import type { CoHost } from '@rsdp/engine/roles';
import type { BotLevel, BotNote } from '@rsdp/engine/wire';

/**
 * Snapshot layout version for RuntimeState. Don't bump it to mark a new field: a saved table whose snapshot has
 * another version is not loaded at all (loadTable in storage.ts returns null). After a bump, every saved cash table
 * would be "not found", its players unable to get back to it or cash out, and every running tournament table would
 * start again from the director's seats, losing its hand in play, its old snapshot overwritten at the next save.
 *
 * Keep old snapshots readable instead: add fields as optional ("missing in older snapshots") and fill them in when a
 * table loads or resumes (as getTable in app.ts does for realGame, and giveBotsLooks in table.ts for bot looks). Only
 * a change old snapshots can't be read under at all needs a bump, and then loadTable must convert the old version first.
 */
export const RUNTIME_VERSION = 1;

/** Time and timers, injected so tests can run a table on a fake clock. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface SeatState {
  seat: number;
  playerId: PlayerId;
  name: string;
  stack: number;
  /** Not dealt in (cash) or auto-folded (tournament). */
  sittingOut: boolean;
  sitOutReason: 'player' | 'timeouts' | 'busted' | 'host' | null;
  /** Joined since the last hand and has not posted yet. */
  isNew: boolean;
  missedSmallBlind: boolean;
  missedBigBlind: boolean;
  /** Player preference: wait for the big blind instead of posting to play. */
  waitForBigBlind: boolean;
  /** Player preference: straddle when under the gun (or on the button). */
  straddle: boolean;
  /** Player preference: take part in Nit game rounds (absent in older snapshots). */
  nitOptIn?: boolean;
  /** Emoji shown by the seat (absent in older snapshots). */
  mood?: string | null;
  /** Turns in a row the clock ran out. */
  timeouts: number;
  /** Seconds left in this player's time bank. */
  timeBank: number;
  handsSinceRefill: number;
  /** Stand up once the current hand ends. */
  leaveAfterHand: boolean;
  /** leaveAfterHand was set because the player was offline too long; coming back undoes it. */
  released?: boolean;
  /** Chips approved to add before the next hand (rebuys, host top-ups). */
  pendingChips: number;
  /** Host set the stack to this before the next hand. */
  pendingStack: number | null;
}

export interface SeatRequest {
  id: string;
  kind: 'seat' | 'rebuy';
  playerId: PlayerId;
  name: string;
  /** Seat asked for (seat requests). */
  seat: number | null;
  /** Buy-in or rebuy amount. */
  amount: number;
  at: number;
  /** The player agreed to spectators seeing their cards (seat requests). */
  consent?: boolean;
}

/** Someone queued for a seat at a full table. */
export interface WaitlistEntry {
  playerId: PlayerId;
  name: string;
  /** The buy-in they will sit with. */
  stack: number;
  at: number;
}

/** A free seat held for the next person on the waitlist until they take it or time runs out. */
export interface SeatOffer {
  seat: number;
  playerId: PlayerId;
  expiresAt: number;
}

export interface LedgerRow {
  playerId: PlayerId;
  name: string;
  /** Everything brought to the table: buy-ins, rebuys and host top-ups. */
  buyIn: number;
  /** Everything taken away when leaving. */
  cashOut: number;
  /** A practice bot's chips: kept for the chip count, but no money is owed to or by a bot. */
  bot?: true;
  /** A bot's owner and look (BOT_LOOKS), kept so its old hands still show whose robot it was. */
  owner?: string;
  look?: number;
}

/**
 * Every practice bot a saved table has had, as TableRuntime.botBadge tells them: the bots it has now, and the ledger
 * rows bots keep for good (flagged since bots came, and the ledger is never cleared). Never the 'bot-' prefix: a
 * person's id is random and can start with it too.
 */
export function botIdsOf(state: { bots?: Record<string, unknown> | null; ledger?: Record<string, { bot?: boolean } | null> | null } | null | undefined): Set<PlayerId> {
  const ids = new Set<PlayerId>(Object.keys(state?.bots ?? {}));
  for (const [id, row] of Object.entries(state?.ledger ?? {})) if (row?.bot) ids.add(id);
  return ids;
}

export interface ChatMessage {
  at: number;
  playerId: PlayerId | null;
  name: string;
  text: string;
}

/** One line in the table's activity log (joins, settings changes, host actions). */
export interface TableLogEntry {
  at: number;
  text: string;
}

/** A new line of the table's log or chat, as handed to TableRuntime.onLine. */
export type TableLine = { kind: 'log'; entry: TableLogEntry } | { kind: 'chat'; entry: ChatMessage };

export interface SettingsLogEntry {
  at: number;
  by: PlayerId;
  /** Applied now, or waiting for the next hand. */
  when: 'now' | 'next-hand';
  changes: SettingsChange[];
}

/** What hand history keeps of a finished hand: enough to show it to each viewer, no deck. */
export interface PastHand {
  handNumber: number;
  startedAt: number;
  endedAt: number;
  gameName: string;
  betting: BettingKind;
  stakes: Stakes;
  button: number;
  seats: { seat: number; playerId: PlayerId; startStack: number }[];
  events: HandState['events'];
  /** Missing on hands dealt before provably fair dealing. */
  handId?: string;
  fair?: HandFairness;
  /** Why each practice bot played as it did, for the one person in the hand (see RuntimeState.coach). Absent on every other hand. */
  coach?: { person: PlayerId; notes: BotNote[] };
}

/** The secret behind the next hand's published commitment. Server-only: never put serverSeed in a view. */
export interface FairState {
  next: { serverSeed: string; commit: string };
  /** Client seeds sent for the next hand, by player. */
  clientSeeds: Record<PlayerId, string>;
  /** Hands up to this number are revealed (the game stayed stopped FAIR_STOP_REVEAL_MS after it). */
  revealedThrough: number;
  /** The host stopped the game after hand `through` at `at`: those hands open FAIR_STOP_REVEAL_MS later unless it starts again first. */
  stopped?: { through: number; at: number };
  /** When `next` was committed to. Missing in snapshots from before it existed. */
  committedAt?: number;
}

/** A finished hand kept in memory for the hand log and replayer; the server also stores it. */
export interface HandRecord {
  handNumber: number;
  startedAt: number;
  endedAt: number;
  hand: HandState;
  /** Why each practice bot played as it did, for the one person in the hand (see RuntimeState.coach). Absent on every other hand. */
  coach?: { person: PlayerId; notes: BotNote[] };
}

export interface TurnClock {
  /** Hand number and event count when the turn started, so a stale timer never fires on a later turn. */
  key: string;
  seat: number;
  startedAt: number;
  deadline: number | null;
  /** True once the time bank is running. */
  usingBank: boolean;
  /** Deadline before the time bank kicked in. */
  bankFrom: number | null;
}

/** Side-game progress kept between hands (cash tables). */
export interface SideGameState {
  /** Hands dealt since the last bomb pot. */
  handsSinceBombPot: number;
  /** The host asked for a bomb pot next hand. */
  bombPotNext: boolean;
  /** Simulated rake taken so far. */
  rakeTotal?: number;
  /** The Nit game round in progress. */
  nit?: NitRound | null;
}

export interface NitRound {
  /** Who started the round; they share the prize. */
  participants: PlayerId[];
  /** Participants who have not won a pot outright yet. */
  holders: PlayerId[];
  /** Chips the last holder pays each other participant. */
  prize: number;
}

/** Everything about one table. Plain JSON, so it can be snapshotted and restored. */
export interface RuntimeState {
  version: typeof RUNTIME_VERSION;
  id: string;
  hostId: PlayerId;
  createdAt: number;
  settings: TableSettings;
  /** Host edits waiting for the next hand. */
  pendingSettings: SettingsPatch | null;
  settingsLog: SettingsLogEntry[];
  seats: (SeatState | null)[];
  requests: SeatRequest[];
  ledger: Record<PlayerId, LedgerRow>;
  /** Players who left, for the rathole rule. */
  departures: Record<PlayerId, { stack: number; at: number }>;
  /** The name of everyone dealt a hand here, so logs and history keep it after they leave. Missing in older snapshots. */
  handNames?: Record<PlayerId, string>;
  /** The host started the game; hands deal automatically while this is true. */
  started: boolean;
  /** Stop after the current hand. */
  stopAfterHand: boolean;
  paused: boolean;
  /** While paused: how long was left on each clock, and when the pause began (missing in older snapshots). */
  pausedLeft: { at?: number; turn: number | null; nextHand: number | null; rit: number | null } | null;
  handNumber: number;
  hand: HandState | null;
  handStartedAt: number | null;
  /** Blind positions of the last hand, for the dead-button rule. */
  positions: { button: number; smallBlind: number | null; bigBlind: number | null } | null;
  turn: TurnClock | null;
  nextHandAt: number | null;
  ritDeadline: number | null;
  /** Cash blind schedule progress. */
  level: { index: number; elapsedMs: number; runningSince: number | null; hands: number };
  /** Mixed-game rotation progress. */
  rotation: { step: number; hands: number; orbits: number; anchor: number | null };
  chat: ChatMessage[];
  log: TableLogEntry[];
  history: HandRecord[];
  /** Added after version 1 snapshots; absent means fresh counters. */
  sideGames?: SideGameState;
  /**
   * While spectators see every hole card: the first hand they see that way (a
   * hand dealt before it was turned on stays hidden, mucked cards included)
   * and when it was turned on, so players can be warned. Missing in older
   * snapshots, which means from the first hand.
   */
  seeAll?: { since: number; at: number } | null;
  /** Who rabbit hunted the last hand (they alone see its undealt cards). */
  rabbit?: { handNumber: number; playerIds: PlayerId[] };
  /** Players queued for a seat, first come first served. Absent in older snapshots. */
  waitlist?: WaitlistEntry[];
  /** Free seats held for waitlisted players. */
  offers?: SeatOffer[];
  /** Players the host has muted in chat. */
  muted?: PlayerId[];
  /** Co-hosts and the powers the host gave each (cash tables). Absent in older snapshots. */
  coHosts?: CoHost[] | null;
  /** Provably fair dealing (docs/FAIRNESS.md). Missing in older snapshots; made on first use. */
  fair?: FairState;
  /** Practice bots at this table (seated or asking for a seat), by their player id. */
  bots?: Record<PlayerId, BotInfo>;
  /**
   * Coach tips and the bots' reasons for the hand being played: set at the deal
   * when one person was dealt in and everyone else is a practice bot, null
   * otherwise. It stays until the next deal, so the post-hand "why" button can
   * show. Missing in older snapshots, and in a snapshot restored mid-hand,
   * which means no tips for that hand.
   */
  coach?: { handNumber: number; person: PlayerId; notes: BotNote[] } | null;
  /**
   * A hand here was dealt to two or more people (not bots), so friends' records
   * depend on the table and the host can't delete it, and coach tips are off
   * for good. Set at the deal by who is in state.bots, and when a hand ends by
   * the bots and the ledger rows flagged as bots (botIdsOf), never the 'bot-'
   * prefix. Missing in older snapshots; the server works it out from saved
   * hands, the same way, when it loads one.
   */
  realGame?: boolean;
}

/** A practice bot: who added it, what it buys in (and rebuys) for, how it looks and how well it plays. */
export interface BotInfo {
  ownerId: PlayerId;
  ownerName: string;
  buyIn: number;
  /** Index into BOT_LOOKS: its name and picture. Missing for bots saved before bots had looks. */
  look?: number;
  /** Missing for bots saved before bots had levels: they play as Normal. */
  level?: BotLevel;
}

/** What a tournament table needs from the tournament runtime. Cash tables have none. */
export interface TournamentHooks {
  /**
   * The director is still delivering a batch of events to its tables. Until it pokes, this table runs
   * nothing on its own (turn clocks, deals), so no hand ends before chips or seats on their way arrive.
   */
  busy(): boolean;
  /** The event has finished or been cancelled (missing in older test doubles: never over). */
  over?(): boolean;
  /** This person is still in the event (at any of its tables, or waiting for a seat). */
  stillPlaying?(playerId: PlayerId): boolean;
  /**
   * This person is the event's host or one of its co-hosts. They are named in the lobby, not at the
   * table, so the table's own host and co-host list can be out of date or empty.
   */
  isStaff?(playerId: PlayerId): boolean;
  gate(now: number): 'deal' | 'hold';
  level(): { gameId: string; betting?: BettingKind; stakes: Stakes };
  handStarted(handNumber: number): void;
  handEnded(result: {
    handNumber: number;
    startStacks: Record<PlayerId, number>;
    endStacks: Record<PlayerId, number>;
    knockedOutBy: Record<PlayerId, PlayerId[]>;
    button: number;
  }): void;
}
