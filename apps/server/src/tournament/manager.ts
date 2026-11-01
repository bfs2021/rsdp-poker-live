import { createHash, randomBytes } from 'node:crypto';
import { cryptoRng, type Rng } from '@rsdp/engine';
import { ActionError, variants, type PlayerId } from '@rsdp/engine/core';
import { applyAtNextHand, defaultSettings, parseSettings, SETTINGS_LIMITS } from '@rsdp/engine/settings';
import {
  apply,
  autoArchive,
  codeFromWords,
  createTournament,
  isStaffCommand,
  isTournamentStaff,
  lastActivityAt,
  mayCommand,
  DirectorError,
  isArchived,
  isLive,
  levelFor,
  listedPublicly,
  nextOccurrence,
  sortListings,
  tournamentListing,
  nextWakeAt,
  tableAddress,
  tableGate,
  tableRulesOf,
  tick,
  viewFor,
  type Command,
  type DirectorEvent,
  type HandResult,
  type Result,
  seasonBoard,
  type SeasonBoard,
  type SeatInfo,
  type TableId,
  type TournamentListing,
  type TournamentSettings,
  type TournamentState,
  type TournamentView,
  aliveEntries,
} from '@rsdp/tournament';
import { cleanName as cleanDisplayName } from '../names';
import { handReport, TableRuntime } from '../runtime/table';
import type { Clock, HandRecord, RuntimeState, TournamentHooks } from '../runtime/types';

/** Where tournament director state is kept. */
export interface TournamentStore {
  /** Saves a new tournament. False when its id is taken: an existing tournament is never written over. */
  create(state: TournamentState): Promise<boolean>;
  save(state: TournamentState, nextId: string | null): Promise<void>;
  load(id: string): Promise<{ state: TournamentState; nextId: string | null } | null>;
  /** Tournaments that are not finished or cancelled, to resume after a restart. */
  listLive(): Promise<{ state: TournamentState; nextId: string | null }[]>;
  /** Tournaments a player hosted or entered that were still going at `since` (ms), the most recent first. */
  listForPlayer(playerId: PlayerId, since: number): Promise<{ state: TournamentState; nextId: string | null }[]>;
  /** Every tournament in a season. */
  listSeason(seasonId: string): Promise<TournamentState[]>;
  /** Seasons a host's tournaments belong to, newest first. */
  hostSeasons(hostId: PlayerId): Promise<{ id: string; name: string; events: number }[]>;
}

/** The server side of the tables a tournament runs: storage, broadcasting and links. */
export interface TableHost {
  /** Saves a new table before anything else is saved for it. */
  createTable(state: RuntimeState): Promise<void>;
  loadTable(id: string): Promise<RuntimeState | null>;
  /** Starts sending views and saving snapshots for a table. */
  attach(rt: TableRuntime, tournamentId: string, created: Promise<void>): void;
  detach(rt: TableRuntime): void;
}

export interface ManagerDeps {
  clock: Clock;
  store: TournamentStore;
  tables: TableHost;
  /** Push a fresh view to everyone watching this tournament. */
  onState: (id: string) => void;
  /** A player was moved to another table (or seated late). `from` is '' when they had no table. */
  onMoved: (playerId: PlayerId, from: string, to: string) => void;
  /** Director events as they are acted on, with the state after them and (for a browser's command) the state before. */
  onEvents?: (state: TournamentState, before: TournamentState | null, events: DirectorEvent[]) => void;
  log: (message: string, err?: unknown) => void;
  rng?: Rng;
  /** Passed on to the tables (RuntimeDeps.fairLeadMs). */
  fairLeadMs?: number;
}

interface Live {
  state: TournamentState;
  nextId: string | null;
  /** Runtimes by director table id. */
  tables: Map<TableId, TableRuntime>;
  timer: unknown;
  saveTimer: unknown;
  /** Director events are being applied to the tables: none may deal until they all have been. */
  applying: boolean;
  /** Events from a hand start, waiting for that table to finish its step. */
  deferred: DirectorEvent[];
  /** What the tables have reported and the director is yet to act on, by its 0 ms timer. */
  reports: Map<unknown, () => void>;
  /** A restart's replay of missed reports, while it runs; hands it ends report at the back. */
  replay: Command[] | null;
}

/** Commands that come from tables, never from a browser. */
const TABLE_COMMANDS = new Set<Command['type']>(['handStarted', 'handResult']);
const SAVE_DEBOUNCE_MS = 300;
/** Long sleeps are re-armed in steps, so a far-off scheduled start never overflows a timer. */
const MAX_SLEEP_MS = 60 * 60 * 1000;
const NAME_MAX = 20;
/** How often cleanup looks for events to archive or let go of. */
const SWEEP_MS = 60 * 60 * 1000;
/** An event nobody started (manual or Sit & Go) with nothing happening for this long is cancelled and archived. */
export const IDLE_ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** A finished event stays in memory this long, then is loaded again from storage when someone asks for it. */
export const FINISHED_KEEP_MS = 60 * 60 * 1000;
/** How far back the home page lists a player's own tournaments. */
const OWN_LIST_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Hex, so a table address `<tournament>-t<n>` still leads back to its tournament. */
const newTournamentId = () => randomBytes(8).toString('hex');
/** Fresh ids to try before giving up; a taken one is all but impossible. */
const ID_TRIES = 5;
/** The event after this one: its id comes from this one's, so a step replayed after a crash finds the event it made before. */
const nextTournamentId = (id: string) => createHash('sha256').update(`${id}:next`).digest('hex').slice(0, 16);

