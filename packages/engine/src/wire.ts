/**
 * The table protocol between server and web: the per-viewer view and the
 * socket events. `import type { TableView } from '@rsdp/engine/wire'`.
 */

import type {
  Action,
  Award,
  BettingKind,
  GameFamily,
  HandEvent,
  HandPhase,
  LegalActions,
  PlayerId,
  Stakes,
} from './core/types';
import type { SettingsChange, SettingsPatch, TableSettings } from './settings';
import type { CoHost, HostPower } from './roles';

/** A card as one viewer sees it: '??' when hidden. */
export interface WireCard {
  card: string;
  up: boolean;
}

export interface SeatView {
  seat: number;
  playerId: PlayerId;
  name: string;
  /** Chips behind (during a hand: what is left after this hand's bets). */
  stack: number;
  sittingOut: boolean;
  sitOutReason: 'player' | 'timeouts' | 'busted' | 'host' | null;
  online: boolean;
  /** Dealt into the current hand. */
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  /** Chips in front of the player this betting round. */
  bet: number;
  cards: WireCard[];
  lastAction: string | null;
  /** Seconds left in the time bank. */
  timeBank: number;
  /** Will stand up when the hand ends. */
  leaving: boolean;
  /** Owes blinds (sat out while they went past). */
  owesBlinds: boolean;
  /** Waiting for the big blind or to post before being dealt in. */
  waiting: boolean;
  waitForBigBlind: boolean;
  straddle: boolean;
  /** Opted in to the Nit game. */
  nitOptIn: boolean;
  /** In the current Nit game round: still holding the nit, or off it. */
  nit: 'holder' | 'clear' | null;
  /** Chips this seat won in the finished hand. */
  won: number;
  /** Best hand name at showdown. */
  handName: string | null;
  /** The player's picture: 'lib:<id>' from AVATARS, 'up:<version>' for an upload served at /api/avatars/<playerId>, or null. */
  avatar: string | null;
  /** An emoji the player shows by their seat, or null. */
  mood: string | null;
  /** A practice bot: who added it, its look (an index into BOT_LOOKS) and how well it plays (not kept for replays). Absent for people. */
  bot?: { ownerId: PlayerId; ownerName: string; look: number; level?: BotLevel };
  /**
   * Set only in the browser, never by the server: a player knocked out of a tournament in the hand just shown,
   * kept in their seat with their cards up until the next deal so the table sees them go ('fading' just before it).
   */
  departed?: 'out' | 'fading';
}

export interface HandView {
  handNumber: number;
  /**
   * Provably fair dealing: the commitment this hand was dealt from and the
   * players' seeds mixed in, so each browser can see its own seed was used.
   * Missing on hands dealt before it existed.
   */
  fair?: { commit: string; clientSeeds: { playerId: PlayerId; seed: string }[] };
  gameId: string;
  gameName: string;
  shortName: string;
  family: GameFamily;
  betting: BettingKind;
  stakes: Stakes;
  /** Seat → name of everyone dealt in, including players who have since left the seat. */
  names: Record<number, string>;
  phase: HandPhase;
  street: number;
  streetName: string;
  button: number;
  buttonDead: boolean;
  smallBlind: number | null;
  bigBlind: number | null;
  /** boards[run][board]: community cards. */
  boards: string[][][];
  /** Pots from chips already gathered (excludes this round's bets). */
  pots: { amount: number; eligible: number[] }[];
  /** Everything in the middle including this round's bets. */
  potTotal: number;
  toAct: number | null;
  currentBet: number;
  /** Draw games: most cards that may be swapped this draw. */
  drawMax: number | null;
  runItTwice: { offered: boolean; votes: Record<number, boolean | null>; deadline: number | null; times: 1 | 2 | null };
  showdown: boolean;
  /** Everyone posted and the first betting round was skipped. */
  bombPot: boolean;
  awards: Award[];
  /** Events this viewer may see, for the hand log and animations. */
  events: HandEvent[];
  /**
   * Set only in the browser, never by the server: while an all-in runout waits before its last card, the boards
   * that card goes on, so each shows a face-down card there until it turns over.
   */
  comingNext?: { run: number; board: number }[];
}

