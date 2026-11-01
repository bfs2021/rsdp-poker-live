import { randomUUID } from 'node:crypto';
import { commitmentOf, cryptoRng, deckFromSeed, FAIR_VERSION, handSeedOf, SEED_RE, shuffle, type Rng } from '@rsdp/engine';
import {
  ActionError,
  blindsPassed,
  engine,
  modifierRegistry,
  planForcedBets,
  runoutMs,
  variants,
  type Action,
  type BettingKind,
  type GameSpec,
  type HandFairness,
  type HandInput,
  type HandState,
  type PlannerSeat,
  type PlayerId,
  type Stakes,
} from '@rsdp/engine/core';
import {
  amountText,
  applyAtNextHand,
  applyImmediate,
  enabledModifiers,
  MAX_CHIPS,
  mergePatches,
  parseSettings,
  SettingsError,
  settingsNotices,
  spectatorsSeeCards,
  type SettingsPatch,
  type TableSettings,
} from '@rsdp/engine/settings';
import { bombPotDue, bombPotSchema, bounty72Schema, nitClears, nitSchema, sevenDeuceWinners } from '@rsdp/engine/modifiers';
import { gameTitle } from '@rsdp/engine/variants';
import { BOT_LEVELS, BOT_LOOKS, type BotLevel, type BotNote, type CoachTip, type TurnKey } from '@rsdp/engine/wire';
import {
  RUNTIME_VERSION,
  systemClock,
  type BotInfo,
  type ChatMessage,
  type Clock,
  type FairState,
  type HandRecord,
  type PastHand,
  type RuntimeState,
  type SeatRequest,
  type SideGameState,
  type SeatState,
  type TableLine,
  type TournamentHooks,
  type WaitlistEntry,
} from './types';
import { cleanName as cleanDisplayName } from '../names';
import { handOver, hasPower, isStaff, powersOf, RoleError, withCoHost, withoutCoHost, type HostPower } from '@rsdp/engine/roles';
import { maskProfanity } from './profanity';
import { explainMove, readPlayers, seededRand, seenBy, type MoveWhy } from '../bots/strategy';
import { coachTip as buildCoachTip } from '../bots/coach';
import { botNote, plainNote } from '../bots/reasons';

/** Chat and log lines the state keeps, for the side panel; every one is also handed to onLine to be kept for good. */
const CHAT_LIMIT = 200;
const LOG_LIMIT = 300;
const HISTORY_LIMIT = 30;

/**
 * True when two or more people (not practice bots) were dealt in. Who is a bot comes from the table (its bots, or
 * botIdsOf a saved one), never the 'bot-' prefix: a person's id can start with it too.
 */
export const realGameHand = (seats: readonly { playerId: PlayerId }[], isBot: (playerId: PlayerId) => boolean) =>
  seats.filter((x) => !isBot(x.playerId)).length >= 2;
/** Hands become checkable this long after they end, if the host hasn't stopped the game sooner (docs/FAIRNESS.md). */
export const FAIR_REVEAL_AFTER_MS = 12 * 60 * 60 * 1000;
/**
 * Stopping the game opens every hand so far once it has stayed stopped this long (John's call, 2026-11-01): a host
 * who stops and starts again sooner is still in the same game, so folded hands stay private.
 */
export const FAIR_STOP_REVEAL_MS = 30 * 60 * 1000;

/** When hand `handNumber` becomes checkable under `fair`: once the game stopped after it for long enough, or 12 hours after it ended. */
export function fairRevealsAt(fair: Pick<FairState, 'revealedThrough' | 'stopped'> | undefined, handNumber: number, endedAt: number, stopRevealMs = FAIR_STOP_REVEAL_MS): number {
  if (handNumber <= (fair?.revealedThrough ?? 0)) return -Infinity;
  const late = endedAt + FAIR_REVEAL_AFTER_MS;
  const stop = fair?.stopped;
  return stop && handNumber <= stop.through ? Math.min(late, stop.at + stopRevealMs) : late;
}
/** Production fairLeadMs: browsers send their seeds the moment a commitment appears, so this is ample. */
export const FAIR_LEAD_MS = 2500;
/**
 * A deal also waits, up to this long after the commitment, for the seed of every seated player whose browser is
 * connected: a slow or stalled connection then gets its seed in rather than missing the hand and warning about it.
 */
export const FAIR_SEED_WAIT_MS = 10_000;
const RIT_VOTE_SECONDS = 12;
/** A clock paused with less than this left gets this much on resume, so nobody times out the moment play goes on. */
export const RESUME_MIN_MS = 5_000;
const NAME_MAX = 20;
/** How long a cash table waits for an offline host before handing the table to a seated player. */
export const HOST_HANDOFF_MS = 3 * 60_000;
/** How long a free seat is held for the next person on the waitlist. */
export const SEAT_OFFER_MS = 60_000;
/** A practice bot takes this long, plus up to BOT_THINK_SPREAD_MS, to act. */
export const BOT_THINK_MS = 700;
/** A coach tip slower than this is worth knowing about: it is worked out on the event loop, so it holds up every table. */
const TIP_SLOW_MS = 150;
const BOT_THINK_SPREAD_MS = 1100;