/** Seconds between tournament hands; keeps director updates ahead of the next deal. */
const TOURNAMENT_NEXT_HAND_SECONDS = 2;

/**
 * Runs tournament directors on the server: applies commands, wakes the
 * director on its schedule (scheduled starts need nobody to press start),
 * and turns its events into table runtimes, seats, moves and eliminations.
 */
export class TournamentManager {
  private readonly live = new Map<string, Live>();
  /** Runtime table id -> tournament id. */
  private readonly tableOwners = new Map<string, string>();
  private readonly clock: Clock;
  /** Shutting down: tables deal no more hands and browsers' commands are refused. */
  private closed = false;
  private sweepTimer: unknown = null;
  /** Final saves of events let go of by cleanup, by id. */
  private readonly evicting = new Map<string, Promise<void>>();

  constructor(private readonly deps: ManagerDeps) {
    this.clock = deps.clock;
  }

  /** Loads every unfinished tournament and its tables, and re-arms their clocks. */
  async resumeAll() {
    for (const saved of await this.deps.store.listLive()) {
      if (this.live.has(saved.state.id)) continue;
      try {
        await this.adopt(saved.state, saved.nextId);
      } catch (e) {
        this.deps.log(`resuming tournament ${saved.state.id} failed`, e);
      }
    }
    this.armSweep();
  }

  /**
   * Cleanup (TRN-54): archives events nobody started that have sat untouched
   * for IDLE_ARCHIVE_MS, and lets go of finished events after FINISHED_KEEP_MS.
   * Scheduled events cancel themselves after their grace period. Results are
   * never deleted.
   */
  sweep() {
    const now = this.clock.now();
    for (const live of [...this.live.values()]) {
      const s = live.state;
      const over = s.status === 'finished' || s.status === 'cancelled';
      if (!over && s.status === 'registering' && s.settings.start.kind !== 'scheduled' && now - lastActivityAt(s) >= IDLE_ARCHIVE_MS) {
        this.dispatchQuietly(live, (st, t) => autoArchive(st, t), 'archiving an idle event');
      } else if (over && now - (s.finishedAt ?? s.createdAt) >= FINISHED_KEEP_MS && !live.reports.size) {
        this.evict(live);
      }
    }
  }

  private armSweep() {
    if (this.closed) return;
    this.clock.clearTimeout(this.sweepTimer);
    this.sweepTimer = this.clock.setTimeout(() => {
      this.sweepTimer = null;
      try {
        this.sweep();
      } catch (e) {
        this.deps.log('tournament cleanup failed', e);
      }
      this.armSweep();
    }, SWEEP_MS);
  }

  /** Saves a finished event and forgets it here; get() loads it again. */
  private evict(live: Live) {
    const id = live.state.id;
    this.clock.clearTimeout(live.timer);
    this.clock.clearTimeout(live.saveTimer);
    live.timer = live.saveTimer = null;
    const saved = this.deps.store
      .save(live.state, live.nextId)
      .catch((e) => this.deps.log(`saving tournament ${id} failed`, e))
      .finally(() => {
        if (this.evicting.get(id) === saved) this.evicting.delete(id);
      });
    this.evicting.set(id, saved);
    for (const rt of live.tables.values()) this.unmount(rt);
    live.tables.clear();
    this.live.delete(id);
  }

  async create(hostId: PlayerId, settings: TournamentSettings): Promise<string> {
    checkGames(settings);
    settings = await this.checkSeason(hostId, settings);
    for (let i = 0; i < ID_TRIES; i++) {
      const state = this.newState(newTournamentId(), hostId, settings);
      // A taken id is never saved over: another one is drawn.
      if (!(await this.deps.store.create(state))) continue;
      await this.adopt(state, null);
      return state.id;
    }
    throw new Error('no free tournament id');
  }

  /** The tournament, loading it from storage if this server has not got it yet. */
  async get(id: string): Promise<Live | null> {
    const live = this.live.get(id);
    if (live) return live;
    // An event let go of a moment ago is read back only once its last save is in.
    await this.evicting.get(id);
    const saved = await this.deps.store.load(id);
    if (!saved) return null;
    return this.live.get(id) ?? this.adopt(saved.state, saved.nextId);
  }

  /** Still to come or under way, and not archived (every such event is in memory). */
  isOpen(id: string): boolean {
    const s = this.live.get(id)?.state;
    return !!s && isLive(s) && !isArchived(s);
  }

  /**
   * How many open events (as in isOpen) this player hosts that they made: the next of a series or Sit & Go,
   * which the server opens for them, doesn't count. Every open event is in memory, after a restart too.
   */
  openHostedBy(playerId: PlayerId): number {
    let n = 0;
    for (const { state: s } of this.live.values()) if (s.hostId === playerId && !s.spawnedFrom && isLive(s) && !isArchived(s)) n++;
    return n;
  }

  /** The id and name of an open event (as in isOpen) this player is still in: registered, seated, or offered a rebuy. */
  enteredIn(playerId: PlayerId): { id: string; name: string } | null {
    for (const { state: s } of this.live.values()) {
      if (isLive(s) && !isArchived(s) && aliveEntries(s).some((e) => e.playerId === playerId)) return { id: s.id, name: s.settings.name };
    }
    return null;
  }