export interface RequestView {
  id: string;
  kind: 'seat' | 'rebuy';
  /** A practice bot asking for a seat, who added it (its owner sees the request too) and how well it plays. */
  bot?: { ownerId: PlayerId; ownerName: string; level: BotLevel };
  playerId: PlayerId;
  name: string;
  seat: number | null;
  amount: number;
  at: number;
}

export interface LedgerView {
  playerId: PlayerId;
  name: string;
  buyIn: number;
  cashOut: number;
  /** Current chips if still seated. */
  stack: number;
  net: number;
  /** A practice bot: its chips are play money, so nobody pays it or is paid by it. */
  bot?: true;
}

export interface ChatView {
  at: number;
  playerId: PlayerId | null;
  name: string;
  text: string;
}

export interface TableView {
  id: string;
  name: string;
  mode: 'cash' | 'tournament';
  /** Set on tournament tables. */
  tournamentId: string | null;
  hostId: PlayerId;
  /** I am the host (co-hosts are not). */
  isHost: boolean;
  /** Two or more people (not bots) have played a hand here, so the table can't be deleted by its host. */
  realGame: boolean;
  /** The host powers I hold: all of them for the host, the ones given for a co-host, none otherwise. */
  powers: HostPower[];
  /** Cash tables: the host's co-hosts and their powers. */
  coHosts: CoHost[];
  me: {
    playerId: PlayerId;
    seat: number | null;
    /** Seated with chips to sit back in with (TableRuntime.canSitIn). Absent from servers before it was added. */
    canSitIn?: boolean;
  };
  settings: TableSettings;
  /** Host edits waiting for the next hand. */
  pendingSettings: SettingsPatch | null;
  started: boolean;
  paused: boolean;
  stopAfterHand: boolean;
  /**
   * Hand-history and full-log downloads are closed to me for now, so nobody
   * can feed a HUD while playing: true while the game runs and I'm seated (or
   * never played here). Replays in the app stay open.
   */
  recordsLocked: boolean;
  seats: (SeatView | null)[];
  hand: HandView | null;
  /** What I may do now (null when it is not my turn). */
  legal: LegalActions | null;
  canDraw: { max: number } | null;
  canVoteRunItTwice: boolean;
  /** My card indexes I may still show (after the hand). */
  canShow: number[];
  /**
   * Coach tips (hand:tip) and the bots' reasons are on for me: I'm the only
   * person dealt into this hand, everyone else is a practice bot, at a cash
   * table where no two people have played a hand. Stays on after the hand
   * until the next deal. Absent otherwise.
   */
  tips?: boolean;
  turn: { seat: number; startedAt: number; deadline: number | null; usingBank: boolean } | null;
  nextHandAt: number | null;
  /** Server clock when the view was built, to correct for skew. */
  serverNow: number;
  /**
   * Rabbit hunting after a hand that ended early: `available` when there are
   * undealt board cards to see; `cards` (one list per board) only for a viewer
   * who asked.
   */
  rabbit: { available: boolean; cards: string[][] | null };
  /** The Nit game round in progress. */
  nit: { prize: number; participants: number; holders: number } | null;
  /** Simulated rake collected so far, for whoever the host lets see it. */
  rakeTotal: number | null;
  /** The host made the next hand a bomb pot. */
  bombPotNext: boolean;
  /** Game and stakes of the next hand when no hand is running (cash tables). */
  upcoming: { gameId: string; gameName: string; betting: BettingKind; stakes: Stakes } | null;
  /** Blind schedule: current level and when it ends. */
  level: { index: number; count: number; endsAt: number | null; handsLeft: number | null } | null;
  /** The host sees all requests; everyone else sees their own. */
  requests: RequestView[];
  ledger: LedgerView[];
  chat: ChatView[];
  log: { at: number; text: string }[];
  settingsLog: { at: number; by: string; when: 'now' | 'next-hand'; changes: SettingsChange[] }[];
  /** Finished hands available to replay, newest last. */
  history: { handNumber: number; endedAt: number; gameName: string }[];
  /** People with the table open who are not seated (spectators). */
  watchers: { playerId: PlayerId; name: string }[];
  /** Cash tables with a waitlist: who is queued for a seat, first in line first. */
  waitlist: { playerId: PlayerId; name: string }[];
  /** Free seats held for someone on the waitlist until `expiresAt`. */
  offers: { seat: number; playerId: PlayerId; name: string; expiresAt: number }[];
  /** People the host has muted in chat. */
  muted: PlayerId[];
  /**
   * How a spectator sees the table: `delaySeconds` behind the players (seats,
   * cards and bets as they were then), and with every hole card when
   * `seeAll`. Null for seated players and the host. `blocked` when the host
   * has turned watching off: the hand is hidden until you sit.
   */
  spectator: { delaySeconds: number; seeAll: boolean; blocked: boolean } | null;
  /**
   * Set for everyone while spectators can see every hole card: how far behind
   * they watch, when it was turned on (0 if from the start or not known),
   * and how many people who aren't players or staff are watching now.
   */
  cardsWatched: { delaySeconds: number; at: number; watchers: number } | null;
  /**
   * Provably fair dealing (docs/FAIRNESS.md): the published commitment to the
   * next hand's server seed (seated browsers answer with fair:seed), and the
   * one the hand in progress was dealt from. openThrough: hands up to this
   * number may be checked because the game stayed stopped after them (it
   * moves when that happens, so browsers fetch the hands again).
   */
  fair: { nextCommit: string; handCommit: string | null; openThrough: number };
}