/** A whole number from a turn key, the same on every server: how long a bot thinks, and the deals behind a coach tip. */
export function hashKey(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
/** Bots a player who is not the host may have at one table. */
export const BOTS_PER_PLAYER = 3;

export interface RuntimeDeps {
  clock?: Clock;
  rng?: Rng;
  tournament?: TournamentHooks;
  /** Failures nobody is there to be told about (timers, a level that can't be dealt). Default console.error. */
  log?: (message: string, err?: unknown) => void;
  /**
   * Fair dealing: the least time between publishing a hand's commitment and
   * dealing from it, so every browser's seed can arrive (FAIR_LEAD_MS in
   * production; tests that deal at once leave it 0).
   */
  fairLeadMs?: number;
  /** How long a stopped game waits before its hands open (FAIR_STOP_REVEAL_MS unless a test says otherwise). */
  fairStopRevealMs?: number;
}

/** The game, betting and stakes the next hand is dealt with. */
interface HandSetup {
  game: GameSpec;
  betting: BettingKind;
  stakes: Stakes;
}

/**
 * One table: seats, the between-hands pipeline, clocks, host controls and
 * the hand in progress. All state lives in `state` (plain JSON); timers are
 * derived from the deadlines stored there, so a restored table carries on.
 */
export class TableRuntime {
  state: RuntimeState;
  /** Called after every change; the server pushes fresh views and saves a snapshot. */
  onChange: () => void = () => {};
  /** Called with each finished hand, for hand history storage. */
  onHandFinished: (record: HandRecord) => void = () => {};
  /** Called with each new log or chat line, to keep them all: the state keeps only the latest few. */
  onLine: (line: TableLine) => void = () => {};

  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly fairLeadMs: number;
  private readonly fairStopRevealMs: number;
  readonly tournament: TournamentHooks | null;
  private readonly logError: (message: string, err?: unknown) => void;
  private readonly connections = new Map<PlayerId, number>();
  /** Names people go by before they sit (their session name), for chat. Set by the server. */
  readonly guestNames = new Map<PlayerId, string>();
  private readonly offlineSince = new Map<PlayerId, number>();
  /** When this runtime came up: players it has never seen get their grace from here. */
  private readonly upSince: number;
  private timers: Record<TimerKey, unknown> = { turn: null, next: null, rit: null, upkeep: null, bot: null, reveal: null };
  /** Hands the table to someone else when the host has been gone a while. */
  private hostTimer: unknown = null;
  /** The next deal was put back to wait for a connected player's seed (fairReadyAt); it may come forward when it arrives. */
  private seedWait = false;
  /** The coach tip for one turn, so asking again (or from another tab) costs nothing. Never saved. */
  private tipCache: { key: string; playerId: PlayerId; tip: CoachTip } | null = null;
  /** A slow tip is reported once, not on every turn. */
  private tipSlowLogged = false;
  /** Why the last tournament deal failed: the table retries on every poke, so each reason is logged once. */
  private dealFailure: string | null = null;

  constructor(state: RuntimeState, deps: RuntimeDeps = {}) {
    this.state = state;
    this.clock = deps.clock ?? systemClock;
    this.rng = deps.rng ?? cryptoRng;
    this.fairLeadMs = deps.fairLeadMs ?? 0;
    this.fairStopRevealMs = deps.fairStopRevealMs ?? FAIR_STOP_REVEAL_MS;
    this.tournament = deps.tournament ?? null;
    this.logError = deps.log ?? ((m, e) => console.error(m, e ?? ''));
    this.upSince = this.clock.now();
    // Older snapshots could queue spectators seeing every card for the next hand. It now applies at once and only
    // between hands, so a queued "on" is dropped (the host turns it on again, announced) and a queued "off" applies now.
    const queued = state.pendingSettings?.spectators;
    if (queued && 'seeAllCards' in queued) {
      if (queued.seeAllCards === false) state.settings = { ...state.settings, spectators: { ...state.settings.spectators, seeAllCards: false } };
      delete queued.seeAllCards;
      if (!Object.keys(queued).length) delete state.pendingSettings!.spectators;
      if (!Object.keys(state.pendingSettings!).length) state.pendingSettings = null;
    }
  }

  static create(args: { id?: string; hostId: PlayerId; hostName?: string; settings: TableSettings }, deps: RuntimeDeps = {}) {
    const clock = deps.clock ?? systemClock;
    const settings = parseSettings(args.settings);
    const state: RuntimeState = {
      version: RUNTIME_VERSION,
      id: args.id ?? randomUUID().slice(0, 10),
      hostId: args.hostId,
      createdAt: clock.now(),
      settings,
      pendingSettings: null,
      settingsLog: [],
      seats: Array.from({ length: settings.table.maxSeats }, () => null),
      requests: [],
      ledger: {},
      departures: {},
      started: false,
      stopAfterHand: false,
      paused: false,
      pausedLeft: null,
      handNumber: 0,
      hand: null,
      handStartedAt: null,
      positions: null,
      turn: null,
      nextHandAt: null,
      ritDeadline: null,
      level: { index: 0, elapsedMs: 0, runningSince: null, hands: 0 },
      rotation: { step: 0, hands: 0, orbits: 0, anchor: null },
      chat: [],
      log: [],
      history: [],
      realGame: false,
      // On from the start: everyone who sits agrees first, so there's nobody to warn (at 0).
      seeAll: spectatorsSeeCards(settings) ? { since: 0, at: 0 } : null,
    };
    return new TableRuntime(state, deps);
  }

  /** Re-arms clocks after construction from a snapshot. */
  resume() {
    // A crash can lose the save made after the last deal; a fresh seed keeps a restart from dealing that deck again.
    if (this.state.fair) {
      this.state.fair.next = this.newServerSeed();
      this.state.fair.clientSeeds = {};
    }
    this.restartClocks();
    this.giveBotsLooks();
    this.watchHost();
    this.sync();
  }

  /**
   * Nobody could act while the server was down (a deploy or a crash), and the clocks saved with the table kept
   * running in the meantime: the player to act gets a fresh decision clock, and an open run-it-twice vote a fresh
   * vote clock, instead of being timed out the moment the table comes back. A paused game keeps its time left.
   * resume() does this; a tournament also does it as each table is loaded, since its catch-up runs before resume().
   */
  restartClocks() {
    const s = this.state;
    const hand = s.hand;
    if (s.paused || !hand || hand.phase === 'complete') return;
    if (s.turn) s.turn = this.newTurn(s.turn.key, s.turn.seat);
    if (hand.phase === 'rit-vote' && s.ritDeadline !== null) s.ritDeadline = this.clock.now() + RIT_VOTE_SECONDS * 1000;
  }

  dispose() {
    for (const key of TIMER_KEYS) this.clearTimer(key);
    this.clock.clearTimeout(this.hostTimer);
    this.hostTimer = null;
  }

  get settings() {
    return this.state.settings;
  }

  get isTournament() {
    return this.state.settings.table.mode === 'tournament';
  }

  isHost(playerId: PlayerId) {
    return playerId === this.state.hostId;
  }

  /** The host, or a co-host the host gave this power. */
  can(playerId: PlayerId, power: HostPower) {
    return hasPower(this.staff(), playerId, power);
  }

  /** The host or any co-host. */
  isStaff(playerId: PlayerId) {
    return isStaff(this.staff(), playerId);
  }

  powersOf(playerId: PlayerId): HostPower[] {
    return powersOf(this.staff(), playerId);
  }

  private staff() {
    return { hostId: this.state.hostId, coHosts: this.state.coHosts };
  }

  seatOf(playerId: PlayerId): SeatState | null {
    return this.state.seats.find((s) => s?.playerId === playerId) ?? null;
  }

  /**
   * Hand-history downloads are closed to this person for now (no live HUDs):
   * while the game runs, for anyone seated, and for anyone who hasn't played
   * here, and in a tournament for anyone still in the event. This hides the
   * buttons and refuses the full log; the hands themselves still reach the
   * browser for replays and the Stats tab (see docs/FAIRNESS.md).
   * They open once you leave your seat or the game stops; the host and
   * co-hosts off their seat keep them, and a practice table nobody but bots has
   * played against you at never closes them. Replaying hands in the app is never closed.
   */
  recordsLocked(playerId: PlayerId): boolean {
    const s = this.state;
    const running = this.tournament ? !this.tournament.over?.() : s.started || this.handLive();
    if (!running) return false;
    // Practice against bots only (no hand here has had two people in it): a HUD on bots costs nobody anything.
    if (!this.tournament && !s.realGame) return false;
    // A tournament player moved to another table is still playing against this one's players.
    if (this.seatOf(playerId) || this.tournament?.stillPlaying?.(playerId)) return true;
    // A tournament's co-hosts are named in the lobby, so the event is asked as well as the table.
    if (this.isStaff(playerId) || this.tournament?.isStaff?.(playerId)) return false;
    return !(s.handNames && Object.hasOwn(s.handNames, playerId)) && !Object.hasOwn(s.ledger, playerId);
  }

  /** Bots are always there. */
  isOnline(playerId: PlayerId) {
    return this.isBot(playerId) || (this.connections.get(playerId) ?? 0) > 0;
  }

  isBot(playerId: PlayerId) {
    return !!this.state.bots && Object.hasOwn(this.state.bots, playerId);
  }

  botInfo(playerId: PlayerId): BotInfo | null {
    return this.isBot(playerId) ? this.state.bots![playerId] : null;
  }

  /**
   * The one person dealt into this hand against nothing but practice bots, for
   * coach tips and the bots' reasons, or null. It is decided from hand.seats,
   * the list dealt in at the start, which never changes during the hand, and
   * it fails closed: a bot the table has forgotten counts as a person, so does
   * anyone dealt in while away, and a table where two people have been dealt
   * into a hand (realGame) never gets tips again, so nobody gets help at a
   * table where people play each other. It does not keep chips won from bots
   * with help out of the ledger: those count when people settle up, as all
   * chips won from bots do. Membership of state.bots decides, never the 'bot-'
   * prefix: a person's id could start with it.
   */
  private soloPersonOf(hand: HandState): PlayerId | null {
    if (this.isTournament || this.state.realGame || hand.seats.length < 2) return null;
    const people = hand.seats.filter((x) => !this.isBot(x.playerId));
    return people.length === 1 ? people[0].playerId : null;
  }

  // ---------------------------------------------------------------- connections

  connect(playerId: PlayerId) {
    this.connections.set(playerId, (this.connections.get(playerId) ?? 0) + 1);
    this.offlineSince.delete(playerId);
    // Back before the hand ended: the seat release that was waiting for it is off.
    const seat = this.seatOf(playerId);
    if (seat?.released) {
      seat.leaveAfterHand = false;
      seat.released = false;
    }
    // The host back stops the handoff; anyone else arriving may be the one to take over.
    if (this.isHost(playerId) || this.hostTimer !== null) this.watchHost();
    this.sync();
  }

  disconnect(playerId: PlayerId) {
    const n = (this.connections.get(playerId) ?? 1) - 1;
    if (n > 0) {
      this.connections.set(playerId, n);
      return;
    }
    this.connections.delete(playerId);
    this.offlineSince.set(playerId, this.clock.now());
    if (this.isHost(playerId)) this.watchHost();
    this.sync();
  }

  // ---------------------------------------------------------------- seating

  requestSeat(playerId: PlayerId, input: { seat: number; name: string; stack: number; consent?: boolean }) {
    if (this.isTournament) throw new ActionError('the tournament seats players');
    // Nobody sits at a table where spectators see their cards without being told and agreeing.
    if (spectatorsSeeCards(this.settings) && !input.consent) throw new ActionError('spectators at this table see every hole card: agree to that to sit down');
    const name = cleanName(input.name);
    let { seat } = input;
    const { stack } = input;
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.state.seats.length) throw new ActionError('no such seat');
    if (this.seatOf(playerId)) throw new ActionError('you already have a seat');
    const offered = this.offers().find((o) => o.playerId === playerId);
    if (offered) seat = offered.seat;
    else if (this.settings.seating.randomSeats && !this.can(playerId, 'players')) {
      const open = this.openSeats(playerId);
      if (!open.length) throw new ActionError('every seat is taken');
      seat = open[this.rng(open.length)];
    }
    this.checkSeatKept(seat);
    if (this.state.seats[seat]) throw new ActionError('that seat is taken');
    this.checkSeatFree(playerId, seat);
    this.checkBuyIn(playerId, stack);
    // A new request replaces your earlier one (which never holds a seat against you).
    this.state.requests = this.state.requests.filter((r) => !(r.playerId === playerId && r.kind === 'seat'));
    // Sitting (or asking to) takes you off the waitlist; an offered seat is yours now.
    this.leaveQueue(playerId);
    const request: SeatRequest = { id: randomUUID().slice(0, 8), kind: 'seat', playerId, name, seat, amount: stack, at: this.clock.now(), consent: !!input.consent };
    if (!this.settings.seating.requireApproval || this.can(playerId, 'approve')) {
      this.seatPlayer(request);
    } else {
      this.state.requests.push(request);
      this.log(`${name} asked for seat ${seat + 1} with ${this.money(stack)}`);
    }
    this.sync();
  }

  cancelRequest(playerId: PlayerId) {
    this.state.requests = this.state.requests.filter((r) => r.playerId !== playerId);
    this.sync();
  }

  /** Approves a request; for a seat request the host may put the player in another open seat. */
  approve(by: PlayerId, requestId: string, seat?: number) {
    this.requirePower(by, 'approve');
    const r = this.state.requests.find((x) => x.id === requestId);
    if (!r) throw new ActionError('request not found');
    if (r.kind === 'seat') {
      if (this.seatOf(r.playerId)) throw new ActionError('already seated');
      // Asked before spectators could see every card: they haven't agreed to it, so they must ask again.
      if (spectatorsSeeCards(this.settings) && !r.consent && !this.botInfo(r.playerId)) {
        throw new ActionError(`${r.name} asked to sit before spectators could see every card; they need to ask again and agree to it`);
      }
      let target = seat ?? r.seat!;
      if (seat !== undefined) {
        if (!Number.isInteger(seat) || seat < 0 || seat >= this.state.seats.length) throw new ActionError('no such seat');
        this.checkSeatKept(seat);
        if (this.state.seats[seat]) throw new ActionError('that seat is taken');
        this.checkSeatFree(r.playerId, seat);
      } else if (target >= this.seatLimit()) {
        // The table is getting smaller and drops the seat they asked for: any open seat will do.
        const open = this.openSeats(r.playerId);
        if (!open.length) throw new ActionError('that seat is going when the table gets smaller, and every other seat is taken');
        target = open[this.rng(open.length)];
      } else if (this.state.seats[target]) {
        // Random seating: any open seat will do.
        const open = this.settings.seating.randomSeats ? this.openSeats(r.playerId) : [];
        if (!open.length) throw new ActionError('that seat has been taken');
        target = open[this.rng(open.length)];
      }
      this.state.requests = this.state.requests.filter((x) => x !== r);
      this.seatPlayer({ ...r, seat: target });
    } else {
      this.state.requests = this.state.requests.filter((x) => x !== r);
      this.addChips(r.playerId, r.amount, 'rebuy');
    }
    this.sync();
  }

  reject(by: PlayerId, requestId: string) {
    this.requirePower(by, 'approve');
    const r = this.state.requests.find((x) => x.id === requestId);
    this.state.requests = this.state.requests.filter((x) => x.id !== requestId);
    if (r) this.log(`${r.name}'s ${r.kind === 'seat' ? 'seat request' : 'rebuy'} was declined`);
    if (r) this.forgetBot(r.playerId);
    this.sync();
  }

  private checkBuyIn(playerId: PlayerId, stack: number) {
    if (!Number.isInteger(stack) || stack <= 0 || stack > MAX_CHIPS) throw new ActionError('the stack must be a positive whole number');
    const { minBuyIn, maxBuyIn, ratholeMinutes } = this.settings.seating;
    if (minBuyIn > 0 && stack < minBuyIn) throw new ActionError(`the minimum buy-in is ${this.money(minBuyIn)}`);
    if (maxBuyIn > 0 && stack > maxBuyIn) throw new ActionError(`the maximum buy-in is ${this.money(maxBuyIn)}`);
    const left = this.state.departures[playerId];
    if (ratholeMinutes > 0 && left && this.clock.now() - left.at < ratholeMinutes * 60_000 && stack < left.stack) {
      throw new ActionError(`you left with ${this.money(left.stack)} less than ${ratholeMinutes} minutes ago; come back with at least that`);
    }
  }

  /** A seat someone else is waiting on: held for a waitlisted player, or asked for and awaiting the host. */
  private checkSeatFree(playerId: PlayerId, seat: number) {
    const offer = this.offers().find((o) => o.seat === seat);
    if (offer && offer.playerId !== playerId) throw new ActionError(`that seat is being held for ${this.queueName(offer.playerId)} from the waitlist`);
    const asked = this.state.requests.find((r) => r.kind === 'seat' && r.seat === seat && r.playerId !== playerId);
    if (asked) throw new ActionError(`${asked.name} has asked for that seat`);
  }

  /**
   * Seats the table will still have at the next hand: a smaller table the host
   * asked for mid-hand drops the last seats then, and nobody may sit in them.
   */
  private seatLimit(): number {
    const next = this.state.pendingSettings?.table?.maxSeats;
    return typeof next === 'number' ? Math.min(next, this.state.seats.length) : this.state.seats.length;
  }

  private checkSeatKept(seat: number) {
    const limit = this.seatLimit();
    if (seat >= limit) throw new ActionError(`the table is going down to ${limit} seats after this hand; pick seat ${limit} or lower`);
  }

  /** Empty seats nobody else is waiting on. */
  private openSeats(playerId: PlayerId | null = null): number[] {
    const held = new Set([
      ...this.offers().filter((o) => o.playerId !== playerId).map((o) => o.seat),
      ...this.state.requests.filter((r) => r.kind === 'seat' && r.playerId !== playerId).map((r) => r.seat!),
    ]);
    const limit = this.seatLimit();
    return this.state.seats.flatMap((x, i) => (x || held.has(i) || i >= limit ? [] : [i]));
  }

  private queue(): WaitlistEntry[] {
    return (this.state.waitlist ??= []);
  }

  private offers() {
    return (this.state.offers ??= []);
  }

  private queueName(playerId: PlayerId) {
    return this.state.waitlist?.find((w) => w.playerId === playerId)?.name ?? this.nameOf(playerId);
  }

  /** Takes a player off the waitlist and lets go of any seat held for them. */
  private leaveQueue(playerId: PlayerId) {
    if (this.state.waitlist?.some((w) => w.playerId === playerId)) this.state.waitlist = this.state.waitlist.filter((w) => w.playerId !== playerId);
    if (this.state.offers?.some((o) => o.playerId === playerId)) this.state.offers = this.state.offers.filter((o) => o.playerId !== playerId);
  }

  /** Join the waitlist of a full cash table, with the buy-in to sit with when a seat comes up. */
  joinWaitlist(playerId: PlayerId, input: { name: string; stack: number }) {
    if (this.isTournament) throw new ActionError('the tournament seats players');
    if (!this.settings.seating.waitlist) throw new ActionError('this table has no waitlist');
    const name = cleanName(input.name);
    if (this.seatOf(playerId)) throw new ActionError('you already have a seat');
    if (this.queue().some((w) => w.playerId === playerId)) throw new ActionError("you're already on the waitlist");
    if (this.state.requests.some((r) => r.playerId === playerId && r.kind === 'seat')) throw new ActionError('you have already asked for a seat');
    if (this.openSeats(playerId).length) throw new ActionError('there is a free seat: take it');
    this.checkBuyIn(playerId, input.stack);
    this.queue().push({ playerId, name, stack: input.stack, at: this.clock.now() });
    this.log(`${name} joined the waitlist`);
    this.sync();
  }

  leaveWaitlist(playerId: PlayerId) {
    const entry = this.state.waitlist?.find((w) => w.playerId === playerId);
    if (!entry) return;
    this.leaveQueue(playerId);
    this.log(`${entry.name} left the waitlist`);
    this.sync();
  }

  /** Turns down a held seat: off the waitlist, and the seat goes to the next person. */
  declineOffer(playerId: PlayerId) {
    this.leaveWaitlist(playerId);
  }

  private seatPlayer(r: SeatRequest) {
    const { settings } = this;
    this.state.seats[r.seat!] = {
      seat: r.seat!,
      playerId: r.playerId,
      name: r.name,
      stack: r.amount,
      sittingOut: false,
      sitOutReason: null,
      // Before anyone has played there is nothing to post for.
      isNew: this.activePlayers().length >= 2 && this.state.handNumber > 0,
      missedSmallBlind: false,
      missedBigBlind: false,
      waitForBigBlind: false,
      straddle: false,
      timeouts: 0,
      timeBank: settings.timing.timeBankSeconds,
      handsSinceRefill: 0,
      leaveAfterHand: false,
      pendingChips: 0,
      pendingStack: null,
    };
    const row = this.state.ledger[r.playerId];
    if (row) {
      row.buyIn += r.amount;
      row.name = r.name;
    } else {
      const bot = this.botInfo(r.playerId);
      this.state.ledger[r.playerId] = { playerId: r.playerId, name: r.name, buyIn: r.amount, cashOut: 0, ...(bot ? { bot: true as const, owner: bot.ownerName, look: bot.look } : {}) };
    }
    delete this.state.departures[r.playerId];
    const bot = this.botInfo(r.playerId);
    this.log(`${bot ? `${bot.ownerName}'s practice bot ` : ''}${r.name} sat down in seat ${r.seat! + 1} with ${this.money(r.amount)}`);
    if (!bot) this.giveWayTo(r.name);
  }

  /**
   * A person who sits down keeps their name; a bot that has it (here, waiting, or gone
   * but still in the ledger) takes another, so nobody gets mixed up. Only on sitting
   * down, so asking for a seat never renames anyone's bot.
   */
  private giveWayTo(name: string) {
    const bots = new Set([...Object.keys(this.state.bots ?? {}), ...Object.values(this.state.ledger).flatMap((row) => (row.bot ? [row.playerId] : []))]);
    for (const id of bots) {
      const botName = this.seatOf(id)?.name ?? this.state.requests.find((r) => r.playerId === id)?.name ?? this.state.ledger[id]?.name;
      if (botName?.toLowerCase() === name.toLowerCase()) this.relookBot(id);
    }
  }

  /** Leave the table: folds a live hand now, or with `afterHand` plays it out first. */
  stand(playerId: PlayerId, opts: { afterHand?: boolean } = {}) {
    // The director would keep them seated with chips the table no longer has.
    if (this.isTournament) throw new ActionError('leave through the tournament');
    const seat = this.seatOf(playerId);
    if (!seat) return;
    if (this.inHand(playerId)) {
      seat.leaveAfterHand = true;
      if (!opts.afterHand) this.leaveHand(playerId);
    } else {
      this.removeSeat(seat);
    }
    this.sync();
  }

  private removeSeat(seat: SeatState) {
    this.nitLeaves(seat.playerId);
    const row = this.state.ledger[seat.playerId];
    const stack = seat.stack + seat.pendingChips;
    if (row) row.cashOut += stack;
    this.state.departures[seat.playerId] = { stack, at: this.clock.now() };
    this.state.seats[seat.seat] = null;
    // A rebuy they asked for has nobody to go to now.
    this.state.requests = this.state.requests.filter((r) => r.playerId !== seat.playerId);
    this.log(`${seat.name} left the table with ${this.money(stack)}`);
    this.forgetBot(seat.playerId);
  }

  /** Has chips to sit back in with: some in front of them, or some on the way after this hand. The view shows the seat bar's I'm back by this. */
  canSitIn(playerId: PlayerId): boolean {
    const seat = this.seatOf(playerId);
    return !!seat && (seat.stack + seat.pendingChips > 0 || seat.pendingStack !== null);
  }

  sitOut(playerId: PlayerId, value: boolean) {
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('you are not seated');
    if (!value && !this.canSitIn(playerId)) throw new ActionError('rebuy before sitting back in');
    seat.sittingOut = value;
    seat.sitOutReason = value ? 'player' : null;
    if (!value) seat.timeouts = 0;
    this.sync();
  }

  setPreferences(playerId: PlayerId, prefs: { waitForBigBlind?: boolean; straddle?: boolean; nitGame?: boolean; mood?: string | null }) {
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('you are not seated');
    if (prefs.mood !== undefined) seat.mood = cleanMood(prefs.mood);
    if (prefs.nitGame !== undefined) seat.nitOptIn = !!prefs.nitGame;
    if (prefs.waitForBigBlind !== undefined) seat.waitForBigBlind = !!prefs.waitForBigBlind;
    if (prefs.straddle !== undefined) seat.straddle = !!prefs.straddle;
    this.sync();
  }

  rebuy(playerId: PlayerId, amount: number) {
    if (this.isTournament) throw new ActionError('use the tournament rebuy');
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('you are not seated');
    if (!this.settings.seating.allowRebuys) throw new ActionError('rebuys are off at this table');
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_CHIPS) throw new ActionError('the amount must be a positive whole number');
    const { maxBuyIn } = this.settings.seating;
    if (maxBuyIn > 0 && seat.stack + seat.pendingChips + amount > maxBuyIn) throw new ActionError(`you can have at most ${this.money(maxBuyIn)} in front of you`);
    if (this.settings.seating.rebuyRequiresApproval && !this.can(playerId, 'approve')) {
      this.state.requests = this.state.requests.filter((r) => !(r.playerId === playerId && r.kind === 'rebuy'));
      this.state.requests.push({ id: randomUUID().slice(0, 8), kind: 'rebuy', playerId, name: seat.name, seat: seat.seat, amount, at: this.clock.now() });
      this.log(`${seat.name} asked to add ${this.money(amount)}`);
    } else {
      this.addChips(playerId, amount, 'rebuy');
    }
    this.sync();
  }

  /** Adds chips now between hands, or queues them for the next hand. */
  private addChips(playerId: PlayerId, amount: number, why: 'rebuy' | 'host') {
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('that player is not seated');
    const row = this.state.ledger[playerId];
    if (row) row.buyIn += amount;
    if (this.inHand(playerId)) seat.pendingChips += amount;
    else {
      seat.stack += amount;
      if (seat.sitOutReason === 'busted') {
        seat.sittingOut = false;
        seat.sitOutReason = null;
      }
    }
    this.log(`${seat.name} ${why === 'rebuy' ? 'added' : 'was given'} ${this.money(amount)}`);
  }

  // ---------------------------------------------------------------- host controls

  private requireHost(by: PlayerId) {
    if (!this.isHost(by)) throw new ActionError('only the host can do that');
  }

  private requirePower(by: PlayerId, power: HostPower) {
    if (!this.can(by, power)) throw new ActionError(this.isStaff(by) ? "the host hasn't given you that power" : 'only the host can do that');
  }

  /** Co-hosts act on players, never on the host or another co-host. */
  private notTheHost(by: PlayerId, playerId: PlayerId) {
    if (by !== this.state.hostId && by !== playerId && this.isStaff(playerId)) throw new ActionError('only the host can do that to the host or a co-host');
  }

  /** The host names a co-host (or changes one's powers). Cash tables; tournaments have their own. */
  setCoHost(by: PlayerId, playerId: PlayerId, powers: unknown) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('tournament co-hosts are set in the lobby');
    const was = this.state.coHosts?.some((c) => c.playerId === playerId);
    if (!was && !this.seatOf(playerId) && !this.isOnline(playerId)) throw new ActionError('that player is not at the table');
    if (this.isBot(playerId)) throw new ActionError("bots can't be co-hosts");
    this.state.coHosts = this.roles(() => withCoHost(this.staff(), { playerId, name: this.queueName(playerId), powers }));
    if (!was) this.log(`${this.nameOf(by)} made ${this.queueName(playerId)} a co-host`);
    this.sync();
  }

  /** The host removes a co-host, or a co-host steps down. */
  removeCoHost(by: PlayerId, playerId: PlayerId) {
    if (by !== playerId) this.requireHost(by);
    this.state.coHosts = this.roles(() => withoutCoHost(this.staff(), playerId));
    this.log(by === playerId ? `${this.queueName(playerId)} stepped down as co-host` : `${this.queueName(playerId)} is no longer a co-host`);
    this.sync();
  }

  private roles<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof RoleError) throw new ActionError(e.message);
      throw e;
    }
  }

  start(by: PlayerId) {
    this.requirePower(by, 'run');
    if (this.isTournament) throw new ActionError('the tournament starts this table');
    if (this.activePlayers().length < 2) throw new ActionError('need at least two players with chips');
    this.state.started = true;
    this.state.stopAfterHand = false;
    this.state.paused = false;
    this.state.pausedLeft = null;
    this.fairResumed();
    if (!this.state.hand || this.state.hand.phase === 'complete') this.state.nextHandAt = this.clock.now();
    this.log('The host started the game');
    this.sync();
  }

  /**
   * Throws unless `by` may delete this table for good: only the host of a cash
   * table nobody has played a real game at (see RuntimeState.realGame).
   */
  checkDeletable(by: PlayerId) {
    if (this.isTournament) throw new ActionError('tournament tables are kept with their tournament');
    if (!this.isHost(by)) throw new ActionError('only the host can delete the table');
    if (this.state.realGame || (this.handLive() && realGameHand(this.state.hand!.seats, (id) => !!this.botBadge(id)))) {
      throw new ActionError("people have played real hands here, so the table stays: everyone's records and the ledger depend on it. You can hide it from your profile instead.");
    }
  }

  /** Cash tables: no new hands after the current one. */
  stop(by: PlayerId) {
    this.requirePower(by, 'run');
    if (this.isTournament) throw new ActionError('the tournament runs this table');
    // Between hands the game stops now; otherwise after this hand.
    this.state.stopAfterHand = this.handLive();
    if (!this.handLive()) {
      this.state.started = false;
      this.revealHands();
    }
    this.state.nextHandAt = null;
    this.log(`${this.nameOf(by)} stopped the game`);
    this.sync();
  }

  // ------------------------------------------------------------ provably fair dealing (docs/FAIRNESS.md)

  /** The next hand's seed and who has sent a client seed for it; made on first use. */
  private fairState() {
    this.state.fair ??= { next: this.newServerSeed(), clientSeeds: {}, revealedThrough: 0, committedAt: this.clock.now() };
    return this.state.fair;
  }

  private newServerSeed() {
    const bytes = Array.from({ length: 32 }, () => this.rng(256));
    const serverSeed = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    if (this.state.fair) this.state.fair.committedAt = this.clock.now();
    return { serverSeed, commit: commitmentOf(serverSeed) };
  }

  /** What everyone may see before the deal: the commitment to the next hand's server seed. */
  nextCommit(): string {
    return this.fairState().next.commit;
  }

  /** A seated player's browser adds its own randomness to the next hand, against the commitment it saw. */
  addClientSeed(playerId: PlayerId, input: { commit: unknown; seed: unknown }) {
    const f = this.fairState();
    if (!this.seatOf(playerId)) throw new ActionError('only seated players add to the shuffle');
    if (typeof input.seed !== 'string' || !SEED_RE.test(input.seed)) throw new ActionError('a seed is 16 to 64 hex characters');
    if (input.commit !== f.next.commit) throw new ActionError('that hand has already been dealt');
    f.clientSeeds[playerId] = input.seed;
    // The deal may have been waiting for this one.
    if (this.seedWait) this.sync();
  }

  /**
   * The earliest the next hand may be dealt: FAIR_LEAD_MS after its commitment appeared, or later, up to
   * FAIR_SEED_WAIT_MS, while a seated player who is connected (not a bot) hasn't sent a seed yet.
   */
  private fairReadyAt(): number {
    const committedAt = this.state.fair?.committedAt ?? 0;
    const lead = committedAt + this.fairLeadMs;
    if (this.fairLeadMs === 0) return lead;
    const seeds = this.state.fair?.clientSeeds ?? {};
    const waiting = this.state.seats.some((x) => x && !this.isBot(x.playerId) && (this.connections.get(x.playerId) ?? 0) > 0 && !seeds[x.playerId]);
    return waiting ? Math.max(lead, committedAt + FAIR_SEED_WAIT_MS) : lead;
  }

  /**
   * The hand's fairness record: the committed server seed plus the client
   * seeds of the players dealt in. The commitment stays the next one until the
   * hand has really started (fairDealt), so a deal that fails never spends one:
   * browsers warn about a commitment replaced without a hand dealt from it.
   */
  private fairDeal(dealtIn: PlayerId[]): HandFairness {
    const f = this.fairState();
    const { serverSeed, commit } = f.next;
    const clientSeeds = dealtIn.filter((p) => f.clientSeeds[p]).map((playerId) => ({ playerId, seed: f.clientSeeds[playerId] }));
    return { version: FAIR_VERSION, commit, serverSeed, clientSeeds, handSeed: handSeedOf(serverSeed, clientSeeds.map((c) => c.seed)) };
  }

  /** The hand is dealt: commit a new server seed for the hand after, so players have this whole hand to send theirs. */
  private fairDealt() {
    const f = this.fairState();
    f.next = this.newServerSeed();
    f.clientSeeds = {};
  }

  /** The host stopped the game: every hand so far may be checked once it stays stopped FAIR_STOP_REVEAL_MS. */
  private revealHands() {
    const f = this.fairState();
    // Stopped again with nothing dealt since: the half hour still counts from the first stop.
    if (f.stopped && f.stopped.through >= this.state.handNumber) return;
    this.fairResumed();
    if (this.state.handNumber > f.revealedThrough) f.stopped = { through: this.state.handNumber, at: this.clock.now() };
  }

  /** The game goes on: hands the last stop has already opened stay open; the rest stay private. */
  private fairResumed() {
    const f = this.state.fair;
    if (!f?.stopped) return;
    if (this.clock.now() >= f.stopped.at + this.fairStopRevealMs) f.revealedThrough = Math.max(f.revealedThrough, f.stopped.through);
    delete f.stopped;
  }

  /** When the hands the last stop covers open, while that's still to come. */
  private fairStopDue(): number | null {
    const stop = this.state.fair?.stopped;
    if (!stop) return null;
    const due = stop.at + this.fairStopRevealMs;
    return due > this.clock.now() ? due : null;
  }

  /** The highest hand number anyone may check now through a stop (12-hour reveals aside). Views send it so browsers fetch again. */
  fairOpenThrough(): number {
    const f = this.state.fair;
    if (!f) return 0;
    const stopOpen = f.stopped && this.clock.now() >= f.stopped.at + this.fairStopRevealMs ? f.stopped.through : 0;
    return Math.max(f.revealedThrough, stopOpen);
  }

  /** When a finished hand's server seed may be shown (see fairRevealsAt). */
  fairRevealsAt(handNumber: number, endedAt: number): number {
    return fairRevealsAt(this.state.fair, handNumber, endedAt, this.fairStopRevealMs);
  }

  fairRevealed(handNumber: number, endedAt: number): boolean {
    return this.now() >= this.fairRevealsAt(handNumber, endedAt);
  }

  /** The table's clock. */
  now(): number {
    return this.clock.now();
  }

  /** Deal now (when the next hand doesn't start by itself). */
  dealNext(by: PlayerId) {
    this.requirePower(by, 'run');
    if (this.isTournament) throw new ActionError('the tournament runs this table');
    if (this.handLive()) throw new ActionError('a hand is still being played');
    this.state.started = true;
    this.fairResumed();
    this.state.nextHandAt = this.clock.now();
    this.sync();
  }

  /** Cash tables: make the next hand a bomb pot (or take that back). */
  requestBombPot(by: PlayerId, value: boolean) {
    this.requirePower(by, 'run');
    if (this.isTournament) throw new ActionError('bomb pots are for cash games');
    const sg = this.sideGames();
    if (sg.bombPotNext === value) return;
    sg.bombPotNext = value;
    this.log(value ? 'The host made the next hand a bomb pot' : 'The host cancelled the bomb pot');
    this.sync();
  }

  /** Bomb pot counters; tables saved before they existed start fresh. */
  sideGames(): SideGameState {
    this.state.sideGames ??= { handsSinceBombPot: 0, bombPotNext: false };
    return this.state.sideGames;
  }

  /** Rake and the Nit game after a cash hand, once stacks are back on the seats. */
  private settleSideGames(hand: HandState) {
    const sg = this.sideGames();
    this.feeAndBounty(hand);

    const round = sg.nit;
    if (!round || !this.nitStillOn()) return;
    const seatOfPlayer = new Map(hand.seats.map((x) => [x.playerId, x.seat]));
    const inHand = round.holders.filter((id) => seatOfPlayer.has(id));
    const cleared = new Set(nitClears(hand, inHand.map((id) => seatOfPlayer.get(id)!)).map((seat) => hand.seats.find((x) => x.seat === seat)!.playerId));
    if (!cleared.size) return;
    round.holders = round.holders.filter((id) => !cleared.has(id));
    for (const id of cleared) this.log(`${this.nameOf(id)} is off the nit`);
    if (round.holders.length === 1) this.nitPays(round.holders[0], 'is the last nit');
  }

  /** A finished cash hand's house fee joins the fee total, and its 7-2 bounties go in the table log. */
  private feeAndBounty(hand: { events: HandState['events']; seats: { seat: number; playerId: PlayerId }[] }) {
    const sg = this.sideGames();
    const rake = hand.events.reduce((n, e) => n + (e.t === 'transfer' && e.kind === 'rake' ? e.amount : 0), 0);
    if (rake) sg.rakeTotal = (sg.rakeTotal ?? 0) + rake;
    this.logBounty(hand, 0);
  }

  /** A line in the table log for each 7-2 bounty paid, so the whole table sees it. */
  private logBounty(hand: { events: HandState['events']; seats: { seat: number; playerId: PlayerId }[] }, fromEvent: number) {
    const collected = new Map<number, number>();
    for (const e of hand.events.slice(fromEvent)) {
      if (e.t === 'transfer' && e.kind === 'bounty-72' && e.to !== 'house') collected.set(e.to, (collected.get(e.to) ?? 0) + e.amount);
    }
    for (const [seatNo, amount] of collected) {
      const playerId = hand.seats.find((x) => x.seat === seatNo)?.playerId;
      if (playerId && amount > 0) this.log(`${this.nameOf(playerId)} wins with 7-2 and collects ${this.money(amount)} in bounties`);
    }
  }

  /** Starts a Nit game round when enough opted-in players are dealt in. */
  private maybeStartNitRound(dealtIn: number[], bigBlind: number) {
    const sg = this.sideGames();
    const cfg = nitSchema.get(this.settings);
    if (!cfg.enabled) {
      if (sg.nit) this.log('The Nit game is off; the round is cancelled');
      sg.nit = null;
      return;
    }
    if (sg.nit) return;
    const players = dealtIn.map((n) => this.state.seats[n]!).filter((x) => x.nitOptIn).map((x) => x.playerId);
    if (players.length < cfg.minPlayers) return;
    const prize = cfg.prizeBigBlinds * bigBlind;
    sg.nit = { participants: players, holders: [...players], prize };
    this.log(`Nit game: ${players.length} players are in. The last one to win a pot pays ${this.money(prize)} to each of the others.`);
  }

  /** A participant leaves: a holder forfeits (pays everyone); anyone else just drops out. */
  private nitLeaves(playerId: PlayerId) {
    const round = this.state.sideGames?.nit;
    if (!round || !round.participants.includes(playerId) || !this.nitStillOn()) return;
    if (round.holders.includes(playerId)) {
      this.nitPays(playerId, 'left holding the nit');
      return;
    }
    round.participants = round.participants.filter((id) => id !== playerId);
    if (round.participants.length < 2) {
      this.sideGames().nit = null;
      this.log('The Nit game round ended: not enough players');
    }
  }

  /** Turning the Nit game off cancels a running round straight away, so nobody pays after that. */
  private nitStillOn(): boolean {
    const { pendingSettings } = this.state;
    // A change still waiting for the hand to end counts already.
    const settings = pendingSettings ? applyAtNextHand(this.settings, pendingSettings).settings : this.settings;
    if (nitSchema.get(settings).enabled) return true;
    if (this.state.sideGames?.nit) {
      this.sideGames().nit = null;
      this.log('The Nit game is off; the round is cancelled');
    }
    return false;
  }

  /**
   * The loser pays the full prize to every other participant and the round ends.
   * The prize is guaranteed, as PokerNow's escrow guarantees it: what their
   * stack can't cover is added to their buy-in, as chips brought from outside
   * and paid straight on, so settle-up collects it.
   */
  private nitPays(loserId: PlayerId, why: string) {
    const sg = this.sideGames();
    const round = sg.nit!;
    sg.nit = null;
    const loser = this.seatOf(loserId);
    if (!loser) return;
    const payees = round.participants.filter((id) => id !== loserId).flatMap((id) => this.seatOf(id) ?? []);
    const owed = round.prize * payees.length;
    const fromStack = Math.min(loser.stack, owed);
    const shortfall = owed - fromStack;
    loser.stack -= fromStack;
    if (shortfall > 0) this.ledgerEdit(loserId, shortfall);
    for (const to of payees) {
      // A payee in a live hand gets the chips when it ends, or finishing the hand would overwrite them.
      if (this.inHand(to.playerId)) to.pendingChips += round.prize;
      else to.stack += round.prize;
      if (to.sitOutReason === 'busted') {
        to.sittingOut = false;
        to.sitOutReason = null;
      }
    }
    if (loser.stack === 0 && loser.pendingChips === 0 && !loser.leaveAfterHand) {
      loser.sittingOut = true;
      loser.sitOutReason = 'busted';
    }
    const extra = shortfall > 0 ? ` (${this.money(shortfall)} of it added to their buy-in)` : '';
    this.log(`${this.nameOf(loserId)} ${why} and pays ${this.money(owed)} in all${extra} (Nit game)`);
  }

  pause(by: PlayerId, value: boolean) {
    this.requirePower(by, 'run');
    // Tournament tables hold through the director's gate when the tournament pauses.
    if (this.isTournament) throw new ActionError('pause the tournament from its lobby');
    this.setPaused(value);
  }

  /** Freezes every clock where it is; resuming gives back the same time. */
  setPaused(value: boolean) {
    const s = this.state;
    if (s.paused === value) return;
    const now = this.clock.now();
    if (value) {
      s.pausedLeft = {
        at: now,
        turn: s.turn?.deadline != null ? Math.max(RESUME_MIN_MS, s.turn.deadline - now) : null,
        nextHand: s.nextHandAt != null ? Math.max(0, s.nextHandAt - now) : null,
        rit: s.ritDeadline != null ? Math.max(RESUME_MIN_MS, s.ritDeadline - now) : null,
      };
      if (s.level.runningSince !== null) {
        s.level.elapsedMs += now - s.level.runningSince;
        s.level.runningSince = null;
      }
      s.paused = true;
      this.log('Game paused');
    } else {
      const left = s.pausedLeft;
      if (left && s.turn && left.turn !== null) {
        // The turn started that much later too, so the clock's bar picks up where it stopped.
        if (s.turn.deadline !== null) s.turn.startedAt += now + left.turn - s.turn.deadline;
        s.turn.deadline = now + left.turn;
        // The bank starts where the extended deadline less the whole bank falls (it may still be ahead).
        const banked = s.seats[s.turn.seat];
        if (s.turn.bankFrom !== null) s.turn.bankFrom = banked ? s.turn.deadline - banked.timeBank * 1000 : now;
      }
      if (left?.nextHand != null) s.nextHandAt = now + left.nextHand;
      if (left?.rit != null && s.hand?.phase === 'rit-vote') s.ritDeadline = now + left.rit;
      s.pausedLeft = null;
      s.paused = false;
      for (const id of this.offlineSince.keys()) this.offlineSince.set(id, now);
      this.watchHost();
      if (s.settings.blindSchedule.enabled && s.handNumber > 0) s.level.runningSince = now;
      this.log('Game resumed');
    }
    this.sync();
  }

  /**
   * While paused: how far the clocks would move on if play resumed now. Views add it to
   * every deadline so the clocks show the time left and stand still.
   */
  pausedFor(now = this.clock.now()): number {
    const s = this.state;
    const left = s.paused ? s.pausedLeft : null;
    if (!left) return 0;
    // Snapshots from before the pause time was kept: the turn clock still tells it.
    const at = left.at ?? (s.turn?.deadline != null && left.turn !== null ? s.turn.deadline - left.turn : null);
    return at === null ? 0 : Math.max(0, now - at);
  }

  /** The run-it-twice vote's deadline as shown: while paused, what resuming now would give. */
  ritDeadlineShown(now = this.clock.now()): number | null {
    const s = this.state;
    if (s.paused && s.pausedLeft?.rit != null) return now + s.pausedLeft.rit;
    return s.ritDeadline;
  }

  /** Host edit: some fields apply now, the rest at the next hand. */
  updateSettings(by: PlayerId, patch: SettingsPatch) {
    this.requirePower(by, 'settings');
    if (this.isTournament) throw new ActionError('change tournament settings in its lobby');
    const s = this.state;
    const merged = s.pendingSettings ? mergePatches(s.pendingSettings, patch) : patch;
    let result;
    let target: TableSettings;
    try {
      // Validate the end result now so the host sees errors immediately.
      target = applyAtNextHand(s.settings, merged).settings;
      this.checkSettings(target);
      result = applyImmediate(s.settings, merged);
    } catch (e) {
      if (e instanceof SettingsError) throw new ActionError(e.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
      throw e;
    }
    // A hand is played under the card visibility it was dealt with: nobody can open it up partway through.
    if (!spectatorsSeeCards(s.settings) && spectatorsSeeCards(target) && this.handLive()) {
      throw new ActionError('spectators can only be shown every hole card between hands; try again when this hand ends');
    }
    // Against what was already on its way, so a change queued earlier in the hand isn't announced again.
    const before = s.pendingSettings ? applyAtNextHand(s.settings, s.pendingSettings).settings : s.settings;
    for (const n of settingsNotices(before, target, this.nameOf(by), this.handLive())) {
      this.log(n.text);
      if (n.loud) this.dealerSays(n.text);
    }
    s.settings = result.settings;
    s.pendingSettings = result.deferred;
    this.trackSeeAll();
    const now = this.clock.now();
    if (result.diff.length) s.settingsLog.push({ at: now, by, when: 'now', changes: result.diff });
    if (result.deferred) {
      const later = applyAtNextHand(s.settings, result.deferred).diff;
      if (later.length) s.settingsLog.push({ at: now, by, when: 'next-hand', changes: later });
    }
    if (s.settingsLog.length > LOG_LIMIT) s.settingsLog.splice(0, s.settingsLog.length - LOG_LIMIT);
    // Between hands, queued changes can take effect straight away.
    if (!this.handLive()) this.applyPendingSettings();
    // Turning the Nit game off ends any round now, mid-hand or not.
    this.nitStillOn();
    this.sync();
  }

  /** Server-side checks the schema can't make: games exist, seats fit, mode fixed. */
  private checkSettings(next: TableSettings) {
    const cur = this.state.settings;
    if (next.table.mode !== cur.table.mode) throw new ActionError('a table cannot switch between cash and tournament');
    // Every amount here, the ledger and everyone's records are in the table's unit, so it stays the one the table was made with.
    if (next.stakes.centsMode !== cur.stakes.centsMode) throw new ActionError(cur.stakes.centsMode ? 'cash games are played in dollars and cents' : 'this table plays in chips; start a new table to play in dollars and cents');
    const games = next.game.rotation.enabled ? next.game.rotation.steps.map((st) => st.gameId) : [next.game.gameId];
    for (const id of games) {
      let spec: GameSpec;
      try {
        spec = variants.get(id).spec;
      } catch {
        throw new ActionError(`unknown game ${id}`);
      }
      if (next.table.maxSeats > spec.maxPlayers) throw new ActionError(`${spec.name} seats at most ${spec.maxPlayers}`);
    }
    const bombGame = bombPotSchema.get(next).gameId;
    if (bombGame) {
      let spec: GameSpec;
      try {
        spec = variants.get(bombGame).spec;
      } catch {
        throw new ActionError(`unknown bomb pot game ${bombGame}`);
      }
      if (spec.family !== 'flop' || spec.forcedBets !== 'blinds') throw new ActionError(`bomb pots need a game with a flop, not ${spec.name}`);
    }
    const lastTaken = this.state.seats.reduce((m, seat, i) => (seat ? i : m), -1);
    if (next.table.maxSeats <= lastTaken) throw new ActionError(`seat ${lastTaken + 1} is taken; move that player before removing it`);
  }

  private applyPendingSettings() {
    const s = this.state;
    if (!s.pendingSettings) return;
    const before = s.settings;
    s.settings = applyAtNextHand(s.settings, s.pendingSettings).settings;
    s.pendingSettings = null;
    this.trackSeeAll();
    const seats = s.settings.table.maxSeats;
    if (seats !== s.seats.length) {
      // Nobody should be left in a dropped seat, but if someone is, they cash out rather than vanish with their chips.
      for (const seat of s.seats.slice(seats)) if (seat) this.removeSeat(seat);
      s.seats = Array.from({ length: seats }, (_, i) => s.seats[i] ?? null);
      // The blinds move on from where they were, as after any hand; they start afresh only if one of them sat in a
      // seat that is gone (redrawing them anyway could give the last big blind the big blind again).
      const p = s.positions;
      if (p && [p.button, p.smallBlind, p.bigBlind].some((x) => x !== null && x >= seats)) s.positions = null;
    }
    if (!before.blindSchedule.enabled && s.settings.blindSchedule.enabled) {
      s.level = { index: 0, elapsedMs: 0, runningSince: s.handNumber > 0 && !s.paused ? this.clock.now() : null, hands: 0 };
    }
    if (JSON.stringify(before.game.rotation) !== JSON.stringify(s.settings.game.rotation)) {
      s.rotation = { step: 0, hands: 0, orbits: 0, anchor: null };
    }
  }

  setStack(by: PlayerId, playerId: PlayerId, stack: number) {
    this.requirePower(by, 'chips');
    this.notTheHost(by, playerId);
    if (this.isTournament) throw new ActionError('stacks are set by the tournament');
    if (!Number.isInteger(stack) || stack < 0 || stack > MAX_CHIPS) throw new ActionError('the stack must be a whole number');
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('that player is not seated');
    if (this.inHand(playerId)) {
      seat.pendingStack = stack;
    } else {
      this.ledgerEdit(playerId, stack - seat.stack);
      seat.stack = stack;
      // Chips from the host bring a busted player back in, as a rebuy does.
      if (stack > 0 && seat.sitOutReason === 'busted') {
        seat.sittingOut = false;
        seat.sitOutReason = null;
      }
    }
    this.log(`The host set ${seat.name}'s stack to ${this.money(stack)}${this.inHand(playerId) ? ' after this hand' : ''}`);
    this.sync();
  }

  kick(by: PlayerId, playerId: PlayerId) {
    this.requirePower(by, 'players');
    this.notTheHost(by, playerId);
    if (this.isTournament) throw new ActionError('remove players through the tournament');
    const seat = this.seatOf(playerId);
    this.state.requests = this.state.requests.filter((r) => r.playerId !== playerId);
    // Someone removed from the table stops helping run it.
    if (this.state.coHosts?.some((c) => c.playerId === playerId)) this.state.coHosts = this.roles(() => withoutCoHost(this.staff(), playerId));
    if (!seat) {
      const waiting = this.state.waitlist?.find((w) => w.playerId === playerId);
      if (waiting) this.log(`The host took ${waiting.name} off the waitlist`);
      this.leaveQueue(playerId);
      this.forgetBot(playerId);
      return this.sync();
    }
    this.log(`The host removed ${seat.name}`);
    if (this.inHand(playerId)) {
      seat.leaveAfterHand = true;
      this.leaveHand(playerId);
    } else this.removeSeat(seat);
    this.sync();
  }

  hostSitOut(by: PlayerId, playerId: PlayerId) {
    this.requirePower(by, 'players');
    this.notTheHost(by, playerId);
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('that player is not seated');
    if (this.isBot(playerId)) throw new ActionError('remove the bot instead');
    seat.sittingOut = true;
    seat.sitOutReason = 'host';
    this.sync();
  }

  /**
   * Cash tables, between hands: deals everyone seated a random seat among the
   * seats already taken. The button is drawn again and missed blinds are
   * forgiven, as when a game starts.
   */
  shuffleSeats(by: PlayerId) {
    this.requirePower(by, 'players');
    if (this.isTournament) throw new ActionError('the tournament seats players');
    if (this.handLive()) throw new ActionError('shuffle between hands');
    const s = this.state;
    const taken = s.seats.flatMap((x, i) => (x ? [i] : []));
    if (taken.length < 2) throw new ActionError('need at least two players to shuffle');
    const players = shuffle(taken.map((i) => s.seats[i]!), this.rng);
    taken.forEach((seatNo, i) => {
      const seat = players[i];
      seat.seat = seatNo;
      seat.isNew = false;
      seat.missedBigBlind = false;
      seat.missedSmallBlind = false;
      s.seats[seatNo] = seat;
    });
    for (const r of s.requests) if (r.kind === 'rebuy') r.seat = this.seatOf(r.playerId)?.seat ?? r.seat;
    s.positions = null;
    s.rotation.anchor = null;
    this.log('The host shuffled the seats');
    this.sync();
  }

  /** Cash tables: the host moves a player who is not in the hand to an empty seat. */
  moveSeat(by: PlayerId, playerId: PlayerId, to: number) {
    this.requirePower(by, 'players');
    this.notTheHost(by, playerId);
    if (this.isTournament) throw new ActionError('the tournament seats players');
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('that player is not seated');
    if (!Number.isInteger(to) || to < 0 || to >= this.state.seats.length) throw new ActionError('no such seat');
    this.checkSeatKept(to);
    if (this.state.seats[to]) throw new ActionError('that seat is taken');
    this.checkSeatFree(playerId, to);
    if (this.inHand(playerId)) throw new ActionError('move them once this hand is over');
    const from = seat.seat;
    this.state.seats[from] = null;
    seat.seat = to;
    // A new place at the table: like someone sitting down, they post or wait for the big blind.
    if (this.activePlayers().length >= 2 && this.state.handNumber > 0) seat.isNew = true;
    seat.missedBigBlind = false;
    seat.missedSmallBlind = false;
    this.state.seats[to] = seat;
    for (const r of this.state.requests) if (r.playerId === playerId) r.seat = to;
    this.log(`The host moved ${seat.name} from seat ${from + 1} to seat ${to + 1}`);
    this.sync();
  }

  /** The host mutes (or unmutes) someone's chat for the whole table. */
  mute(by: PlayerId, playerId: PlayerId, value: boolean) {
    this.requirePower(by, 'players');
    this.notTheHost(by, playerId);
    if (playerId === by) throw new ActionError("you can't mute yourself");
    const muted = (this.state.muted ??= []);
    if (muted.includes(playerId) === value) return;
    this.state.muted = value ? [...muted, playerId] : muted.filter((id) => id !== playerId);
    this.log(`The host ${value ? 'muted' : 'unmuted'} ${this.queueName(playerId)} in chat`);
    this.sync();
  }

  transferHost(by: PlayerId, to: PlayerId) {
    this.requireHost(by);
    if (to === by) throw new ActionError('you are already the host');
    if (this.isBot(to)) throw new ActionError("a bot can't be the host");
    if (!this.seatOf(to) && !this.isOnline(to)) throw new ActionError('that player is not at the table');
    // An offline host would be handed straight on again.
    if (!this.isOnline(to)) throw new ActionError('that player is offline');
    // The old host stays on as a co-host with every power, so it can be handed back.
    Object.assign(this.state, this.roles(() => handOver(this.staff(), to, this.nameOf(by))));
    this.log(`${this.nameOf(by)} made ${this.nameOf(to)} the host`);
    this.watchHost();
    this.sync();
  }

  /** A host stack edit: chips added count as brought in, chips removed as taken out. */
  private ledgerEdit(playerId: PlayerId, change: number) {
    const row = this.state.ledger[playerId];
    if (!row) return;
    if (change > 0) row.buyIn += change;
    else row.cashOut -= change;
  }

  /**
   * A cash table whose host has been offline for HOST_HANDOFF_MS passes to an
   * online co-host, or else a seated player who is online and playing, starting
   * from the seat after the host's, so nobody is stuck waiting for approvals. Tournament tables are run
   * by the lobby and have no host to hand off.
   */
  private watchHost(retry: number | null = null) {
    this.clock.clearTimeout(this.hostTimer);
    this.hostTimer = null;
    const host = this.state.hostId;
    if (this.isTournament || this.isOnline(host)) return;
    const since = this.offlineSince.get(host) ?? this.upSince;
    const wait = retry ?? Math.max(0, since + HOST_HANDOFF_MS - this.clock.now());
    this.hostTimer = this.clock.setTimeout(() => {
      this.hostTimer = null;
      if (this.state.hostId !== host || this.isOnline(host)) return;
      const seats = this.state.seats;
      const from = this.seatOf(host)?.seat ?? -1;
      const order = seats.map((_, i) => seats[(from + 1 + i + seats.length) % seats.length]);
      // An online co-host first, then a seated person who is playing, then any seated person online.
      const coHost = this.state.coHosts?.find((c) => c.playerId !== host && this.isOnline(c.playerId));
      const human = (x: SeatState | null): x is SeatState => !!x && x.playerId !== host && !this.isBot(x.playerId) && this.isOnline(x.playerId);
      const next = coHost?.playerId ?? (order.find((x) => human(x) && !x.sittingOut) ?? order.find(human))?.playerId;
      if (!next) {
        // Nobody to take over yet: look again in a while (or as soon as someone connects).
        this.watchHost(HOST_HANDOFF_MS);
        return;
      }
      // The host keeps every power as a co-host, so they can carry on when they are back.
      Object.assign(this.state, this.roles(() => handOver(this.staff(), next, this.nameOf(host))));
      this.log(`${this.nameOf(host)} has been away for ${Math.round(HOST_HANDOFF_MS / 60_000)} minutes, so ${this.queueName(next)} is now the host`);
      this.sync();
    }, wait);
  }

  chat(playerId: PlayerId | null, text: string) {
    // No lone UTF-16 surrogates (Postgres refuses them, and the table could no longer be saved), and cut by whole
    // characters so a long line never splits an emoji into one.
    let clean = Array.from(String(text).replace(/\p{Cs}/gu, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
      .slice(0, 300)
      .join('')
      .trim();
    if (!clean) return;
    if (playerId) {
      if (this.state.muted?.includes(playerId)) throw new ActionError('the host has muted you');
      if (!this.settings.chat.guestChat && !this.seatOf(playerId) && !this.isStaff(playerId)) throw new ActionError('only players at the table can chat here');
      if (this.settings.chat.profanityFilter) clean = maskProfanity(clean);
    }
    this.addChat({ at: this.clock.now(), playerId, name: playerId ? this.nameOf(playerId) : 'Dealer', text: clean });
    this.onChange();
  }

  /** An amount as players see it at this table: dollars and cents at a cash table, chips in a tournament. */
  money(chips: number) {
    return amountText(chips, this.state.settings.stakes.centsMode);
  }

  nameOf(playerId: PlayerId) {
    return (
      this.seatOf(playerId)?.name ??
      this.state.ledger[playerId]?.name ??
      this.state.handNames?.[playerId] ??
      this.state.waitlist?.find((w) => w.playerId === playerId)?.name ??
      this.guestNames.get(playerId) ??
      'Guest'
    );
  }

  /** Who may throw a gesture at whom: anyone with the table open, at a seated player other than themselves. */
  checkGesture(from: PlayerId, to: PlayerId) {
    if (this.state.settings.chat.gestures === false) throw new ActionError('the host has turned gestures off');
    if (from === to) throw new ActionError('pick another player');
    if (!this.seatOf(to)) throw new ActionError('that player is not seated');
  }

  // ---------------------------------------------------------------- practice bots

  /**
   * Seats a practice bot with a short name and picture of its own ("Ace",
   * "Chip"), so bots are easy to tell apart. The host can always add one; seated players can unless the host turned
   * that off, and they wait for approval like anyone else when the table
   * approves seats. Cash tables only.
   */
  addBot(by: PlayerId, input: { ownerName?: string; seat?: number; stack?: number; level?: BotLevel } = {}) {
    if (this.isTournament) throw new ActionError("bots can't play in tournaments");
    if (this.isBot(by)) throw new ActionError("bots can't add bots");
    const level = input.level ?? 'normal';
    if (!BOT_LEVELS.includes(level)) throw new ActionError('no such level');
    // Staff who manage players add bots freely; anyone with approve seats them straight away.
    const host = this.can(by, 'players');
    if (!host) {
      if (!this.seatOf(by)) throw new ActionError('take a seat before adding a bot');
      if (this.settings.seating.allowPlayerBots === false) throw new ActionError('the host has turned off bots for players');
      const mine = Object.values(this.state.bots ?? {}).filter((b) => b.ownerId === by).length;
      if (mine >= BOTS_PER_PLAYER) throw new ActionError(`you can have at most ${BOTS_PER_PLAYER} bots here`);
    }
    const open = this.openSeats();
    let seat = input.seat;
    if (seat === undefined) {
      if (!open.length) throw new ActionError('every seat is taken');
      seat = open[0];
    } else {
      if (!Number.isInteger(seat) || seat < 0 || seat >= this.state.seats.length) throw new ActionError('no such seat');
      this.checkSeatKept(seat);
      if (this.state.seats[seat]) throw new ActionError('that seat is taken');
      this.checkSeatFree(by, seat);
    }
    const stack = input.stack ?? this.defaultBuyIn();
    const ownerName = cleanDisplayName(input.ownerName ?? '', NAME_MAX) || this.nameOf(by);
    const playerId = `bot-${randomUUID().slice(0, 8)}`;
    this.checkBuyIn(playerId, stack);
    const { look, name } = this.botLook();
    (this.state.bots ??= {})[playerId] = { ownerId: by, ownerName, buyIn: stack, look, level };
    const request: SeatRequest = { id: randomUUID().slice(0, 8), kind: 'seat', playerId, name, seat, amount: stack, at: this.clock.now() };
    if (!this.settings.seating.requireApproval || this.can(by, 'approve')) this.seatPlayer(request);
    else {
      this.state.requests.push(request);
      this.log(`${ownerName} asked to add a practice bot, ${name}, in seat ${seat + 1}`);
    }
    this.sync();
    return playerId;
  }

  /** The bot's owner or the host takes a bot away (after folding its hand). */
  removeBot(by: PlayerId, botId: PlayerId) {
    const bot = this.botInfo(botId);
    if (!bot) throw new ActionError('no such bot');
    if (bot.ownerId !== by && !this.can(by, 'players')) throw new ActionError('only its owner or the host can remove a bot');
    if (bot.ownerId !== by && by !== this.state.hostId && this.isStaff(bot.ownerId)) throw new ActionError("only the host can remove a bot the host or a co-host added");
    if (this.state.requests.some((r) => r.playerId === botId)) {
      this.state.requests = this.state.requests.filter((r) => r.playerId !== botId);
      this.forgetBot(botId);
      return this.sync();
    }
    const seat = this.seatOf(botId);
    if (!seat) return;
    this.log(`${this.nameOf(by)} removed ${seat.name}`);
    if (this.inHand(botId)) {
      seat.leaveAfterHand = true;
      this.leaveHand(botId);
    } else this.removeSeat(seat);
    this.sync();
  }

  /** The bot's owner or the host changes how well it plays, from its next move on. */
  setBotLevel(by: PlayerId, botId: PlayerId, level: BotLevel) {
    const bot = this.botInfo(botId);
    if (!bot) throw new ActionError('no such bot');
    if (!BOT_LEVELS.includes(level)) throw new ActionError('no such level');
    if (bot.ownerId !== by && !this.can(by, 'players')) throw new ActionError("only its owner or the host can change a bot's level");
    if (bot.ownerId !== by && by !== this.state.hostId && this.isStaff(bot.ownerId)) throw new ActionError("only the host can change a bot the host or a co-host added");
    if ((bot.level ?? 'normal') === level) return;
    bot.level = level;
    const name = this.seatOf(botId)?.name ?? this.state.requests.find((r) => r.playerId === botId)?.name ?? 'The bot';
    this.log(`${this.nameOf(by)} set ${name} to ${level[0].toUpperCase()}${level.slice(1)}`);
    this.sync();
  }

  /** A sensible stack (what a bot sits with): the table's minimum or maximum buy-in if set, else 100 big blinds. */
  defaultBuyIn() {
    const { stakes } = this.handSetup();
    const { minBuyIn, maxBuyIn } = this.settings.seating;
    const base = Math.max(stakes.bigBlind, stakes.bigBet / 2, stakes.bringIn * 5, 1) * 100;
    return maxBuyIn > 0 ? Math.min(maxBuyIn, Math.max(base, minBuyIn)) : Math.max(base, minBuyIn);
  }

  /**
   * The first of BOT_LOOKS that no other bot here has and nobody here goes by, now or
   * earlier (the ledger keeps everyone who played, so old hands stay clear too). Once
   * every name has been used at this table, names get a number: "Ace 2".
   */
  private botLook() {
    const names = [
      ...this.state.seats.flatMap((x) => (x ? [x.name] : [])),
      ...this.state.requests.map((r) => r.name),
      ...(this.state.waitlist ?? []).map((w) => w.name),
      ...Object.values(this.state.ledger).map((row) => row.name),
    ];
    const taken = new Set(names.map((n) => n.toLowerCase()));
    const used = new Set(Object.values(this.state.bots ?? {}).map((b) => b.look));
    // Looks no bot here has come first, even once names need numbers, so two robots never match while there's a choice.
    const order = BOT_LOOKS.map((_, look) => look).sort((a, b) => Number(used.has(a)) - Number(used.has(b)));
    for (let n = 1; ; n++) {
      for (const look of order) {
        if (n === 1 && used.has(look)) continue;
        const name = n === 1 ? BOT_LOOKS[look].name : `${BOT_LOOKS[look].name} ${n}`;
        if (!taken.has(name.toLowerCase())) return { look, name };
      }
    }
  }

  /** Bots saved before bots had looks were all "Ann's Poker Bot": each gets its own name and picture. */
  private giveBotsLooks() {
    for (const [playerId, bot] of Object.entries(this.state.bots ?? {})) {
      if (bot.look === undefined) this.relookBot(playerId);
    }
  }

  /** Gives a bot (here, or gone but still in the ledger) a fresh name and picture, everywhere its name shows. */
  private relookBot(playerId: PlayerId) {
    const bot = this.botInfo(playerId);
    if (bot) delete bot.look;
    const { look, name } = this.botLook();
    if (bot) bot.look = look;
    const seat = this.seatOf(playerId);
    const request = this.state.requests.find((r) => r.playerId === playerId);
    const row = this.state.ledger[playerId];
    const old = seat?.name ?? request?.name ?? row?.name;
    if (seat) seat.name = name;
    if (request) request.name = name;
    if (row) Object.assign(row, { name, look, ...(bot ? { owner: bot.ownerName } : {}) });
    if (old) this.log(`${old} is now ${name}`);
  }

  /** A bot's owner and look, for its live seat or for hands it played before it left. */
  botBadge(playerId: PlayerId): { ownerName: string; look: number } | null {
    const bot = this.botInfo(playerId);
    if (bot) return { ownerName: bot.ownerName, look: bot.look ?? 0 };
    const row = this.state.ledger[playerId];
    return row?.bot ? { ownerName: row.owner ?? '', look: row.look ?? 0 } : null;
  }

  /** A bot gone from the table entirely leaves no trace but its ledger row. */
  private forgetBot(playerId: PlayerId) {
    if (!this.isBot(playerId) || this.seatOf(playerId) || this.state.requests.some((r) => r.playerId === playerId)) return;
    delete this.state.bots![playerId];
  }

  /** A busted bot buys back in for what it started with, or leaves when rebuys are off. */
  private botBusted(seat: SeatState) {
    const bot = this.botInfo(seat.playerId)!;
    if (!this.settings.seating.allowRebuys) {
      this.removeSeat(seat);
      return;
    }
    const row = this.state.ledger[seat.playerId];
    if (row) row.buyIn += bot.buyIn;
    seat.stack = bot.buyIn;
    // However it lost its last chips (a hand, a late 7-2 claim, the Nit game), it plays on.
    seat.sittingOut = false;
    seat.sitOutReason = null;
    this.log(`${seat.name} bought back in for ${this.money(bot.buyIn)}`);
  }

  /** When the bot whose turn it is acts: a moment after its turn starts, so people can follow the play. */
  private botDue(): number | null {
    const s = this.state;
    const hand = s.hand;
    if (s.paused || !hand || hand.phase === 'complete' || hand.phase === 'rit-vote' || hand.toAct === null || !s.turn) return null;
    const seat = s.seats[hand.toAct];
    if (!seat || !this.isBot(seat.playerId) || s.turn.seat !== hand.toAct) return null;
    return s.turn.startedAt + BOT_THINK_MS + (hashKey(s.turn.key) % BOT_THINK_SPREAD_MS);
  }

  private botMove(seatNo: number) {
    const s = this.state;
    const hand = s.hand!;
    const level = this.botInfo(s.seats[seatNo]?.playerId ?? '')?.level ?? 'normal';
    // The event the note explains, taken before the move so it points at the move itself.
    const seq = hand.events.length;
    let why: MoveWhy | null = null;
    try {
      // Hard bots learn how each player plays from the hands the table keeps.
      const players = level === 'hard' ? readPlayers(s.history.map((r) => r.hand)) : undefined;
      const chosen = explainMove(hand, seatNo, seededRand(this.rng(0x7fffffff)), { level, players });
      if (chosen.move.kind === 'draw') engine.draw(hand, seatNo, chosen.move.discard);
      else engine.act(hand, seatNo, chosen.move.action);
      why = chosen.why;
    } catch (e) {
      // A bot must never hold up the table: check or fold instead.
      this.logError(`table ${s.id}: bot in seat ${seatNo + 1} failed to act`, e);
      engine.timeout(hand, seatNo);
    }
    // Only once the move is in, and outside the try: a fault in a reason loses that note, never changes or repeats the move.
    const made = why;
    this.addNote(hand, made ? (person) => botNote(seq, seatNo, level, made, hand, person) : () => plainNote(seq, seatNo, level, 'fallback'));
    s.turn = null;
    this.afterEngine(false);
  }

  /** Keeps why a bot moved, but only in a hand one person is playing against nothing but bots, and only for them. */
  private addNote(hand: HandState, make: (person: PlayerId) => BotNote) {
    const coach = this.state.coach;
    if (coach?.handNumber !== hand.input.handNumber) return;
    // A reason is only words: a fault in one is logged and the note is lost, and play goes on as it would have.
    try {
      coach.notes.push(make(coach.person));
    } catch (e) {
      this.logError(`table ${this.state.id}: a bot's reason failed`, e);
    }
  }

  // ---------------------------------------------------------------- tournament seating

  /** Tournament: put a player in a seat with a stack (start, late registration, moves). */
  placePlayer(input: { seat: number; playerId: PlayerId; name: string; stack: number; mood?: string | null; timeBank?: { seconds: number; handsSinceRefill: number } }) {
    if (this.state.seats[input.seat]) throw new Error(`seat ${input.seat} is taken`);
    this.state.seats[input.seat] = {
      seat: input.seat,
      playerId: input.playerId,
      name: input.name,
      stack: input.stack,
      sittingOut: false,
      sitOutReason: null,
      isNew: false,
      missedSmallBlind: false,
      missedBigBlind: false,
      waitForBigBlind: false,
      straddle: false,
      timeouts: 0,
      // A player moved from another table of the tournament keeps what is left of their time bank.
      timeBank: Math.min(input.timeBank?.seconds ?? Infinity, this.settings.timing.timeBankSeconds),
      handsSinceRefill: input.timeBank?.handsSinceRefill ?? 0,
      leaveAfterHand: false,
      pendingChips: 0,
      pendingStack: null,
      ...(input.mood ? { mood: input.mood } : {}),
    };
    // A moved or newly seated player is still on their way to the table.
    if (!this.isOnline(input.playerId)) this.offlineSince.set(input.playerId, this.clock.now());
    this.sync();
  }

  /** Tournament: take a player off this table (moved, eliminated, quit). */
  unseatPlayer(playerId: PlayerId) {
    const seat = this.seatOf(playerId);
    if (!seat) return;
    if (this.inHand(playerId)) {
      seat.leaveAfterHand = true;
      this.foldIfLive(playerId);
    } else this.state.seats[seat.seat] = null;
    this.sync();
  }

  /** Tournament: rebuy or add-on chips, applied before the next hand. */
  tournamentChips(playerId: PlayerId, chips: number) {
    const seat = this.seatOf(playerId);
    if (!seat) return;
    if (this.inHand(playerId)) seat.pendingChips += chips;
    else seat.stack += chips;
    this.sync();
  }

  /** Tournament: a host stack edit. The director sends it between this player's hands; during one it waits for the end. */
  tournamentSetStack(playerId: PlayerId, stack: number) {
    const seat = this.seatOf(playerId);
    if (!seat) return;
    if (this.inHand(playerId)) seat.pendingStack = stack;
    else seat.stack = stack;
    this.log(`${seat.name}'s stack was set to ${this.money(stack)}`);
    this.sync();
  }

  /** A hand is being played here. */
  get handInProgress() {
    return this.handLive();
  }

  /**
   * Tournament, after a crash: this snapshot is behind the director, which has
   * already closed the hand saved here as in progress (or later ones). Drops
   * that hand without playing it again and takes the hand number, button and
   * every stack from the director. Call before resume().
   */
  alignWithDirector(input: { handNumber: number; button: number | null; stacks: Record<PlayerId, number> }) {
    const s = this.state;
    for (const key of ['turn', 'next', 'rit', 'bot'] as const) this.clearTimer(key);
    if (this.handLive()) {
      s.hand = null;
      s.handStartedAt = null;
      s.turn = null;
      s.ritDeadline = null;
    }
    s.handNumber = input.handNumber;
    if (input.button !== null && s.positions?.button !== input.button) s.positions = { button: input.button, smallBlind: null, bigBlind: null };
    for (const seat of s.seats) {
      const stack = seat ? input.stacks[seat.playerId] : undefined;
      if (!seat || stack === undefined) continue;
      seat.stack = stack;
      seat.pendingChips = 0;
      seat.pendingStack = null;
      seat.leaveAfterHand = false;
    }
  }

  /** Tournament: the director may now let this table deal. */
  poke() {
    this.sync();
  }

  // ---------------------------------------------------------------- playing

  act(playerId: PlayerId, action: Action, sentFor: TurnKey = {}) {
    this.checkTurn(playerId, sentFor, 'That move arrived too late: the turn it was for is over.');
    const hand = this.liveHandFor(playerId);
    const seat = this.seatOf(playerId)!;
    this.spendBank(seat);
    engine.act(hand, seat.seat, action);
    seat.timeouts = 0;
    this.afterEngine();
  }

  draw(playerId: PlayerId, discard: number[], sentFor: TurnKey = {}) {
    this.checkTurn(playerId, sentFor, 'That move arrived too late: the turn it was for is over.');
    const hand = this.liveHandFor(playerId);
    const seat = this.seatOf(playerId)!;
    this.spendBank(seat);
    engine.draw(hand, seat.seat, discard);
    seat.timeouts = 0;
    this.afterEngine();
  }

  voteRunItTwice(playerId: PlayerId, yes: boolean, sentFor: Pick<TurnKey, 'handNumber'> = {}) {
    // Refused the same way whether or not a vote is open: see liveHandFor.
    if (!this.seatOf(playerId)) throw new ActionError('you are not in this hand');
    // A vote that lands after the vote closed (timed out, decided, or the hand ended) has nothing left to change,
    // and neither does one for an earlier hand's vote: it must not count in this one. Only the hand is sent (each
    // vote adds an event, so the count is no turn); a page from before sends none and votes as it always did.
    const current = this.state.hand;
    if (!current || current.phase !== 'rit-vote') return;
    if (sentFor.handNumber !== undefined && sentFor.handNumber !== current.input.handNumber) return;
    const hand = this.liveHandFor(playerId);
    engine.voteRunItTwice(hand, this.seatOf(playerId)!.seat, yes);
    this.afterEngine();
  }

  show(playerId: PlayerId, cardIndexes: number[], sentFor: Pick<TurnKey, 'handNumber'> = {}) {
    // Only the hand: shows (anyone's) add events after it ends, so its event count is no turn.
    this.checkTurn(playerId, sentFor, 'Too late to show those cards: a new hand has been dealt.');
    const hand = this.state.hand;
    // By player, not seat: seats may have been shuffled since the hand.
    const hs = this.seatOf(playerId) ? hand?.seats.find((x) => x.playerId === playerId) : undefined;
    if (!hand || !hs) throw new ActionError('you were not in the last hand');
    const from = hand.events.length;
    engine.show(hand, hs.seat, cardIndexes);
    if (hand.phase === 'complete' && this.state.handStartedAt === null) {
      this.applyLateTransfers(hand, from);
      this.logBounty(hand, from);
      // Store the hand again so its history (here and in the database) has the show.
      const record = this.state.history.find((r) => r.handNumber === hand.input.handNumber);
      if (record && hand.events.length > from) {
        record.hand = hand;
        this.onHandFinished(record);
      }
    }
    this.onChange();
  }

  /**
   * Transfers a show earned after the hand was settled (a 7-2 bounty claimed
   * late) move chips between the table's stacks as they are now: a payer
   * whose stack changed since the hand pays at most what they have, a player
   * who has left pays out of what they cashed out, and the winner gets only
   * what was collected.
   */
  private applyLateTransfers(hand: HandState, fromEvent: number) {
    const s = this.state;
    const playerAt = (seatNo: number) => hand.seats.find((x) => x.seat === seatNo)?.playerId;
    const take = (seatNo: number, amount: number): number => {
      const playerId = playerAt(seatNo);
      if (!playerId) return 0;
      const seat = this.seatOf(playerId);
      if (seat) {
        const paid = Math.min(amount, seat.stack);
        seat.stack -= paid;
        if (seat.stack === 0 && seat.pendingChips === 0 && !seat.sittingOut) {
          seat.sittingOut = true;
          seat.sitOutReason = 'busted';
        }
        return paid;
      }
      const row = s.ledger[playerId];
      const gone = s.departures[playerId];
      if (!row || !gone) return 0;
      const paid = Math.min(amount, gone.stack, row.cashOut);
      row.cashOut -= paid;
      gone.stack -= paid;
      return paid;
    };
    const give = (seatNo: number, amount: number) => {
      const playerId = playerAt(seatNo);
      if (!playerId || amount <= 0) return;
      const seat = this.seatOf(playerId);
      if (seat) {
        seat.stack += amount;
        if (seat.sitOutReason === 'busted') {
          seat.sittingOut = false;
          seat.sitOutReason = null;
        }
      } else if (s.ledger[playerId]) {
        s.ledger[playerId].cashOut += amount;
        const gone = s.departures[playerId];
        if (gone) gone.stack += amount;
      }
    };
    for (const e of hand.events.slice(fromEvent)) {
      if (e.t !== 'transfer') continue;
      const paid = e.from === 'house' ? e.amount : take(e.from, e.amount);
      if (e.to !== 'house') give(e.to, paid);
      // The hand records what really moved, so its history matches the ledger.
      if (paid !== e.amount) {
        const short = e.amount - paid;
        for (const hs of hand.seats) {
          if (hs.seat === e.from) hs.stack += short;
          if (hs.seat === e.to) hs.stack -= short;
        }
        e.amount = paid;
      }
    }
  }

  /**
   * A move sent with the turn it was for (TurnKey: the hand's number and event
   * count, as the player's view showed them) is refused once that turn has
   * passed, before the move itself is checked: a tap that arrives after its turn
   * (on a slow connection, usually the second of two) must not be played on a
   * later street. A part left out is not checked, so a page from before they
   * were sent plays as it always did; one that isn't a number (NaN) matches no
   * turn. Only a seated player's key is checked: they see the live table, but
   * a spectator may watch it running behind, and the answer must not tell them
   * where the live hand is (they are refused further on, whatever they send).
   */
  private checkTurn(playerId: PlayerId, sentFor: TurnKey, message: string) {
    if (!this.seatOf(playerId)) return;
    const hand = this.state.hand;
    if (sentFor.handNumber !== undefined && sentFor.handNumber !== hand?.input.handNumber) throw new ActionError(message);
    if (sentFor.at !== undefined && sentFor.at !== hand?.events.length) throw new ActionError(message);
  }

  /**
   * The live hand, for a move by someone dealt into it. Someone without a seat
   * is refused first, with the same answer whatever the live hand is doing: a
   * spectator may watch the table running behind, and "no hand is being played"
   * against "you are not in this hand" would tell them, as it happens, when
   * each live hand ends.
   */
  private liveHandFor(playerId: PlayerId): HandState {
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('you are not in this hand');
    const hand = this.state.hand;
    if (!hand || hand.phase === 'complete') throw new ActionError('no hand is being played');
    if (this.state.paused) throw new ActionError('the game is paused');
    if (!hand.seats.some((x) => x.seat === seat.seat)) throw new ActionError('you are not in this hand');
    return hand;
  }

  private handLive() {
    return !!this.state.hand && this.state.hand.phase !== 'complete';
  }

  /** In the live hand with cards (not folded out of it). */
  private inHand(playerId: PlayerId) {
    const seat = this.seatOf(playerId);
    if (!seat || !this.handLive()) return false;
    return this.state.hand!.seats.some((x) => x.seat === seat.seat);
  }

  /**
   * A cash player leaving (or removed) mid-hand folds, unless they are all in
   * or the betting is over (the run-it-twice vote): their chips are already in
   * the pot and they have no more decisions to make, so
   * the hand plays out for them and they go when it ends (a run-it-twice vote
   * counts as once).
   */
  private leaveHand(playerId: PlayerId) {
    const seat = this.seatOf(playerId);
    const hand = this.state.hand;
    const hs = seat && hand ? hand.seats.find((x) => x.seat === seat.seat) : undefined;
    // Someone who called an all-in with chips behind has nothing left to decide during the vote either.
    if (!hand || !hs || hs.folded || !(hs.allIn || hand.phase === 'rit-vote')) return this.foldIfLive(playerId);
    if (hand.phase === 'rit-vote' && hs.ritVote === null) {
      engine.voteRunItTwice(hand, hs.seat, false);
      this.afterEngine(false);
    }
  }

  private foldIfLive(playerId: PlayerId) {
    const seat = this.seatOf(playerId);
    const hand = this.state.hand;
    if (!seat || !hand || hand.phase === 'complete') return;
    engine.foldOutOfTurn(hand, seat.seat);
    this.afterEngine(false);
  }

  /** The player turns their time bank on: it is added to their clock now and spent only past the normal time. */
  useTimeBank(playerId: PlayerId, sentFor: TurnKey = {}) {
    this.checkTurn(playerId, sentFor, "Your time bank wasn't started: the turn it was for is over.");
    const hand = this.liveHandFor(playerId);
    const seat = this.seatOf(playerId)!;
    const turn = this.state.turn;
    if (!turn || hand.toAct !== seat.seat || turn.seat !== seat.seat) throw new ActionError('not your turn');
    if (turn.deadline === null) throw new ActionError('there is no clock at this table');
    if (turn.usingBank) return;
    if (seat.timeBank <= 0) throw new ActionError('your time bank is empty');
    turn.usingBank = true;
    turn.bankFrom = turn.deadline;
    turn.deadline += seat.timeBank * 1000;
    this.sync();
  }

  /**
   * A coach tip for this player's decision now (hand:tip). It is for the one
   * person dealt into a hand against nothing but practice bots, and every
   * check is made again here, so an edited browser gets nothing: the rule as
   * it stood at the deal, the rule as it stands now, the seat, the turn and
   * the exact decision asked about. It changes no state, tells nobody, and
   * never touches the table's randomness, so the hand plays out exactly as it
   * would have. `beforeWork` runs only when a tip is about to be worked out
   * (every check passed, nothing cached), so limits count real work only; it
   * refuses by throwing.
   */
  coachTip(playerId: PlayerId, handNumber: number, at: number, beforeWork: () => void = () => {}): CoachTip {
    const s = this.state;
    if (this.isTournament) throw new ActionError('no tips in tournaments');
    const hand = this.liveHandFor(playerId);
    if (s.coach?.handNumber !== hand.input.handNumber || s.coach.person !== playerId || this.soloPersonOf(hand) !== playerId)
      throw new ActionError('tips are only for hands where everyone else is a bot');
    // By player and by seat: a seat shuffled or taken over since the deal is not this hand's.
    const seat = this.seatOf(playerId)!;
    const hs = hand.seats.find((x) => x.playerId === playerId);
    const turn = s.turn;
    const drawing = hand.phase === 'drawing';
    if (!hs || !turn || hs.seat !== seat.seat || turn.seat !== hs.seat || hand.toAct !== hs.seat || (!drawing && hand.phase !== 'betting')) throw new ActionError('not your turn');
    if (handNumber !== hand.input.handNumber || at !== hand.events.length) throw new ActionError('that turn is over');
    const cached = this.tipCache;
    if (cached?.key === turn.key && cached.playerId === playerId) return cached.tip;
    const legal = drawing ? null : engine.legalActions(hand, hs.seat);
    if (!drawing && !legal) throw new ActionError('not your turn');
    beforeWork();
    const started = performance.now();
    const tip = buildCoachTip(seenBy(hand, hs.seat), hs.seat, {
      legal,
      drawMax: drawing ? (hand.input.game.streets[hand.street]?.drawMaxDiscard ?? 0) : 0,
      // Its own stream, from the turn and the player: the table's randomness is for the deal and the bots.
      rand: seededRand(hashKey(`${turn.key}|${playerId}`)),
      handNumber,
      at,
    });
    const spent = performance.now() - started;
    if (spent > TIP_SLOW_MS && !this.tipSlowLogged) {
      this.tipSlowLogged = true;
      this.logError(`table ${s.id}: a coach tip took ${Math.round(spent)} ms`);
    }
    this.tipCache = { key: turn.key, playerId, tip };
    return tip;
  }

  /** Anyone at the table may peek at the cards a hand that ended early would have dealt. Only they see them. */
  rabbitHunt(playerId: PlayerId) {
    const s = this.state;
    const hand = s.hand;
    if (!hand || hand.phase !== 'complete') throw new ActionError('you can rabbit hunt once the hand is over');
    if (!rabbitCards(hand, s.settings.play.rabbitHunt)) throw new ActionError('there are no cards to rabbit hunt');
    const r = s.rabbit && s.rabbit.handNumber === hand.input.handNumber ? s.rabbit : (s.rabbit = { handNumber: hand.input.handNumber, playerIds: [] });
    if (r.playerIds.includes(playerId)) return;
    r.playerIds.push(playerId);
    this.onChange();
  }

  /** The time bank pays for whatever time was used past the normal clock. */
  private spendBank(seat: SeatState) {
    const turn = this.state.turn;
    if (!turn || turn.seat !== seat.seat || !turn.usingBank || turn.bankFrom === null) return;
    // Acting before a bank turned on early has started costs nothing.
    const used = Math.max(0, Math.ceil((this.clock.now() - turn.bankFrom) / 1000));
    seat.timeBank = Math.max(0, seat.timeBank - used);
  }

  /** After any engine call: finish the hand or restart the turn clock. */
  private afterEngine(notify = true) {
    const hand = this.state.hand;
    if (hand?.phase === 'complete' && this.state.handStartedAt !== null) this.finishHand();
    if (notify) this.sync();
  }

  // ---------------------------------------------------------------- between hands

  /** Everyone who could be dealt in: seated, not sitting out, with chips. */
  private activePlayers() {
    return this.state.seats.filter((s): s is SeatState => !!s && !s.sittingOut && s.stack > 0);
  }

  private finishHand() {
    const s = this.state;
    const hand = s.hand!;
    const now = this.clock.now();
    this.autoShowBounty(hand);
    // The bots' reasons go with the hand they explain. s.coach stays until the next deal, so the view keeps the flag
    // that shows the button for them.
    const coach = s.coach?.handNumber === hand.input.handNumber ? { person: s.coach.person, notes: [...s.coach.notes] } : undefined;
    const record: HandRecord = { handNumber: s.handNumber, startedAt: s.handStartedAt!, endedAt: now, hand, ...(coach ? { coach } : {}) };
    s.history.push(record);
    if (s.history.length > HISTORY_LIMIT) s.history.splice(0, s.history.length - HISTORY_LIMIT);
    if (realGameHand(hand.seats, (id) => !!this.botBadge(id))) s.realGame = true;
    s.handStartedAt = null;
    s.turn = null;
    s.ritDeadline = null;

    for (const hs of hand.seats) {
      const seat = s.seats[hs.seat];
      if (seat && seat.playerId === hs.playerId) seat.stack = hs.stack;
    }

    this.queuedChipsLand();
    if (!this.isTournament) this.settleSideGames(hand);
    const report = this.tournament ? handReport(record, s.seats) : null;
    this.leaversGo();

    this.onHandFinished(record);
    if (this.tournament && report) this.tournament.handEnded(report);

    // An all-in runout is shown a street at a time (runoutMs), so the next hand waits for it too.
    this.afterHand(now, (hand.showdown ? s.settings.timing.showdownSeconds : s.settings.timing.nextHandDelaySeconds) * 1000 + runoutMs(hand.events));
  }

  /**
   * Cash, after a crash: the table was saved while hand `past` was being played, and the hand was saved as
   * finished before the server went down (a table is saved up to half a second after it changes; a hand at
   * once). Closes the hand with its saved result instead of playing it again (issue #224): every stack is
   * as the hand left it, then queued chips, leavers, busted players and the next deal go on as after any
   * hand. Its house fee joins the fee total and its 7-2 bounties are logged, as after any hand. The hand
   * itself isn't kept to show again here (its history has it), and a Nit round isn't settled from it. False, changing nothing, when `past` is not the hand saved in progress. Call before resume().
   */
  closeSavedHand(past: PastHand): boolean {
    const s = this.state;
    const hand = s.hand;
    if (this.isTournament || !hand || !this.handLive() || past.handNumber !== s.handNumber) return false;
    if (past.handId && hand.input.handId && past.handId !== hand.input.handId) return false;
    // Stacks at the end of the hand, then whatever a show after it moved (as the replayer reads them).
    let end: Record<number, number> | null = null;
    for (const e of past.events) {
      if (e.t === 'hand-end') end = { ...e.stacks };
      else if (e.t === 'transfer' && end) {
        if (e.from !== 'house' && end[e.from] !== undefined) end[e.from] -= e.amount;
        if (e.to !== 'house' && end[e.to] !== undefined) end[e.to] += e.amount;
      }
    }
    if (!end) return false;
    for (const x of past.seats) {
      const seat = s.seats[x.seat];
      if (seat && seat.playerId === x.playerId && end[x.seat] !== undefined) seat.stack = end[x.seat];
    }
    for (const key of ['turn', 'next', 'rit', 'bot'] as const) this.clearTimer(key);
    s.hand = null;
    s.handStartedAt = null;
    s.turn = null;
    s.ritDeadline = null;
    if (realGameHand(past.seats, (id) => !!this.botBadge(id))) s.realGame = true;
    this.log(`Hand #${past.handNumber} had already ended when the server stopped, so it was closed with its saved result`);
    this.queuedChipsLand();
    this.feeAndBounty(past);
    this.leaversGo();
    this.afterHand(this.clock.now(), s.settings.timing.nextHandDelaySeconds * 1000);
    return true;
  }

  /** After a hand: queued chips and stack edits land, and time banks refill. */
  private queuedChipsLand() {
    const s = this.state;
    for (const seat of s.seats) {
      if (!seat) continue;
      if (seat.pendingStack !== null) {
        this.ledgerEdit(seat.playerId, seat.pendingStack - seat.stack);
        seat.stack = seat.pendingStack;
        seat.pendingStack = null;
        if (seat.stack > 0 && seat.sitOutReason === 'busted') {
          seat.sittingOut = false;
          seat.sitOutReason = null;
        }
      }
      if (seat.pendingChips) {
        seat.stack += seat.pendingChips;
        seat.pendingChips = 0;
      }
      seat.handsSinceRefill++;
      const refill = s.settings.timing.timeBankRefillHands;
      if (refill > 0 && seat.handsSinceRefill >= refill) {
        seat.timeBank = s.settings.timing.timeBankSeconds;
        seat.handsSinceRefill = 0;
      }
    }
  }

  /** After a hand: leavers go, and busted players sit out (a bot buys back in). */
  private leaversGo() {
    const s = this.state;
    for (const seat of s.seats) {
      if (!seat) continue;
      if (seat.leaveAfterHand) {
        if (this.isTournament) s.seats[seat.seat] = null;
        else this.removeSeat(seat);
      } else if (seat.stack === 0 && !this.isTournament) {
        if (this.isBot(seat.playerId)) this.botBusted(seat);
        else {
          seat.sittingOut = true;
          seat.sitOutReason = 'busted';
        }
      }
    }
  }

  /** After a hand: a stop asked for during it takes effect, or the next deal is set `delayMs` after `now`. */
  private afterHand(now: number, delayMs: number) {
    const s = this.state;
    if (s.stopAfterHand) {
      s.started = false;
      s.stopAfterHand = false;
      this.revealHands();
    }
    // The director hears the result at once, so a hand that ended the event (or one ending after it was cancelled) is the last.
    const auto = this.isTournament ? !this.tournament?.over?.() : s.settings.timing.autoStartNextHand;
    s.nextHandAt = s.started && auto ? now + delayMs : null;
  }

  /** 7-2 bounty with auto-show: turn up a winning 7-2 nobody saw, which pays the bounty before stacks are read. */
  private autoShowBounty(hand: HandState) {
    const active = hand.input.modifiers.find((m) => m.id === bounty72Schema.id);
    if (!active) return;
    const cfg = active.settings as ReturnType<typeof bounty72Schema.get>;
    if (!cfg.autoShow) return;
    for (const seat of sevenDeuceWinners(hand, cfg, false)) engine.show(hand, seat, [0, 1]);
  }

  /** The between-hands pipeline. Returns false when no hand could start. */
  private deal(): boolean {
    if (!this.isTournament) return this.dealHand();
    // A tournament table never stops: it holds, and a later level or poke deals.
    try {
      const dealt = this.dealHand();
      if (dealt) this.dealFailure = null;
      return dealt;
    } catch (e) {
      this.dealFailed(e);
      return false;
    }
  }

  private dealFailed(e: unknown) {
    const why = e instanceof Error ? e.message : String(e);
    if (why === this.dealFailure) return;
    this.dealFailure = why;
    // An ActionError's reason is for players; anything else (a bad level, a bug) is for the server log.
    if (e instanceof ActionError) this.log(`Couldn't deal: ${why}`);
    else {
      this.log("Couldn't deal: this level cannot be dealt");
      this.logError(`table ${this.state.id}: dealing failed`, e);
    }
  }

  private dealHand(): boolean {
    const s = this.state;
    const now = this.clock.now();
    s.nextHandAt = null;
    this.applyPendingSettings();
    if (s.paused) return false;
    // Tournament tables also wait for their director (start time, breaks, hand-for-hand).
    if (!s.started) return false;
    if (this.tournament && this.tournament.gate(now) !== 'deal') return false;

    // Busted players can't be dealt in; nor can anyone sitting out (cash).
    for (const seat of s.seats) {
      // A bot with no chips buys back in, even one already marked busted.
      if (seat && seat.stack === 0 && !this.isTournament && this.isBot(seat.playerId)) {
        this.botBusted(seat);
        continue;
      }
      if (seat && seat.stack === 0 && !this.isTournament && !seat.sittingOut) {
        seat.sittingOut = true;
        seat.sitOutReason = 'busted';
      }
    }
    const offline = (seat: SeatState) => !this.isOnline(seat.playerId);
    const candidates = s.seats.filter((x): x is SeatState => {
      if (!x || x.stack <= 0) return false;
      if (this.isTournament) return true;
      if (x.sittingOut) return false;
      // Offline players are sat out unless the table deals to away players.
      if (offline(x) && !s.settings.seating.dealToAway && this.offlineFor(x) > s.settings.seating.offlineGraceSeconds * 1000) return false;
      return true;
    });
    if (candidates.length < 2) return false;
    // Bots don't play on by themselves at a cash table: someone has to be there.
    const here = (x: SeatState) => !this.isBot(x.playerId) && !(offline(x) && this.offlineFor(x) > s.settings.seating.offlineGraceSeconds * 1000);
    if (!this.isTournament && candidates.some((x) => this.isBot(x.playerId)) && !candidates.some(here)) return false;
    // Nobody has played yet (or a game is restarting): deal everyone in free.
    if (candidates.filter((x) => !x.isNew).length < 2) for (const x of candidates) x.isNew = false;

    const plannerSeats: PlannerSeat[] = candidates.map((x) => ({
      seat: x.seat,
      playerId: x.playerId,
      stack: x.stack,
      isNew: x.isNew,
      missedSmallBlind: x.missedSmallBlind,
      missedBigBlind: x.missedBigBlind,
      waitForBigBlind: x.waitForBigBlind,
      straddle: x.straddle,
    }));
    const maxSeats = s.seats.length;
    const firstButton = candidates[this.rng(candidates.length)].seat;
    const planFor = (setup: HandSetup, bombPot: { amount: number } | null = null) =>
      planForcedBets({
        game: setup.game,
        stakes: setup.stakes,
        maxSeats,
        seats: plannerSeats,
        lastBigBlindSeat: s.positions?.bigBlind ?? null,
        lastSmallBlindSeat: s.positions?.smallBlind ?? null,
        lastButton: s.positions?.button ?? firstButton,
        mode: this.isTournament ? 'tournament' : 'cash',
        straddles: this.isTournament ? 'off' : s.settings.play.straddle,
        bombPot,
      });
    let setup = this.handSetup();
    let plan = planFor(setup);
    if (plan.dealtIn.length < 2) return false;
    // Mixed games: the step may end with this hand's button (orbits), which changes the game.
    if (this.rotationStepDone(plan.button)) {
      setup = this.handSetup();
      plan = planFor(setup);
      if (plan.dealtIn.length < 2) return false;
    }
    const sideGames = this.sideGames();
    let bombPot = false;
    if (!this.isTournament) {
      const cfg = bombPotSchema.get(s.settings);
      if (bombPotDue(cfg, { handsSince: sideGames.handsSinceBombPot, requested: sideGames.bombPotNext, rng: this.rng })) {
        const bomb = this.bombPotSetup(setup, cfg.gameId, cfg.betting);
        const bombPlan = bomb && planFor(bomb, { amount: cfg.bigBlinds * bomb.stakes.bigBlind });
        if (bomb && bombPlan && bombPlan.dealtIn.length >= 2 && bombPlan.dealtIn.length <= bomb.game.maxPlayers) {
          setup = bomb;
          plan = bombPlan;
          bombPot = true;
        } else if (sideGames.bombPotNext) {
          this.log("Couldn't deal a bomb pot: it needs a game with a flop and blinds");
        }
      }
    }

    // Players sitting out whom the blinds passed now owe them.
    // A bomb pot takes no blinds, so nobody misses one, and debts stay owed until a normal hand.
    // The blind positions still move on one seat, as after any hand.
    if (!this.isTournament && s.positions && !bombPot) {
      const sittingOut = s.seats.filter((x): x is SeatState => !!x && !plan.dealtIn.includes(x.seat) && !plan.waiting.includes(x.seat)).map((x) => x.seat);
      const passed = blindsPassed(plan, s.positions.bigBlind, sittingOut, maxSeats);
      for (const seat of passed.missedBig) s.seats[seat]!.missedBigBlind = true;
      for (const seat of passed.missedSmall) s.seats[seat]!.missedSmallBlind = true;
    }
    for (const seatNo of bombPot ? [] : plan.dealtIn) {
      const seat = s.seats[seatNo]!;
      seat.isNew = false;
      seat.missedBigBlind = false;
      seat.missedSmallBlind = false;
    }
    if (s.settings.game.rotation.enabled) s.rotation.hands++;

    const dealt = new Set(plan.dealtIn);
    const fair = this.fairDeal(candidates.filter((x) => dealt.has(x.seat)).map((x) => x.playerId));
    let input: HandInput = {
      handId: `${s.id}-${s.handNumber + 1}`,
      handNumber: s.handNumber + 1,
      game: setup.game,
      betting: setup.betting,
      stakes: setup.stakes,
      maxSeats,
      seats: candidates
        .filter((x) => dealt.has(x.seat))
        .map((x) => ({ seat: x.seat, playerId: x.playerId, stack: x.stack, away: x.sittingOut || (offline(x) && this.offlineFor(x) > s.settings.seating.offlineGraceSeconds * 1000) })),
      button: plan.button,
      buttonDead: plan.buttonDead,
      posts: plan.posts,
      deck: deckFromSeed(fair.handSeed),
      // Only hands dealt before `fair` use this.
      reshuffleSeed: 0,
      fair,
      options: {
        boards: 1,
        bombPot,
        runItTwice: this.isTournament ? 'off' : s.settings.play.runItTwice,
        showdown: s.settings.play.revealAllAtShowdown ? 'show-all' : 'muck-losers',
        fixedLimitCap: s.settings.play.fixedLimitCap,
        uncappedHeadsUp: s.settings.play.uncappedHeadsUp,
        trimExcessBets: s.settings.play.trimExcessBets,
      },
      modifiers: this.isTournament ? [] : enabledModifiers(s.settings),
    };
    for (const m of input.modifiers) {
      const mod = modifierRegistry.get(m.id);
      if (mod?.beforeHand) input = mod.beforeHand(input, m.settings, this.rng);
    }

    let hand: HandState;
    try {
      hand = engine.startHand(input);
    } catch (e) {
      // A setting that can't be dealt (e.g. too many players for the deck): tell the table and stop.
      // Tournament tables hold instead (see deal()).
      if (e instanceof ActionError && !this.isTournament) {
        this.log(`Couldn't deal: ${e.message}`);
        s.started = false;
        return false;
      }
      throw e;
    }
    s.handNumber = input.handNumber;
    s.hand = hand;
    // Two people dealt in, counted by who is really a bot (a person's id may start with 'bot-'), and at the deal, so a
    // hand that never finishes still counts: tips are off here for good.
    if (hand.seats.filter((x) => !this.isBot(x.playerId)).length >= 2) s.realGame = true;
    // Coach tips and the bots' reasons are settled here, for this hand only, from who was dealt in.
    const person = this.soloPersonOf(hand);
    s.coach = person ? { handNumber: input.handNumber, person, notes: [] } : null;
    this.tipCache = null;
    this.fairDealt();
    s.handNames ??= {};
    for (const x of hand.seats) {
      const seat = s.seats[x.seat];
      if (seat?.playerId === x.playerId) s.handNames[x.playerId] = seat.name;
    }
    if (!this.isTournament) {
      sideGames.bombPotNext = false;
      sideGames.handsSinceBombPot = bombPot ? 0 : sideGames.handsSinceBombPot + 1;
      this.maybeStartNitRound(plan.dealtIn, setup.stakes.bigBlind);
    }
    s.handStartedAt = now;
    s.positions = { button: plan.button, smallBlind: plan.smallBlindSeat, bigBlind: plan.bigBlindSeat };
    if (s.settings.blindSchedule.enabled) {
      s.level.hands++;
      if (s.level.runningSince === null) s.level.runningSince = now;
    }
    this.tournament?.handStarted(s.handNumber);
    if (hand.phase === 'complete') this.finishHand();
    return true;
  }

  /** The game a bomb pot is dealt in: the table's, or the bomb pot game. Null when it can't be a bomb pot. */
  private bombPotSetup(setup: HandSetup, gameId: string, betting: BettingKind): HandSetup | null {
    let next = setup;
    if (gameId) {
      try {
        next = { ...setup, game: variants.get(gameId).spec, betting };
      } catch {
        return null;
      }
    }
    if (next.game.family !== 'flop' || next.game.forcedBets !== 'blinds' || next.stakes.bigBlind < 1) return null;
    return next;
  }

  private offlineFor(seat: SeatState) {
    const since = this.offlineSince.get(seat.playerId);
    if (since !== undefined) return this.clock.now() - since;
    return this.isOnline(seat.playerId) ? 0 : this.clock.now() - this.upSince;
  }

  /** Game, betting and stakes for the next hand: tournament level, rotation step or table settings, with the blind schedule. */
  handSetup(): HandSetup {
    const settings = this.state.settings;
    if (this.tournament) {
      const level = this.tournament.level();
      const game = variants.get(level.gameId).spec;
      return { game, betting: level.betting ?? game.defaultBetting, stakes: fillStakes(level.stakes, game) };
    }
    let gameId = settings.game.gameId;
    let betting: BettingKind = settings.game.betting;
    const rotation = settings.game.rotation;
    if (rotation.enabled && rotation.steps.length) {
      const step = rotation.steps[this.state.rotation.step % rotation.steps.length];
      gameId = step.gameId;
      betting = step.betting;
    }
    const game = variants.get(gameId).spec;
    const { centsMode: _cents, ...base } = settings.stakes;
    const stakes: Stakes = { ...base };
    if (settings.blindSchedule.enabled && settings.blindSchedule.levels.length) {
      const level = settings.blindSchedule.levels[this.currentLevelIndex()];
      stakes.smallBlind = level.smallBlind;
      stakes.bigBlind = level.bigBlind;
      stakes.ante = level.ante;
    }
    return { game, betting, stakes: fillStakes(stakes, game) };
  }

  /** Blind schedule: moves up a level when its time or hand count is used up. */
  private currentLevelIndex() {
    const s = this.state;
    const sched = s.settings.blindSchedule;
    const now = this.clock.now();
    for (;;) {
      const level = sched.levels[s.level.index];
      if (!level || s.level.index >= sched.levels.length - 1) break;
      const elapsed = s.level.elapsedMs + (s.level.runningSince !== null ? now - s.level.runningSince : 0);
      const done = sched.countdown === 'hands' ? s.level.hands >= level.hands : elapsed >= level.minutes * 60_000;
      if (!done) break;
      s.level = { index: s.level.index + 1, elapsedMs: sched.countdown === 'hands' ? 0 : elapsed - level.minutes * 60_000, runningSince: s.level.runningSince !== null ? now : null, hands: 0 };
      this.log(`Blinds are now ${this.money(sched.levels[s.level.index].smallBlind)}/${this.money(sched.levels[s.level.index].bigBlind)}`);
    }
    return Math.min(s.level.index, sched.levels.length - 1);
  }

  /**
   * Mixed games: counts orbits (the button reaching the seat where the step
   * began) and moves to the next step once this one has had its hands or
   * orbits. True when the step changed.
   */
  private rotationStepDone(button: number): boolean {
    const s = this.state;
    const rot = s.settings.game.rotation;
    if (!rot.enabled || !rot.steps.length) return false;
    const r = s.rotation;
    const prev = s.positions?.button ?? null;
    if (r.anchor === null) r.anchor = button;
    else if (prev !== null && prev !== button) {
      const n = s.seats.length;
      const d = (from: number, to: number) => (to - from + n) % n;
      if (d(prev, r.anchor) > 0 && d(prev, r.anchor) <= d(prev, button)) r.orbits++;
    }
    const step = rot.steps[r.step % rot.steps.length];
    const done = step.unit === 'hands' ? r.hands >= step.length : r.orbits >= step.length;
    if (!done) return false;
    r.step = (r.step + 1) % rot.steps.length;
    r.hands = 0;
    r.orbits = 0;
    r.anchor = button;
    this.log(`Switching to ${gameTitle(rot.steps[r.step].gameId, rot.steps[r.step].betting)}`);
    return true;
  }

  // ---------------------------------------------------------------- clocks

  /**
   * Brings timers in line with the state, runs anything already due, and
   * tells listeners. Every public mutation ends here.
   */
  private sync() {
    this.upkeep();
    for (let guard = 0; guard < 20; guard++) {
      if (!this.step()) break;
    }
    // A hand that just ended may have freed seats.
    this.upkeep();
    this.armTimers();
    this.onChange();
  }

  /** Does one due thing. True if something changed and another pass is needed. */
  private step(): boolean {
    const s = this.state;
    if (s.paused || this.tournament?.busy()) return false;
    const now = this.clock.now();
    const hand = s.hand;
    // A vote clock with no vote left to run (the hand ended while the game was paused) would fire forever.
    if (s.ritDeadline !== null && hand?.phase !== 'rit-vote') s.ritDeadline = null;
    if (hand && hand.phase !== 'complete') {
      if (hand.phase === 'rit-vote') {
        // Nobody is to act during the vote. The last actor's turn clock would run out mid-vote and fire forever.
        s.turn = null;
        // Bots always say yes to running it twice.
        const botVoter = hand.seats.find((x) => !x.folded && x.ritVote === null && this.isBot(x.playerId));
        if (botVoter) {
          const seq = hand.events.length;
          engine.voteRunItTwice(hand, botVoter.seat, true);
          const level = this.botInfo(botVoter.playerId)?.level ?? 'normal';
          this.addNote(hand, () => plainNote(seq, botVoter.seat, level, 'rit-yes'));
          this.afterEngine(false);
          return true;
        }
        if (s.ritDeadline === null) s.ritDeadline = now + RIT_VOTE_SECONDS * 1000;
        if (now >= s.ritDeadline) {
          for (const x of hand.seats) if (!x.folded && x.ritVote === null && hand.phase === 'rit-vote') engine.voteRunItTwice(hand, x.seat, false);
          s.ritDeadline = null;
          this.afterEngine(false);
          return true;
        }
        return false;
      }
      s.ritDeadline = null;
      const toAct = hand.toAct;
      if (toAct === null) {
        s.turn = null;
        return false;
      }
      const key = `${hand.input.handId}:${hand.events.length}`;
      if (!s.turn || s.turn.key !== key) s.turn = this.newTurn(key, toAct);
      const due = this.botDue();
      if (due !== null && now >= due) {
        this.botMove(toAct);
        return true;
      }
      const deadline = this.turnDeadline();
      if (deadline !== null && now >= deadline) {
        const seat = s.seats[toAct];
        // Out of normal time: the time bank takes over if there is any.
        if (seat && !s.turn.usingBank && s.turn.deadline !== null && seat.timeBank > 0 && s.settings.timing.autoActivateTimeBank && this.isOnline(seat.playerId) && !seat.sittingOut) {
          s.turn.usingBank = true;
          s.turn.bankFrom = s.turn.deadline;
          s.turn.deadline += seat.timeBank * 1000;
          return true;
        }
        this.timeOut(toAct);
        return true;
      }
      return false;
    }
    // Browsers warn about a hand dealt too soon after its commitment appeared, or without a seed they sent
    // (docs/FAIRNESS.md).
    const ready = this.fairReadyAt();
    // Put back for a seed that has since come in, or for a player who has gone: deal as soon as allowed.
    if (this.seedWait && s.nextHandAt !== null && ready < s.nextHandAt) {
      s.nextHandAt = Math.max(ready, now);
      this.seedWait = false;
    }
    if (s.nextHandAt !== null && now >= s.nextHandAt) {
      if (now < ready) {
        s.nextHandAt = ready;
        this.seedWait = ready > (s.fair?.committedAt ?? 0) + this.fairLeadMs;
      } else {
        this.seedWait = false;
        this.deal();
      }
      return true;
    }
    // Nothing scheduled: a tournament table deals when its gate opens (never once its event is over), a running cash
    // table when enough players are back. A failed attempt leaves things as they were.
    if (s.nextHandAt === null && (!hand || hand.phase === 'complete')) {
      const auto = this.tournament ? !this.tournament.over?.() : s.started && s.settings.timing.autoStartNextHand && !s.stopAfterHand;
      if (auto && now < ready) {
        s.nextHandAt = ready;
        this.seedWait = ready > (s.fair?.committedAt ?? 0) + this.fairLeadMs;
        return true;
      }
      if (auto) {
        this.seedWait = false;
        return this.deal();
      }
    }
    return false;
  }

  /**
   * Cash table housekeeping between and around hands: frees the seats of
   * players offline too long, lets lapsed seat offers go, and holds each
   * free seat for the next waitlisted player who is online.
   */
  private upkeep() {
    if (this.isTournament) return;
    const s = this.state;
    const now = this.clock.now();
    const releaseMs = s.settings.seating.releaseOfflineSeatMinutes * 60_000;
    if (releaseMs > 0 && !s.paused) {
      for (const seat of s.seats) {
        if (!seat || seat.leaveAfterHand || this.isOnline(seat.playerId) || this.offlineFor(seat) < releaseMs) continue;
        this.log(`${seat.name} has been offline for ${s.settings.seating.releaseOfflineSeatMinutes} minutes, so their seat is released`);
        if (this.inHand(seat.playerId)) {
          seat.leaveAfterHand = true;
          seat.released = true;
        } else this.removeSeat(seat);
      }
    }
    if (!s.settings.seating.waitlist) {
      if (s.waitlist?.length) this.log('The waitlist is off; everyone waiting was taken off it');
      s.waitlist = [];
      s.offers = [];
      return;
    }
    for (const o of this.offers().filter((x) => x.expiresAt <= now)) {
      this.log(`${this.queueName(o.playerId)} didn't take seat ${o.seat + 1} in time and left the waitlist`);
      this.leaveQueue(o.playerId);
    }
    // Seats taken some other way (the host moved someone in) are no longer on offer.
    // Nor are seats a smaller table is about to drop.
    const limit = this.seatLimit();
    s.offers = this.offers().filter((o) => !s.seats[o.seat] && o.seat < limit);
    const open = this.openSeats();
    for (const entry of this.queue()) {
      if (!open.length) break;
      if (this.offers().some((o) => o.playerId === entry.playerId) || !this.isOnline(entry.playerId)) continue;
      const seat = open.shift()!;
      this.offers().push({ seat, playerId: entry.playerId, expiresAt: now + SEAT_OFFER_MS });
      this.log(`Seat ${seat + 1} is free: ${entry.name} is next on the waitlist`);
    }
  }

  /** When upkeep next has something to do: an offer running out, or an offline seat to release. */
  private upkeepDue(): number | null {
    if (this.isTournament) return null;
    const s = this.state;
    const times = this.offers().map((o) => o.expiresAt);
    const releaseMs = s.settings.seating.releaseOfflineSeatMinutes * 60_000;
    if (releaseMs > 0 && !s.paused) {
      const now = this.clock.now();
      for (const seat of s.seats) {
        if (seat && !seat.leaveAfterHand && !this.isOnline(seat.playerId)) times.push(now + releaseMs - this.offlineFor(seat));
      }
    }
    return times.length ? Math.min(...times) : null;
  }

  private newTurn(key: string, seatNo: number) {
    const now = this.clock.now();
    const clock = this.state.settings.timing.decisionSeconds;
    return { key, seat: seatNo, startedAt: now, deadline: clock > 0 ? now + clock * 1000 : null, usingBank: false, bankFrom: null };
  }

  /**
   * When the current turn runs out: the decision clock (plus any time bank),
   * cut short for a player who is offline (a grace period from when they
   * dropped) or sitting out (at once).
   */
  turnDeadline(now = this.clock.now()): number | null {
    const s = this.state;
    const turn = s.turn;
    if (!turn) return null;
    // While paused: when it would run out if play resumed now (see setPaused).
    const shift = this.pausedFor(now);
    const paused = s.paused && s.pausedLeft;
    const deadline = paused && paused.turn !== null && turn.deadline !== null ? now + paused.turn : turn.deadline === null ? null : turn.deadline + shift;
    const startedAt = turn.startedAt + shift;
    const seat = s.seats[turn.seat];
    if (!seat) return deadline;
    if (seat.sittingOut) return startedAt;
    if (!this.isOnline(seat.playerId)) {
      const since = paused ? now : (this.offlineSince.get(seat.playerId) ?? turn.startedAt);
      const graceEnd = Math.max(since, startedAt) + s.settings.seating.offlineGraceSeconds * 1000;
      return deadline === null ? graceEnd : Math.min(deadline, graceEnd);
    }
    return deadline;
  }

  private timeOut(seatNo: number) {
    const s = this.state;
    const hand = s.hand!;
    engine.timeout(hand, seatNo);
    const seat = s.seats[seatNo];
    if (seat) {
      // Charge only the bank time actually used (a bank turned on early may not have started).
      this.spendBank(seat);
      seat.timeouts++;
      const limit = s.settings.seating.awayAfterTimeouts;
      if (limit > 0 && seat.timeouts >= limit && !seat.sittingOut) {
        seat.sittingOut = true;
        seat.sitOutReason = 'timeouts';
        this.log(`${seat.name} is sitting out after running out of time`);
      }
    }
    s.turn = null;
    this.afterEngine(false);
  }

  private armTimers() {
    const s = this.state;
    for (const key of TIMER_KEYS) this.clearTimer(key);
    const now = this.clock.now();
    const at = (key: TimerKey, when: number | null | undefined) => {
      if (when == null) return;
      this.timers[key] = this.clock.setTimeout(() => {
        this.timers[key] = null;
        // A throw out of a timer would take the whole server down; the table holds until its next change.
        try {
          this.sync();
        } catch (e) {
          this.logError(`table ${this.state.id}: ${key} timer failed`, e);
        }
      }, Math.max(0, when - now));
    };
    // Seat offers run out even while the game is paused.
    at('upkeep', this.upkeepDue());
    // A stopped game's hands open for checking: tell the browsers, which fetch them again.
    at('reveal', this.fairStopDue());
    if (s.paused) return;
    at('turn', this.turnDeadline());
    at('bot', this.botDue());
    at('next', s.nextHandAt);
    at('rit', s.ritDeadline);
  }

  private clearTimer(key: TimerKey) {
    if (this.timers[key] !== null) this.clock.clearTimeout(this.timers[key]);
    this.timers[key] = null;
  }

  /** Notes when spectators start or stop seeing every card; only hands dealt from then on are shown to them. */
  private trackSeeAll() {
    const s = this.state;
    const on = spectatorsSeeCards(s.settings);
    if (on && !s.seeAll) s.seeAll = { since: s.handNumber + 1, at: this.clock.now() };
    else if (!on && s.seeAll) s.seeAll = null;
  }

  /** A chat line from the dealer, for things everyone at the table must see. */
  private dealerSays(text: string) {
    this.addChat({ at: this.clock.now(), playerId: null, name: 'Dealer', text });
  }

  private addChat(entry: ChatMessage) {
    this.state.chat.push(entry);
    if (this.state.chat.length > CHAT_LIMIT) this.state.chat.splice(0, this.state.chat.length - CHAT_LIMIT);
    this.onLine({ kind: 'chat', entry: { ...entry } });
  }

  private log(text: string) {
    const entry = { at: this.clock.now(), text };
    this.state.log.push(entry);
    if (this.state.log.length > LOG_LIMIT) this.state.log.splice(0, this.state.log.length - LOG_LIMIT);
    this.onLine({ kind: 'log', entry: { ...entry } });
  }
}

const TIMER_KEYS = ['turn', 'next', 'rit', 'upkeep', 'bot', 'reveal'] as const;
type TimerKey = (typeof TIMER_KEYS)[number];

/** Fills in limit sizes and the bring-in when the settings leave them at 0. */
export function fillStakes(stakes: Stakes, game: GameSpec): Stakes {
  const out = { ...stakes };
  if (out.smallBet <= 0) out.smallBet = Math.max(1, out.bigBlind);
  if (out.bigBet <= 0) out.bigBet = out.smallBet * 2;
  if (game.family === 'stud' && out.bringIn <= 0) out.bringIn = Math.max(1, Math.floor(out.smallBet / 3));
  if (game.forcedBets === 'ante-bring-in' && out.anteType === 'big-blind') out.anteType = 'per-player';
  return out;
}

/**
 * What a tournament table tells the director when a hand ends. The director takes the end stacks as the
 * new stacks, so chips bought during the hand (a rebuy or add-on, already in `seats`) must be in them,
 * and a player they cover is not knocked out. Without `seats`, the hand's own end stacks count.
 */
export function handReport(record: HandRecord, seats: RuntimeState['seats'] | null): Parameters<TournamentHooks['handEnded']>[0] {
  const { hand } = record;
  const startStacks: Record<PlayerId, number> = {};
  const endStacks: Record<PlayerId, number> = {};
  const knockedOutBy: Record<PlayerId, PlayerId[]> = {};
  const potList = engine.pots(hand);
  for (const hs of hand.seats) {
    startStacks[hs.playerId] = hs.startStack;
    const seat = seats?.[hs.seat];
    const end = seat && seat.playerId === hs.playerId ? seat.stack : hs.stack;
    endStacks[hs.playerId] = end;
    if (end > 0) continue;
    // Whoever won a pot the busted player was in knocked them out; a side pot they had no part in does not count.
    // A player who folded their last chips in had no pot to lose, so anyone who won counts.
    const awards = hand.awards.filter((a) => a.seat !== hs.seat);
    const theirs = awards.filter((a) => potList[a.pot]?.eligible.includes(hs.seat));
    const winners = new Set((theirs.length ? theirs : awards).map((a) => a.seat));
    knockedOutBy[hs.playerId] = hand.seats.filter((x) => winners.has(x.seat)).map((x) => x.playerId);
  }
  return { handNumber: record.handNumber, startStacks, endStacks, knockedOutBy, button: hand.input.button };
}

function cleanName(name: string) {
  const clean = cleanDisplayName(name, NAME_MAX);
  if (!clean) throw new ActionError('pick a name');
  return clean;
}

/**
 * Rabbit hunting: the board cards a flop game would have dealt after a hand
 * that ended early, one list per board (empty when it reached the river or
 * the setting is off). Deck order is fixed at the shuffle and nothing is
 * burned, so these are the real next cards.
 */
export function rabbitCards(hand: HandState, enabled: boolean): string[][] | null {
  if (!enabled || hand.phase !== 'complete' || hand.input.game.family !== 'flop' || hand.runs.length !== 1) return null;
  const perBoard = hand.input.game.streets.reduce((n, st) => n + st.dealBoard, 0);
  const missing = perBoard - hand.runs[0][0].length;
  if (missing <= 0) return null;
  const boards = hand.runs[0].map(() => [] as string[]);
  let pos = hand.deckPos;
  // Street by street, each board in turn, the way the hand would have dealt them.
  let have = hand.runs[0][0].length;
  for (const st of hand.input.game.streets) {
    if (!st.dealBoard) continue;
    if (have > 0) {
      have -= st.dealBoard;
      if (have >= 0) continue;
    }
    for (const b of boards) for (let i = 0; i < st.dealBoard; i++) b.push(hand.input.deck[pos++]);
  }
  if (pos > hand.input.deck.length) return null;
  return boards;
}

/** Longest mood, in UTF-16 units: room for one emoji with skin tone and joiners, not a sentence. */
const MOOD_MAX = 16;

/** A mood emoji from a client: emoji only (no letters or digits), short, or null to clear it. */
export function cleanMood(raw: unknown): string | null {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new ActionError('pick an emoji');
  const mood = raw.replace(/\p{Cs}/gu, '').trim();
  if (!mood) return null;
  // Keycaps (1️⃣, #️⃣) are the one place a digit belongs; joiners and variation selectors are the only invisible characters allowed.
  const rest = mood.replace(/[0-9#*]\uFE0F?\u20E3/gu, '🔢');
  const marks = (rest.match(/\p{M}/gu) ?? []).length;
  if (
    mood.length > MOOD_MAX ||
    !/\p{Extended_Pictographic}/u.test(rest) ||
    /[\p{L}\p{N}\p{Cc}\s]/u.test(rest) ||
    /\p{Cf}/u.test(rest.replace(/[\u200D\uFE0F]/g, '')) ||
    marks > 2
  )
    throw new ActionError('pick one emoji');
  return mood;
}