  /** A tournament's state without taking it into memory (link previews): never arms a clock or opens a table. */
  async peek(id: string): Promise<TournamentState | null> {
    return this.live.get(id)?.state ?? (await this.deps.store.load(id))?.state ?? null;
  }

  /**
   * What a browser is sent. The seating seed and the event this one was opened after (which would let anyone walk
   * back through a series) stay on the server, and only the host sees invite codes (no viewer: everything else, for
   * the server's own use).
   */
  view(id: string, viewer?: PlayerId): TournamentView | null {
    const live = this.live.get(id);
    if (!live) return null;
    const { spawnedFrom: _hidden, nextError, ...state } = viewer === undefined ? live.state : viewFor(live.state, viewer);
    return { state: { ...state, rng: 0 }, serverNow: this.clock.now(), nextId: live.nextId, nextError: nextError ?? null };
  }

  /**
   * The home page lists: every upcoming and running event on this server (all of them are in memory), plus the
   * player's own from the last 30 days, which may have finished before the server last started.
   */
  async list(me: PlayerId): Promise<TournamentListing[]> {
    const now = this.clock.now();
    const out = new Map<string, TournamentListing>();
    const involved = (s: TournamentState) => s.hostId === me || s.entries.some((e) => e.playerId === me) || s.requests.some((r) => r.playerId === me);
    for (const l of this.live.values()) {
      // An invite-only event still shows for its host and players.
      if (listedPublicly(l.state) || (isLive(l.state) && !isArchived(l.state) && involved(l.state))) out.set(l.state.id, tournamentListing(l.state, me, now, l.nextId));
    }
    for (const saved of await this.deps.store.listForPlayer(me, now - OWN_LIST_DAYS * DAY_MS)) {
      // The copy in memory is newer than the saved one.
      const l = this.live.get(saved.state.id) ?? saved;
      if (isArchived(l.state)) continue;
      out.set(l.state.id, tournamentListing(l.state, me, now, l.nextId));
    }
    return sortListings([...out.values()]);
  }

  /** A browser's command, with who is acting filled in from the connection. */
  async command(id: string, me: PlayerId, myName: string, raw: Command) {
    const live = await this.get(id);
    if (!live) throw new ActionError('tournament not found');
    if (this.closed) throw new ActionError('the server is restarting');
    const command = this.fromBrowser(live, me, myName, raw);
    this.dispatch(live, (s, now) => apply(s, command, now));
  }

  /** Operator cleanup: every event this server holds, so test events can be picked out by name and players. */
  adminList() {
    return [...this.live.values()].map(({ state: s }) => ({
      id: s.id,
      name: s.settings.name,
      status: s.status,
      archived: !!s.archivedAt,
      createdAt: new Date(s.createdAt).toISOString(),
      players: s.entries.map((e) => e.displayName),
    }));
  }

  /**
   * Operator cleanup: stops an event the way its host would (pause, let the hands in progress
   * finish, end) and archives it, which hides it from every list. Results are kept.
   */
  async adminArchive(id: string, waitMs = 5 * 60_000) {
    const live = await this.get(id);
    if (!live) throw new ActionError('tournament not found');
    const host = live.state.hostId;
    const send = (command: Partial<Command>) => this.command(id, host, '', command as Command);
    if (live.state.status === 'running') await send({ type: 'pause' });
    for (let waited = 0; live.state.status === 'paused' && live.state.tables.some((t) => t.inHand); waited += 500) {
      if (waited >= waitMs) throw new ActionError('a hand is still being played; try again');
      await new Promise((r) => setTimeout(r, 500));
    }
    if (live.state.status === 'paused') await send({ type: 'end' });
    if (!live.state.archivedAt) await send({ type: 'archive' });
    return { id, status: live.state.status, archived: !!live.state.archivedAt };
  }

  /** A season's leaderboard, with live events as they stand now. */
  async season(id: string): Promise<SeasonBoard | null> {
    const saved = await this.deps.store.listSeason(id);
    if (!saved.length) return null;
    const states = saved.map((s) => this.live.get(s.id)?.state ?? s);
    return seasonBoard(id, states);
  }

  hostSeasons(hostId: PlayerId) {
    return this.deps.store.hostSeasons(hostId);
  }

  /** Only a season's host adds events to it; it keeps the name it already has. */
  private async checkSeason(hostId: PlayerId, settings: TournamentSettings): Promise<TournamentSettings> {
    const season = settings?.season;
    if (!season || typeof season !== 'object' || !season.id) return settings;
    const events = await this.deps.store.listSeason(String(season.id));
    if (!events.length) throw new ActionError('that season was not found');
    if (events.some((s) => s.hostId !== hostId)) throw new ActionError('only the host of that season can add events to it');
    const latest = events.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    return { ...settings, season: { id: season.id, name: latest.settings.season!.name } };
  }

  /** The tournament a runtime table belongs to (by its runtime id), if any. */
  tournamentOf(tableId: string) {
    return this.tableOwners.get(tableId) ?? null;
  }

  /** Runtime table ids look like `<tournament>-t<n>`; loads the tournament that owns one. */
  async loadTableOwner(tableId: string) {
    const m = /^([0-9a-f]+)-t\d+$/.exec(tableId);
    if (!m) return null;
    await this.get(m[1]);
    return this.tableOwners.get(tableId) ?? null;
  }