/** A finished hand for the log and replayer, filtered for the viewer. */
export interface HandRecordView {
  handNumber: number;
  startedAt: number;
  endedAt: number;
  gameName: string;
  betting: BettingKind;
  stakes: Stakes;
  button: number;
  /** `bot` marks a practice bot: whose it was and its look (BOT_LOOKS). */
  seats: { seat: number; playerId: PlayerId; name: string; stack: number; bot?: { ownerName: string; look: number } }[];
  events: HandEvent[];
  /** How the deck was made; null or missing for hands dealt (or shared) before provably fair dealing. */
  fair?: FairRecordView | null;
  /** Why each practice bot played as it did: only for the one person in a hand where everyone else was a bot, once it is over. */
  botNotes?: BotNote[];
}

/**
 * A finished hand's fairness record. serverSeed and handSeed are null until the
 * hand is revealed (at revealsAt: half an hour after the host stops the game, or 12 hours after the hand): they give away
 * every card in the deck, folded hands included.
 */
export interface FairRecordView {
  version: string;
  handId: string;
  commit: string;
  clientSeeds: { playerId: PlayerId; name: string; seed: string }[];
  serverSeed: string | null;
  handSeed: string | null;
  revealsAt: number | null;
  /** Once revealed: every event with every card, so the checker can deal the hand again. */
  events: HandEvent[] | null;
}

/** A hand shared as a link: frozen as the sharer saw it (or with their own cards hidden). */
export interface SharedHandView {
  id: string;
  tableName: string;
  centsMode: boolean;
  seatCount: number;
  felt: string | null;
  sharedBy: string;
  /** The sharer's seat, only when they kept their own cards in the link, so the replay shows those cards from their chair. */
  sharerSeat?: number;
  createdAt: number;
  hand: HandRecordView;
}

export type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

/**
 * The turn a move is for, as my view showed it when I pressed: the hand's
 * number and its event count (view.hand.events.length; the server starts a
 * new turn whenever the count changes). A move that arrives after its turn
 * has passed is refused rather than played on a later one: on a slow
 * connection, when I give up waiting and tap again, the first tap is played
 * on its turn and the second, arriving after it, is refused. Both are
 * optional: a page from before they were sent plays as it always did.
 */
export interface TurnKey {
  handNumber?: number;
  at?: number;
}

export interface CreateTableInput {
  /** Any subset of the settings; the rest come from the defaults. */
  settings: SettingsPatch;
  /** A practice table: seat me with this name and deal straight away against this many bots (1-9), at this level (normal if missing). */
  practice?: { name: string; bots: number; level?: BotLevel };
}

export interface ClientToServer {
  /** The name other players see; also used to register for tournaments. */
  'session:name': (input: { name: string }, ack: Ack) => void;
  'table:create': (input: CreateTableInput, ack: Ack<{ tableId: string }>) => void;
  'table:join': (input: { tableId: string }, ack: Ack) => void;
  'table:leave': () => void;
  'table:history': (input: { handNumber: number }, ack: Ack<{ hand: HandRecordView }>) => void;
  /** Every finished hand at the table as you may see it, oldest first, for downloads and the replayer. */
  'table:export': (ack: Ack<{ hands: HandRecordView[] }>) => void;
  /** The whole table log and chat (the view carries only the latest lines) and every finished hand, for the full log download. */
  'table:fullLog': (ack: Ack<{ log: { at: number; text: string }[]; chat: ChatView[]; hands: HandRecordView[] }>) => void;
  /** Freeze a finished hand as I saw it behind a link anyone can open; hideMine leaves out my cards unless I showed them. */
  'hand:share': (input: { handNumber: number; hideMine?: boolean }, ack: Ack<{ id: string }>) => void;
  /** Stop a link I made from working. */
  'hand:unshare': (input: { id: string }, ack: Ack) => void;
  /** `consent`: the player agreed to spectators seeing their cards (required while they do). */
  'seat:request': (input: { seat: number; name: string; stack: number; consent?: boolean }, ack: Ack) => void;
  'seat:cancel': () => void;
  'seat:stand': (input: { afterHand?: boolean }) => void;
  'seat:sitOut': (input: { value: boolean }, ack: Ack) => void;
  'seat:prefs': (input: { waitForBigBlind?: boolean; straddle?: boolean; nitGame?: boolean; mood?: string | null }, ack: Ack) => void;
  'seat:rebuy': (input: { amount: number }, ack: Ack) => void;
  /** Queue for a seat at a full table, with the stack to sit with. */
  'waitlist:join': (input: { name: string; stack: number }, ack: Ack) => void;
  /** Leave the waitlist (also turns down a seat being held for you). */
  'waitlist:leave': (ack: Ack) => void;
  'hand:act': (action: Action & TurnKey, ack: Ack) => void;
  'hand:draw': (input: { discard: number[] } & TurnKey, ack: Ack) => void;
  /** `handNumber`: the hand whose vote I pressed it in, so a vote that arrives during a later hand's vote is ignored, not counted there. */
  'hand:runItTwice': (input: { yes: boolean; handNumber?: number }, ack: Ack) => void;
  /** `handNumber`: the hand I pressed it after, so a show that arrives once the next hand is dealt is refused, not played on that hand. */
  'hand:show': (input: { cards: number[]; handNumber?: number }, ack: Ack) => void;
  /** Add my time bank to my clock now, on the turn I pressed it on (a page from before turn keys sends the ack alone). */
  'hand:timeBank': (...args: [ack: Ack] | [input: TurnKey, ack: Ack]) => void;
  /** See the cards that would have come (only I see them). */
  'hand:rabbit': (ack: Ack) => void;
  /**
   * A coach tip for my decision now, when the view says tips: answered to me
   * alone, and never kept. `at` is the number of events in the hand when I
   * asked (view.hand.events.length), so an answer to an old turn is refused.
   */
  'hand:tip': (input: { handNumber: number; at: number }, ack: Ack<{ tip: CoachTip }>) => void;
  /** Add my browser's randomness to the next hand, answering the commitment I was shown (seated players). */
  'fair:seed': (input: { commit: string; seed: string }, ack: Ack) => void;
  'chat:send': (input: { text: string }, ack?: Ack) => void;
  /** Private feedback about the site from the table I'm at, for the admin only. `screen` is 'phone' or 'desktop'. */
  'feedback:send': (input: { kind: 'problem' | 'idea' | 'other'; text: string; screen?: string }, ack: Ack) => void;
  /** Throw a gesture at a player at my table. */
  'table:gesture': (input: { to: PlayerId; kind: GestureKind }, ack: Ack) => void;
  /** My picture everywhere: one from the library, an uploaded image (a small data: URL), or none. */
  'avatar:set': (input: { library?: string; image?: string } | null, ack: Ack<{ avatar: string | null }>) => void;
  /** My private notes on other players. */
  'notes:list': (ack: Ack<{ notes: PlayerNote[] }>) => void;
  /** Saves (or, with no text and no colour, deletes) my note on a player. */
  'notes:set': (input: PlayerNote, ack: Ack<{ note: PlayerNote | null }>) => void;
  /** My saved setups of one kind (signed in only; guests keep theirs in the browser). */
  'setups:list': (input: { kind: SetupKind }, ack: Ack<{ setups: SavedSetup[] }>) => void;
  /** Saves a setup under its name, replacing one of the same name. Answers with the name as kept. */
  'setups:save': (input: { kind: SetupKind; name: string; json: string }, ack: Ack<{ name: string }>) => void;
  'setups:rename': (input: { kind: SetupKind; from: string; to: string }, ack: Ack<{ name: string }>) => void;
  'setups:delete': (input: { kind: SetupKind; name: string }, ack: Ack) => void;
  /**
   * Brings setups saved in this browser onto the account; a name already taken there gets a number. Bad ones,
   * and any past the limit, are left out. `kept` names (as sent) the ones the account now holds.
   */
  'setups:import': (input: { kind: SetupKind; setups: SavedSetup[] }, ack: Ack<{ added: number; kept: string[] }>) => void;
  /** Approve a request; `seat` puts a seat request's player in another open seat. */
  'host:approve': (input: { requestId: string; seat?: number }, ack: Ack) => void;
  'host:reject': (input: { requestId: string }) => void;
  'host:start': (ack: Ack) => void;
  'host:stop': (ack: Ack) => void;
  /** Host only: delete a cash table nobody has played a real game at, for good (a test or a mistake). */
  'host:deleteTable': (ack: Ack) => void;
  'host:deal': (ack: Ack) => void;
  'host:pause': (input: { value: boolean }, ack: Ack) => void;
  /** Make the next hand a bomb pot (value false takes it back). */
  'host:bombPot': (input: { value: boolean }, ack: Ack) => void;
  'host:settings': (input: { patch: SettingsPatch }, ack: Ack) => void;
  'host:setStack': (input: { playerId: string; stack: number }, ack: Ack) => void;
  'host:kick': (input: { playerId: string }, ack: Ack) => void;
  'host:sitOut': (input: { playerId: string }, ack: Ack) => void;
  'host:transfer': (input: { playerId: string }, ack: Ack) => void;
  /** Between hands: reseat everyone at random and draw the button again. */
  'host:shuffle': (ack: Ack) => void;
  /** Move a player who is not in the hand to an empty seat. */
  'host:move': (input: { playerId: string; seat: number }, ack: Ack) => void;
  /** Host only: make someone a co-host, or change a co-host's powers. */
  'host:coHost': (input: { playerId: string; powers: HostPower[] }, ack: Ack) => void;
  /** Host: remove a co-host. A co-host may remove themselves (step down). */
  'host:removeCoHost': (input: { playerId: string }, ack: Ack) => void;
  /** Mute (or unmute) someone's chat for everyone. */
  'host:mute': (input: { playerId: string; value: boolean }, ack: Ack) => void;
  /** Add a practice bot of mine (it gets its own short name and robot), in this seat or the first free one, at this level (normal if missing). */
  'bot:add': (input: { seat?: number; level?: BotLevel }, ack: Ack<{ playerId: string }>) => void;
  /** Change how well a bot of mine plays (the host can change any); it takes effect on its next move. */
  'bot:level': (input: { playerId: string; level: BotLevel }, ack: Ack) => void;
  /** Take away a bot I added (the host can take away any). */
  'bot:remove': (input: { playerId: string }, ack: Ack) => void;
}