  /** Stops for good (shutdown): the director acts on every hand the tables have reported, no table deals again, and the clocks stop. */
  dispose() {
    this.closed = true;
    for (const live of this.live.values()) {
      // Acting on a report can end another hand (a player out of time), which reports in turn.
      for (let guard = 0; live.reports.size && guard < 100; guard++) {
        const [timer, report] = live.reports.entries().next().value!;
        this.clock.clearTimeout(timer);
        live.reports.delete(timer);
        report();
      }
      this.clock.clearTimeout(live.timer);
      this.clock.clearTimeout(live.saveTimer);
      live.timer = live.saveTimer = null;
    }
    this.clock.clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Saves every tournament now (shutdown). */
  async flush() {
    await Promise.all([...this.live.values()].map((l) => this.deps.store.save(l.state, l.nextId).catch(() => {})));
  }

  // ---------------------------------------------------------------- internals

  private fromBrowser(live: Live, me: PlayerId, myName: string, cmd: Command): Command {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') throw new ActionError('unknown command');
    if (TABLE_COMMANDS.has(cmd.type)) throw new ActionError('unknown command');
    if (isStaffCommand(cmd.type)) {
      const command = { ...cmd, by: me } as Command;
      if (!mayCommand(live.state, me, command)) throw new ActionError(me === live.state.hostId || live.state.coHosts?.some((c) => c.playerId === me) ? 'the host has not given you that power' : 'only the host can do that');
      // The director checks the shape; the games must also be ones this server can deal.
      if (cmd.type === 'editStructure') checkGames({ ...live.state.settings, structure: cmd.structure });
      if (cmd.type === 'updateSettings') checkGames({ ...live.state.settings, ...cmd.settings });
      // Codes come from a secure source, never from the browser or the seating seed.
      if (command.type === 'createInvites') {
        const count = Number.isSafeInteger(command.count) && command.count > 0 && command.count <= 200 ? command.count : 0;
        return { type: 'createInvites', by: me, count: command.count, maxUses: command.maxUses, codes: newCodes(count, live.state) };
      }
      if (command.type === 'transferHost') command.byName = cleanName(myName);
      return command;
    }
    switch (cmd.type) {
      case 'register': {
        const displayName = cleanName(myName || ('displayName' in cmd ? String(cmd.displayName ?? '') : ''));
        if (!displayName) throw new ActionError('pick a name first');
        const code = typeof cmd.code === 'string' ? cmd.code.slice(0, 40) : undefined;
        return { type: 'register', playerId: me, displayName, ...(code ? { code } : {}) };
      }
      case 'checkIn':
      case 'unregister':
      case 'rebuy':
      case 'declineRebuy':
      case 'addOn':
      case 'reEnter':
      case 'quit':
        return { type: cmd.type, playerId: me };
      default:
        throw new ActionError('unknown command');
    }
  }

  private newState(id: string, hostId: PlayerId, settings: TournamentSettings) {
    // The seed for the seat draw: from the rng the tables use when one is given (tests seed it, so a run repeats).
    const seed = this.deps.rng ? this.deps.rng(0x100000000) : randomBytes(4).readUInt32LE(0);
    return this.guard(() => createTournament({ id, hostId, settings, now: this.clock.now(), seed }));
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof DirectorError) throw new ActionError(e.message);
      if (e instanceof ActionError) throw e;
      if (e instanceof TypeError) throw new ActionError('those tournament settings are incomplete');
      throw e;
    }
  }

  /** Runs one director step, then acts on its events. Throws ActionError when the director refuses. */
  private dispatch(live: Live, step: (s: TournamentState, now: number) => Result) {
    const before = live.state;
    const result = this.guard(() => step(live.state, this.clock.now()));
    live.state = result.state;
    this.handle(live, result.events, before);
    this.changed(live);
  }

  /** For calls from tables and timers, where there is nobody to tell about a refusal. */
  private dispatchQuietly(live: Live, step: (s: TournamentState, now: number) => Result, what: string) {
    try {
      this.dispatch(live, step);
    } catch (e) {
      this.deps.log(`tournament ${live.state.id}: ${what} failed`, e);
    }
  }

  private changed(live: Live) {
    this.arm(live);
    this.scheduleSave(live);
    this.deps.onState(live.state.id);
  }

  private scheduleSave(live: Live) {
    if (live.saveTimer) return;
    live.saveTimer = this.clock.setTimeout(() => {
      live.saveTimer = null;
      this.deps.store.save(live.state, live.nextId).catch((e) => this.deps.log(`saving tournament ${live.state.id} failed`, e));
    }, SAVE_DEBOUNCE_MS);
  }

  /** Wakes the director when it next needs to act: start, seating, level changes, offer expiries. */
  private arm(live: Live) {
    this.clock.clearTimeout(live.timer);
    live.timer = null;
    const at = nextWakeAt(live.state);
    if (at === null) return;
    // A setting that is not a number would make a timer that fires at once and re-arms forever.
    if (!Number.isFinite(at)) {
      this.deps.log(`tournament ${live.state.id}: next wake time is ${at}, so its clock is not armed`);
      return;
    }
    const wait = Math.min(Math.max(0, at - this.clock.now()), MAX_SLEEP_MS);
    live.timer = this.clock.setTimeout(() => {
      live.timer = null;
      if (this.clock.now() >= at) this.dispatchQuietly(live, (s, now) => tick(s, now), 'tick');
      else this.arm(live);
    }, wait);
  }

  /** Takes a tournament into memory: its tables come back from their snapshots. */
  private async adopt(state: TournamentState, nextId: string | null): Promise<Live> {
    // Every snapshot loads before anything is mounted, so a failed load leaves nothing half-built to be found later.
    const snapshots = await Promise.all(state.tables.map((t) => this.deps.tables.loadTable(tableAddress(t.id))));
    const already = this.live.get(state.id);
    if (already) return already;
    const live: Live = { state, nextId, tables: new Map(), timer: null, saveTimer: null, applying: false, deferred: [], reports: new Map(), replay: null };
    try {
      state.tables.forEach((t, i) => {
        const saved = snapshots[i];
        if (saved) {
          // The host may have changed after the table was last saved.
          saved.hostId = state.hostId;
          const rt = new TableRuntime(saved, this.runtimeDeps(live, t.id));
          // Before anything below can poke the table (a replayed report, the catch-up tick): nobody could act while
          // the server was down, so the clocks saved with it must not time anyone out.
          rt.restartClocks();
          this.mount(live, t.id, rt, Promise.resolve());
        }
        else {
          // No snapshot yet (the server stopped right after seating): rebuild the seats from the director.
          const seats = t.seats.flatMap((entryId, seat) => {
            const e = entryId ? state.entries.find((x) => x.id === entryId) : undefined;
            return e ? [{ tableId: t.id, seat, entryId: e.id, playerId: e.playerId, displayName: e.displayName, stack: e.stack }] : [];
          });
          this.openTable(live, t.id, seats);
        }
      });
    } catch (e) {
      for (const rt of live.tables.values()) this.unmount(rt);
      throw e;
    }
    this.live.set(state.id, live);
    // The director and its tables are saved on timers of their own, so after a crash either may be behind.
    // Tables hold while they are brought in line, then deal as the director says.
    const missed = missedReports(state, snapshots);
    live.applying = true;
    // A replayed event can end a hand (a player folded out as they leave). Its report goes after every
    // missed one, so it never reaches the director before that hand's own missed start.
    live.replay = missed;
    try {
      for (let i = 0; i < missed.length; i++) {
        const command = missed[i];
        try {
          const result = this.guard(() => apply(live.state, command, this.clock.now()));
          live.state = result.state;
          for (const e of result.events) this.handleQuietly(live, e);
        } catch (e) {
          this.deps.log(`tournament ${state.id}: replaying a hand report failed`, e);
        }
      }
      // Every missed report is in, so a hand that bringing the seats in line ends reports as usual.
      live.replay = null;
      this.alignTables(live);
      this.reconcileSeats(live);
    } finally {
      live.replay = null;
      live.applying = false;
    }
    if (missed.length) this.scheduleSave(live);
    // Catch up on anything that came due while the server was down before any table deals, so a level or
    // break that started in the meantime applies to the first hand.
    const at = nextWakeAt(live.state);
    if (at !== null && at <= this.clock.now()) this.dispatchQuietly(live, (s, now) => tick(s, now), 'catch-up tick');
    else this.arm(live);
    for (const [tableId, rt] of live.tables) {
      try {
        rt.resume();
      } catch (e) {
        this.deps.log(`tournament ${state.id}: resuming table ${tableId} failed`, e);
      }
    }
    return live;
  }

  private runtimeDeps(live: Live, tableId: TableId) {
    // `log`: failures a table catches itself go to the server log too.
    return { clock: this.clock, rng: this.deps.rng ?? cryptoRng, tournament: this.hooks(live, tableId), log: this.deps.log, fairLeadMs: this.deps.fairLeadMs };
  }

  /**
   * What a tournament table asks of the director. The director hears of each deal and result at once, so no
   * command in the meantime works from a stale hand; acting on the events waits for a 0 ms timer, so the table
   * finishes its own step first.
   */
  private hooks(live: Live, tableId: TableId): TournamentHooks {
    const report = (what: string, command: Command) => {
      if (live.replay) {
        live.replay.push(command);
        return;
      }
      try {
        const result = this.guard(() => apply(live.state, command, this.clock.now()));
        live.state = result.state;
        live.deferred.push(...result.events);
      } catch (e) {
        this.deps.log(`tournament ${live.state.id}: ${what} failed`, e);
      }
      this.soon(live, () => {
        this.handle(live, []);
        this.changed(live);
      });
    };
    return {
      busy: () => live.applying,
      over: () => live.state.status === 'finished' || live.state.status === 'cancelled',
      stillPlaying: (playerId) => aliveEntries(live.state).some((e) => e.playerId === playerId),
      isStaff: (playerId) => isTournamentStaff(live.state, playerId),
      // Tables hold while the director's events are still reaching them, so nobody is dealt in at a seat they are leaving.
      gate: (now) => (this.closed || live.applying || live.deferred.length ? 'hold' : tableGate(live.state, tableId, now)),
      level: () => {
        const l = levelFor(live.state, tableId);
        return {
          gameId: l.gameId,
          stakes: { smallBlind: l.sb, bigBlind: l.bb, ante: l.ante, anteType: l.anteType, bringIn: l.bringIn, smallBet: l.smallBet, bigBet: l.bigBet },
        };
      },
      handStarted: (handNumber) => report('hand start', { type: 'handStarted', tableId, handNumber }),
      // A rebuy or add-on taken between the end of a hand and the timer then counts on top of the hand's result.
      handEnded: (r) => report('hand result', { type: 'handResult', result: { ...r, tableId } }),
    };
  }

  /** Acts on a table's report once the table has finished its step; a shutdown acts on it at once. */
  private soon(live: Live, report: () => void) {
    const timer = this.clock.setTimeout(() => {
      live.reports.delete(timer);
      report();
    }, 0);
    live.reports.set(timer, report);
  }

  private mount(live: Live, tableId: TableId, rt: TableRuntime, created: Promise<void>) {
    live.tables.set(tableId, rt);
    this.tableOwners.set(rt.state.id, live.state.id);
    this.deps.tables.attach(rt, live.state.id, created);
  }

  private unmount(rt: TableRuntime) {
    this.tableOwners.delete(rt.state.id);
    this.deps.tables.detach(rt);
    rt.dispose();
  }

  /**
   * After a restart, once missed reports are replayed: a table whose snapshot is behind the director
   * (issue #5) is brought in line instead of replaying a hand the director already closed. A hand the
   * director heard start but the table never saved is closed with no chips changing hands.
   */
  private alignTables(live: Live) {
    for (const t of live.state.tables) {
      const rt = live.tables.get(t.id);
      if (!rt) continue;
      const playingSameHand = rt.handInProgress && rt.state.handNumber === t.lastHandNumber;
      if (playingSameHand && t.inHand) continue;
      const stacksAt = (table: typeof t) =>
        Object.fromEntries(
          table.seats.flatMap((entryId) => {
            const e = entryId ? live.state.entries.find((x) => x.id === entryId) : undefined;
            return e ? [[e.playerId, e.stack] as const] : [];
          }),
        );
      if (t.inHand) {
        const stacks = stacksAt(t);
        try {
          const result = this.guard(() =>
            apply(live.state, { type: 'handResult', result: { tableId: t.id, handNumber: t.lastHandNumber, startStacks: stacks, endStacks: stacks } }, this.clock.now()),
          );
          live.state = result.state;
          for (const e of result.events) this.handleQuietly(live, e);
        } catch (e) {
          this.deps.log(`tournament ${live.state.id}: closing a hand table ${t.id} never saved failed`, e);
        }
      }
      // The director's view of the table after any close above.
      const now = live.state.tables.find((x) => x.id === t.id);
      if (!now) continue;
      const behind = rt.handInProgress || rt.state.handNumber !== now.lastHandNumber;
      try {
        if (behind) this.deps.log(`tournament ${live.state.id}: table ${t.id} was saved behind the director; bringing it in line`);
        rt.alignWithDirector({ handNumber: now.lastHandNumber, button: now.button, stacks: stacksAt(now) });
      } catch (e) {
        this.deps.log(`tournament ${live.state.id}: bringing table ${t.id} in line failed`, e);
      }
    }
  }

  /** After a restart: each table seats exactly the players the director seats there. */
  private reconcileSeats(live: Live) {
    const s = live.state;
    for (const t of s.tables) {
      const rt = live.tables.get(t.id);
      if (!rt) continue;
      const here = new Map(
        t.seats.flatMap((entryId, seat) => {
          const e = entryId ? s.entries.find((x) => x.id === entryId) : undefined;
          return e ? [[e.playerId, { seat, e }] as const] : [];
        }),
      );
      const fix = (what: string, fn: () => void) => {
        try {
          fn();
        } catch (err) {
          this.deps.log(`tournament ${s.id}: ${what} at table ${t.id} failed`, err);
        }
      };
      // Moved on or knocked out after this table was last saved.
      for (const x of [...rt.state.seats]) if (x && !here.has(x.playerId)) fix('unseating a player', () => rt.unseatPlayer(x.playerId));
      // Seated here after this table was last saved.
      for (const [playerId, { seat, e }] of here) {
        if (rt.seatOf(playerId)) continue;
        fix('seating a player', () => {
          rt.placePlayer({ seat, playerId, name: e.displayName, stack: e.stack });
          this.deps.onMoved(playerId, '', rt.state.id);
        });
      }
    }
  }

  private openTable(live: Live, tableId: TableId, seats: SeatInfo[]) {
    const s = live.state;
    const number = s.tables.findIndex((t) => t.id === tableId) + 1;
    const base = defaultSettings('tournament');
    // An event saved before events had their own rules plays by the rules tournament tables had then.
    const rules = tableRulesOf(s.settings);
    const settings = parseSettings(
      applyAtNextHand(base, {
        table: { name: tableName(s.settings.name, number), maxSeats: s.settings.seatsPerTable },
        timing: {
          nextHandDelaySeconds: Math.max(base.timing.nextHandDelaySeconds, TOURNAMENT_NEXT_HAND_SECONDS),
          decisionSeconds: rules.decisionSeconds,
          timeBankSeconds: rules.timeBankSeconds,
          timeBankRefillHands: rules.timeBankRefillHands,
        },
        play: { rabbitHunt: rules.rabbitHunt },
      }).settings,
    );
    const rt = TableRuntime.create({ id: tableAddress(tableId), hostId: s.hostId, settings }, this.runtimeDeps(live, tableId));
    // Seat everyone before the table may deal, so the first hand has them all.
    for (const seat of seats) rt.placePlayer({ seat: seat.seat, playerId: seat.playerId, name: seat.displayName, stack: seat.stack });
    rt.state.started = true;
    const created = this.deps.tables.createTable(rt.state).catch((e) => this.deps.log(`creating table ${rt.state.id} failed`, e));
    this.mount(live, tableId, rt, created);
    return rt;
  }

  private table(live: Live, tableId: TableId | null) {
    return tableId ? live.tables.get(tableId) : undefined;
  }

  private handle(live: Live, events: DirectorEvent[], before: TournamentState | null = null) {
    // Events a hand start left waiting came from an earlier state, so they go first.
    const all = [...live.deferred.splice(0), ...events];
    if (all.length) {
      try {
        this.deps.onEvents?.(live.state, before, all);
      } catch (e) {
        this.deps.log(`tournament ${live.state.id}: reporting events failed`, e);
      }
    }
    live.applying = true;
    try {
      for (const e of all) this.handleQuietly(live, e);
    } finally {
      live.applying = false;
    }
    // Starts, levels, breaks, rebuys and moves all change which tables may deal.
    for (const [tableId, rt] of live.tables) {
      try {
        rt.poke();
      } catch (err) {
        this.deps.log(`tournament ${live.state.id}: dealing at table ${tableId} failed`, err);
      }
    }
  }

  private handleQuietly(live: Live, e: DirectorEvent) {
    try {
      this.handleOne(live, e);
    } catch (err) {
      this.deps.log(`tournament ${live.state.id}: handling ${e.type} failed`, err);
    }
  }

  private handleOne(live: Live, e: DirectorEvent) {
    const name = (playerId: PlayerId) => live.state.entries.find((x) => x.playerId === playerId)?.displayName ?? 'Player';
    // A table saved after this event (replayed after a restart) may already have the player there.
    const place = (rt: TableRuntime, seat: Parameters<TableRuntime['placePlayer']>[0]) => {
      if (rt.seatOf(seat.playerId)?.seat !== seat.seat) rt.placePlayer(seat);
    };
    switch (e.type) {
      case 'tablesCreated':
        for (const t of e.tables) {
          const rt = this.openTable(live, t.tableId, t.seats);
          // The draw: send everyone to their table.
          for (const seat of t.seats) this.deps.onMoved(seat.playerId, '', rt.state.id);
        }
        break;
      case 'tableOpened':
        if (!live.tables.has(e.tableId)) this.openTable(live, e.tableId, []);
        break;
      case 'seatPlayer': {
        const rt = this.table(live, e.seat.tableId) ?? this.openTable(live, e.seat.tableId, []);
        place(rt, { seat: e.seat.seat, playerId: e.seat.playerId, name: e.seat.displayName, stack: e.seat.stack });
        this.deps.onMoved(e.seat.playerId, '', rt.state.id);
        break;
      }
      case 'moveSeat': {
        const from = this.table(live, e.from.tableId);
        const to = this.table(live, e.to.tableId) ?? this.openTable(live, e.to.tableId, []);
        // The mood emoji and what is left of the time bank go with the player.
        const was = from?.seatOf(e.playerId);
        const carried = { mood: was?.mood, timeBank: was ? { seconds: was.timeBank, handsSinceRefill: was.handsSinceRefill } : undefined };
        from?.unseatPlayer(e.playerId);
        place(to, { seat: e.to.seat, playerId: e.playerId, name: name(e.playerId), stack: e.stack, ...carried });
        this.deps.onMoved(e.playerId, tableAddress(e.from.tableId), to.state.id);
        break;
      }
      case 'seatsSwapped': {
        // Both seats are emptied before either is filled, so neither lands on the other.
        const carried = new Map(
          e.moves.map((m) => {
            const was = this.table(live, m.from.tableId)?.seatOf(m.playerId);
            return [m.playerId, { mood: was?.mood, timeBank: was ? { seconds: was.timeBank, handsSinceRefill: was.handsSinceRefill } : undefined }];
          }),
        );
        for (const m of e.moves) this.table(live, m.from.tableId)?.unseatPlayer(m.playerId);
        for (const m of e.moves) {
          const to = this.table(live, m.to.tableId);
          if (!to) continue;
          place(to, { seat: m.to.seat, playerId: m.playerId, name: name(m.playerId), stack: m.stack, ...carried.get(m.playerId) });
          this.deps.onMoved(m.playerId, tableAddress(m.from.tableId), to.state.id);
        }
        break;
      }
      case 'stackSet':
        // A replayed edit is already in the table's snapshot, which may be a hand further on.
        if (e.applied && !live.replay) this.table(live, e.tableId)?.tournamentSetStack(e.playerId, e.stack);
        break;
      case 'hostChanged':
        for (const rt of live.tables.values()) rt.state.hostId = e.hostId;
        break;
      case 'tableBroken': {
        const rt = this.table(live, e.tableId);
        if (rt) {
          live.tables.delete(e.tableId);
          this.deps.tables.detach(rt);
          rt.dispose();
        }
        break;
      }
      case 'stackAdded':
        this.table(live, e.tableId)?.tournamentChips(e.playerId, e.chips);
        break;
      case 'eliminated':
        this.table(live, e.tableId)?.unseatPlayer(e.playerId);
        break;
      case 'scheduleNext':
        this.scheduleNext(live, e.startAt);
        break;
      case 'cancelled':
        // A series goes on after an event nobody came to.
        if (e.reason === 'not-enough-players') this.scheduleNext(live, null);
        break;
      case 'spawnNext':
        this.spawn(live, live.state.settings);
        break;
      case 'settingsUpdated':
        // The host may have fixed what stopped the next event being made: try again.
        if (live.state.nextError !== undefined && !live.nextId) {
          const { start } = live.state.settings;
          if (start.kind === 'sng' && start.autoSpawn) this.spawn(live, live.state.settings);
          else this.scheduleNext(live, null);
        }
        break;
      default:
        break;
    }
  }

  /** The next event of a series. One whose start has passed (the server was down through it) gives way to the next still to come. */
  private scheduleNext(live: Live, startAt: number | null) {
    const start = live.state.settings.start;
    if (start.kind !== 'scheduled' || !start.schedule?.repeat) return;
    const now = this.clock.now();
    const at = startAt !== null && startAt > now ? startAt : nextOccurrence(start.schedule, Math.max(start.startAt, now));
    if (at !== null) this.spawn(live, { ...live.state.settings, start: { ...start, startAt: at } });
  }

  /** The next event of a series, or a fresh Sit & Go. */
  private spawn(live: Live, settings: TournamentSettings) {
    this.openNext(live, settings).catch((e) => {
      this.deps.log(`tournament ${live.state.id}: creating the next one failed`, e);
      // Settings that were fine when this event was made can break a check added since (#266): say why it stopped.
      // Saved with the event, so the lobby still says so after a restart; a fix to the settings tries again.
      live.state = { ...live.state, nextError: e instanceof ActionError ? e.message : 'something went wrong on the server' };
      this.changed(live);
    });
  }

  private async openNext(live: Live, settings: TournamentSettings) {
    checkGames(settings);
    const id = nextTournamentId(live.state.id);
    const state = { ...this.newState(id, live.state.hostId, settings), spawnedFrom: live.state.id };
    // Already saved: it was made before a restart (this event's own save had not happened yet), so that one is next.
    if (await this.deps.store.create(state)) await this.adopt(state, null);
    else if (!(await this.get(id))) throw new Error(`tournament ${id} is saved but could not be loaded`);
    live.nextId = id;
    if (live.state.nextError !== undefined) {
      const { nextError: _fixed, ...state } = live.state;
      live.state = state;
    }
    this.changed(live);
  }
}