export interface ServerToClient {
  session: (session: { playerId: string; displayName: string; account: { username: string } | null; avatar?: string | null }) => void;
  /** The web app this server hands out (its entry script), sent on connecting, so a tab still running an older one can reload. */
  build: (id: string) => void;
  'table:state': (view: TableView) => void;
  /** A tournament moved you to another table (balancing or a broken table). */
  'table:moved': (input: { from: string; to: string }) => void;
  /** The table I had open was deleted for good. */
  'table:deleted': (input: { id: string }) => void;
  /** Someone at the table threw a gesture. */
  'table:gesture': (input: { from: PlayerId; to: PlayerId; kind: GestureKind; at: number }) => void;
  /** All my notes again, after one changed in any of my tabs. */
  notes: (notes: PlayerNote[]) => void;
  /** All my saved setups of one kind again, after one changed in any of my tabs. */
  setups: (input: { kind: SetupKind; setups: SavedSetup[] }) => void;
}

/**
 * The rule behind a coach tip. `raise-field` raises because the hand is far
 * ahead of an even share against several opponents rather than on its own
 * chance; `call-capped` calls a hand it would raise before three raises;
 * `fold-big` folds a hand that would call a smaller bet (the call is half my
 * chips or more).
 */
export const COACH_RULES = ['bring-in', 'complete', 'check', 'bet', 'raise', 'raise-field', 'call', 'call-capped', 'fold', 'fold-big', 'draw', 'pat'] as const;
export type CoachRule = (typeof COACH_RULES)[number];

/** What a coach tip suggests. Bet sizes are totals for this round, like Action; `fraction` is of the pot (the ½ and ¾ pot presets), null in fixed limit. */
export type CoachMove =
  | { type: 'fold' | 'check' | 'call' | 'bring-in' }
  | { type: 'bet' | 'raise' | 'complete'; to: number; fraction: 0.5 | 0.75 | null; allIn: boolean }
  /** Indexes into my own cards. */
  | { type: 'draw'; discard: number[] };

/**
 * A coach tip: numbers only, worked out on the server from what I can see
 * (my cards, up cards, the boards, the betting and how many cards each player
 * drew). The browser writes every sentence. Shares are 0-1.
 */
export interface CoachTip {
  /** The decision it answers (hand:tip's input). */
  handNumber: number;
  at: number;
  kind: 'bet' | 'draw';
  /** My chance of winning: my share of the pot, ties and halves included... */
  share: number;
  /** ...and its standard error, for how roughly to say it. */
  se: number;
  /** The pot is split (hi-lo, or two boards): say "of the pot". */
  split: boolean;
  /** Hi-lo: how often I win the whole pot. Null otherwise. */
  scoop: number | null;
  /** Opponents dealt out in each finish (a crowded deck can't deal everyone)... */
  vs: number;
  /** ...and live opponents. */
  opponents: number;
  /** My share against random hands, when this hand's betting was counted and changed it. Null otherwise. */
  vsRandom: number | null;
  /** Draws still to come (draw games). */
  drawsLeft: number;
  /** Chips to call (0 when I can check)... */
  call: number;
  /** ...the chips in the middle I can win, before my call... */
  pot: number;
  /** ...the call as a share of the pot once called (null with nothing to call)... */
  cost: number | null;
  /** ...and the share the tip wants before calling. */
  need: number | null;
  /** The call is half my chips or more, so the tip wants a margin. */
  big: boolean;
  /** My share is within the noise of what calling needs: call or fold are both fine. */
  close: boolean;
  move: CoachMove;
  rule: CoachRule;
  /** Draws: the best few ways to draw, best first (discard indexes into my cards). */
  options: { discard: number[]; share: number }[];
  /** Live opponents whose betting this hand the tip counted, and how much (a bet or raise counts 1, a call after the first round about a third). */
  reads: { seat: number; bets: number }[];
  /** Lowball draw games: how many cards each live opponent threw at each draw (null when the table stood pat for them). */
  draws: { seat: number; done: (number | null)[] }[];
}