/**
 * The hand starts and results a table's snapshot shows that the director's
 * saved state never heard of, in the order they happened.
 */
function missedReports(state: TournamentState, snapshots: (RuntimeState | null)[]): Command[] {
  const missed: { at: number; command: Command }[] = [];
  state.tables.forEach((t, i) => {
    const saved = snapshots[i];
    if (!saved) return;
    const last = saved.history[saved.history.length - 1];
    for (const record of saved.history) {
      if (record.handNumber < t.lastHandNumber || (record.handNumber === t.lastHandNumber && !t.inHand)) continue;
      if (record.handNumber > t.lastHandNumber) missed.push({ at: record.startedAt, command: { type: 'handStarted', tableId: t.id, handNumber: record.handNumber } });
      // For the table's last hand, chips bought during it (an add-on) are in the saved seats.
      const result = handReport(record, record === last ? saved.seats : null);
      missed.push({ at: record.endedAt, command: { type: 'handResult', result: { ...result, tableId: t.id } } });
    }
    // A hand still being played that the director never heard start.
    if (saved.handStartedAt !== null && saved.handNumber > t.lastHandNumber)
      missed.push({ at: saved.handStartedAt, command: { type: 'handStarted', tableId: t.id, handNumber: saved.handNumber } });
  });
  return missed.sort((a, b) => a.at - b.at).map((m) => m.command);
}