/** The rule behind a practice bot's move. `rit-yes`: bots always agree to run it twice; `fallback`: it couldn't decide, so the table checked or folded for it. */
export const BOT_NOTE_RULES = ['bring-in', 'complete', 'steal', 'check', 'value', 'bluff', 'semi-bluff', 'raise', 'call', 'call-loose', 'fold', 'draw', 'pat', 'rit-yes', 'fallback'] as const;
export type BotNoteRule = (typeof BOT_NOTE_RULES)[number];

/**
 * Why a practice bot made one move, in its own rough numbers. Numbers and
 * fixed words only: never a card, a discard position or anything about
 * another person.
 */
export interface BotNote {
  /** The event it explains (its action, draw or run-it-twice vote) and the bot's seat. */
  seq: number;
  seat: number;
  level: BotLevel;
  rule: BotNoteRule;
  /** Its chance of winning, to the nearest 0.05. */
  share?: number;
  /** The pot is split (hi-lo, or two boards). */
  split?: true;
  /** Opponents it was against. */
  vs?: number;
  drawsLeft?: number;
  /** Facing a bet: the call as a share of the pot once called, and the share it wanted (to 0.01). */
  cost?: number;
  need?: number;
  /** The call was half its chips or more. */
  big?: true;
  /** After three raises it raises again only with a very strong hand. */
  capped?: true;
  /** The chance of the coin flip that picked the play, to 0.01. */
  often?: number;
  /** Draws: how many cards it threw, and the next best way it weighed. */
  thrown?: number;
  alt?: { thrown: number; share: number };
  /** Hard: acts last for the rest of the hand. */
  last?: true;
  /** Stud: it brought in only because the player who had to was all in from the ante, so it could have folded. */
  opened?: true;
  /** Hard: what it made of how you (the one person in the hand) play, and how often you bet or raised this hand. */
  you?: 'folds-often' | 'calls-often';
  yourBets?: number;
}

/** What a saved setup is for: a cash table preset or a tournament structure. */
export const SETUP_KINDS = ['table', 'tournament'] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];
/** Most setups of one kind an account keeps. */
export const SETUPS_PER_KIND = 100;
/**
 * Longest name for a saved setup. Counted like an input's maxLength, an emoji
 * as two, the same as a table preset's name, so a name that fits here fits there.
 */
export const SETUP_NAME_MAX = 60;

/** A setup saved under a name: for a table, a preset file; for a tournament, its settings as JSON. */
export interface SavedSetup {
  name: string;
  json: string;
}

/** Gestures a player can throw at another. The pictures and sounds are drawn by the web client. */
export const GESTURES = ['heart', 'clap', 'cheers', 'fire', 'laugh', 'cry', 'money', 'fish', 'shark', 'clown', 'tomato', 'rose'] as const;
export type GestureKind = (typeof GESTURES)[number];

/**
 * How well a practice bot plays. Easy calls a lot, bets only good hands and
 * keeps its bets small. Normal plays the odds. Hard also reads what bets
 * mean, learns how each player plays, uses position and bluffs.
 */
export const BOT_LEVELS = ['easy', 'normal', 'hard'] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

/**
 * Practice bots' names and pictures. Each bot at a table takes the first one no
 * other bot there has, so bots are easy to tell apart at a glance. The order
 * puts the most different colours first. Names stay at five letters or fewer
 * so they fit a phone nameplate. The web client draws the robot from `color`
 * and `face` (0-3).
 */
export const BOT_LOOKS: readonly { name: string; color: string; face: number }[] = [
  { name: 'Ace', color: '#e5484d', face: 0 },
  { name: 'Chip', color: '#2f8ee8', face: 1 },
  { name: 'Lucky', color: '#2f9e5b', face: 2 },
  { name: 'Ducky', color: '#f2b705', face: 3 },
  { name: 'Slick', color: '#9b4dca', face: 1 },
  { name: 'Rocky', color: '#f76b15', face: 2 },
  { name: 'Deuce', color: '#0f9f95', face: 0 },
  { name: 'Hooks', color: '#e0457b', face: 3 },
  { name: 'Quads', color: '#9a6a3c', face: 2 },
  { name: 'Shark', color: '#5b5bd6', face: 0 },
  { name: 'Spike', color: '#7cab1f', face: 1 },
  { name: 'Trips', color: '#7d8a99', face: 3 },
];

/** The built-in avatar library: id → emoji and background colour. All our own picks, free for everyone. */
export const AVATARS: Record<string, { emoji: string; bg: string }> = {
  fox: { emoji: '🦊', bg: '#f2994a' },
  owl: { emoji: '🦉', bg: '#8d6e63' },
  cat: { emoji: '🐱', bg: '#f6c344' },
  bear: { emoji: '🐻', bg: '#a1887f' },
  frog: { emoji: '🐸', bg: '#66bb6a' },
  octopus: { emoji: '🐙', bg: '#ec6fa8' },
  tiger: { emoji: '🐯', bg: '#ffa726' },
  panda: { emoji: '🐼', bg: '#cfd8dc' },
  unicorn: { emoji: '🦄', bg: '#b39ddb' },
  robot: { emoji: '🤖', bg: '#90a4ae' },
  alien: { emoji: '👽', bg: '#7cb342' },
  ghost: { emoji: '👻', bg: '#9fa8da' },
  cowboy: { emoji: '🤠', bg: '#d4a373' },
  shark: { emoji: '🦈', bg: '#4fc3f7' },
  dragon: { emoji: '🐲', bg: '#43a047' },
  penguin: { emoji: '🐧', bg: '#4dd0e1' },
  koala: { emoji: '🐨', bg: '#b0bec5' },
  lion: { emoji: '🦁', bg: '#fbc02d' },
  monkey: { emoji: '🐵', bg: '#bcaaa4' },
  wolf: { emoji: '🐺', bg: '#78909c' },
  crown: { emoji: '👑', bg: '#7e57c2' },
  rocket: { emoji: '🚀', bg: '#5c6bc0' },
  cactus: { emoji: '🌵', bg: '#9ccc65' },
  pizza: { emoji: '🍕', bg: '#ef5350' },
  sunglasses: { emoji: '😎', bg: '#26a69a' },
  wizard: { emoji: '🧙', bg: '#5e35b1' },
  ninja: { emoji: '🥷', bg: '#455a64' },
  diamond: { emoji: '💎', bg: '#29b6f6' },
};
/** Largest uploaded avatar accepted, as a data: URL (the web client shrinks pictures well under this). */
export const AVATAR_MAX_CHARS = 60_000;

export const NOTE_COLORS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
export const NOTE_MAX = 500;

/** A private note one player keeps on another. Only its owner ever receives it. */
export interface PlayerNote {
  targetPlayerId: string;
  text: string;
  color: NoteColor;
}

export interface HandshakeAuth {
  /** Random secret kept in the browser (localStorage rsdp.guestId). Never shown to other players. */
  token: string;
}