/** "<tournament> · Table 3", cut by whole characters to fit the table-name limit, which counts UTF-16 units. */
export function tableName(tournament: string, number: number) {
  const suffix = ` · Table ${number}`;
  const chars = Array.from(cleanDisplayName(tournament, SETTINGS_LIMITS.tableName.max));
  while (chars.length && chars.join('').trim().length + suffix.length > SETTINGS_LIMITS.tableName.max) chars.pop();
  return `${chars.join('').trim()}${suffix}`;
}

/** Every game must exist and seat a full table. */
function checkGames(settings: TournamentSettings) {
  if (!settings || !Array.isArray(settings.games) || !Array.isArray(settings.structure)) throw new ActionError('those tournament settings are incomplete');
  // Any other value would pick a rotation game that is not in the list.
  const stop = settings.stopRotationAtLevel;
  if (stop != null && !(Number.isInteger(stop) && stop >= 1)) throw new ActionError('the rotation must stop at a whole level number');
  // A level's game is only skipped when it is left out: an empty one is still a game nobody can deal.
  const ids = new Set([...settings.games, ...settings.structure.flatMap((r) => (r?.kind === 'level' && r.gameId !== undefined ? [r.gameId] : []))]);
  for (const id of ids) {
    let spec;
    try {
      spec = variants.get(id).spec;
    } catch {
      throw new ActionError(`unknown game ${id}`);
    }
    if (settings.seatsPerTable > spec.maxPlayers) throw new ActionError(`${spec.name} seats at most ${spec.maxPlayers} per table`);
  }
}

/** Fresh invite codes no other code in this tournament has. */
function newCodes(count: number, state: TournamentState): string[] {
  const taken = new Set(state.invites?.map((c) => c.code));
  const out: string[] = [];
  while (out.length < count) {
    const code = codeFromWords(new Uint32Array(randomBytes(32).buffer));
    if (taken.has(code)) continue;
    taken.add(code);
    out.push(code);
  }
  return out;
}

function cleanName(name: string) {
  return cleanDisplayName(name, NAME_MAX);
}
