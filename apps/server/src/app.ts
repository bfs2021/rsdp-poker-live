import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { Server, type Socket } from 'socket.io';
import type { Rng } from '@rsdp/engine';
import { ActionError, type PlayerId } from '@rsdp/engine/core';
import { amountText, applyAtNextHand, defaultSettings, mergePatches, newCashSettings, parseSettings, SettingsError, spectatorsSeeCards } from '@rsdp/engine/settings';
import type { Ack, BotLevel, ClientToServer, ServerToClient, TurnKey } from '@rsdp/engine/wire';
import { isArchived, LOBBY_CHAT_MAX, logEvent, namesIn, type LobbyItem, type TournamentClientToServer, type TournamentServerToClient } from '@rsdp/tournament';
import { hashSecret, IdentityError } from './identity';
import { realGameHand, TableRuntime } from './runtime/table';
import { botIdsOf, systemClock, type ChatMessage, type Clock, type HandRecord, type PastHand, type RuntimeState, type TableLine, type TableLogEntry } from './runtime/types';
import { splitLines, startingLines } from './storage';
import { cleanName } from './names';
import { avatarImage, avatarToken, cleanAvatar, memoryAvatars, type AvatarStore } from './avatars';
import { BOT_LEVELS, GESTURES, SETUPS_PER_KIND, type GestureKind, type SavedSetup, type SetupKind } from '@rsdp/engine/wire';
import { cleanNote, memoryNotes, type NotesStore } from './notes';
import { cleanImportedSetup, cleanKind, cleanSetup, cleanSetupName, freeName, memorySetups, renamed, type SetupStore } from './savedSetups';
import { behind, delayedPart, handRecordView, pastHand, tableView, type DelayedPart } from './runtime/view';
import { TournamentManager, type TournamentStore } from './tournament/manager';
import { memoryTournamentStore } from './tournament/store';
import { tablePreview, tournamentPreview, withPreview } from './preview';
import { LobbyLog, memoryLobbyStore, type LobbyStore } from './tournament/lobby';
import { memorySharedHands, type SharedHandStore } from './shared';
import { memorySuggestions, suggestionRoutes, type SuggestionStore } from './suggestions';
import { newId } from './db/ids';
import { adminGate, limiter, sweepLimiters } from './admin';
import { accountRoutes, type AccountHooks } from './accounts';
import { handSearchRoutes } from './handSearch';
import { googleConfirmations, googleRoutes, type GoogleConfig } from './google';
import type { Db } from './db';
import { dbCause, StorageError } from './db/errors';
import { writeBackup } from './db/backup';
import { AuditLog, auditRoutes, buildFromEnv, memoryAuditStore, type BuildInfo } from './audit';
import { clientErrorRoutes } from './clientErrors';
import { subjectRef } from '@rsdp/engine';

export interface Session {
  playerId: PlayerId;
  displayName: string;
  account: { username: string } | null;
  /** The player's picture as tables show it (see SeatView.avatar). */
  avatar?: string | null;
}

/** Who a browser is. The default derives a player id from the browser secret; the database version adds names and accounts. */
export interface IdentityService {
  /** `session` is the sign-in token the browser keeps, when it has one. */
  resolve(token: string, session?: string): Promise<Session>;
  rename(playerId: PlayerId, name: string): Promise<void>;
}

/** Where tables and finished hands are kept. The default keeps them in memory. */
export interface TableStore {
  /** A new table, before anything else is saved for it, with the log and chat lines it already has. */
  createTable(state: RuntimeState): Promise<void>;
  saveTable(state: RuntimeState): Promise<void>;
  loadTable(id: string): Promise<RuntimeState | null>;
  saveHand(tableId: string, record: HandRecord): Promise<void>;
  /** Every finished hand saved for a table, oldest first. */
  loadHands(tableId: string): Promise<PastHand[]>;
  /** Keeps new log and chat lines for good, after the ones before them. */
  saveLines(tableId: string, lines: TableLine[]): Promise<void>;
  /**
   * Keeps the lines a table already had when it was loaded, unless some are saved for it already: a table
   * saved before every line was kept has its latest ones only in its snapshot, and they would drop off from there.
   */
  keepEarlierLines(tableId: string, lines: TableLine[]): Promise<void>;
  /** Every log and chat line saved for a table, oldest first. */
  loadLines(tableId: string): Promise<{ log: TableLogEntry[]; chat: ChatMessage[] }>;
  /** One finished hand saved for a table, by its number; null when there is none. */
  loadHand(tableId: string, handNumber: number): Promise<PastHand | null>;
  /** Deletes a cash table and its hands for good; false when there was no such table. */
  deleteTable(tableId: string): Promise<boolean>;
  /** Saved cash tables with this player in a seat, asking for one or on the waitlist, as their last saves have it. Optional. */
  tablesSeating?(playerId: PlayerId): Promise<{ id: string; name: string; seated: boolean }[]>;
}

export function memoryIdentity(): IdentityService {
  const names = new Map<PlayerId, string>();
  return {
    async resolve(token) {
      const playerId = createHash('sha256').update(token).digest('base64url').slice(0, 16);
      return { playerId, displayName: names.get(playerId) ?? '', account: null };
    },
    async rename(playerId, name) {
      names.set(playerId, name);
    },
  };
}

export function memoryStore(): TableStore {
  const tables = new Map<string, string>();
  const hands = new Map<string, PastHand[]>();
  const lines = new Map<string, TableLine[]>();
  const save = async (state: RuntimeState) => {
    tables.set(state.id, JSON.stringify(state));
  };
  return {
    async createTable(state) {
      if (tables.has(state.id)) return;
      lines.set(state.id, structuredClone(startingLines(state)));
      await save(state);
    },
    saveTable: save,
    async loadTable(id) {
      const json = tables.get(id);
      return json ? (JSON.parse(json) as RuntimeState) : null;
    },
    async saveHand(tableId, record) {
      const list = hands.get(tableId) ?? [];
      hands.set(tableId, [...list.filter((h) => h.handNumber !== record.handNumber), pastHand(record)]);
    },
    async loadHands(tableId) {
      return [...(hands.get(tableId) ?? [])].sort((a, b) => a.handNumber - b.handNumber);
    },
    async saveLines(tableId, added) {
      lines.set(tableId, [...(lines.get(tableId) ?? []), ...structuredClone(added)]);
    },
    async keepEarlierLines(tableId, earlier) {
      if (!lines.get(tableId)?.length) lines.set(tableId, structuredClone(earlier));
    },
    async loadLines(tableId) {
      return splitLines(structuredClone(lines.get(tableId) ?? []));
    },
    async loadHand(tableId, handNumber) {
      return hands.get(tableId)?.find((h) => h.handNumber === handNumber) ?? null;
    },
    async deleteTable(tableId) {
      hands.delete(tableId);
      lines.delete(tableId);
      return tables.delete(tableId);
    },
  };
}

/**
 * Every saved line, with the table's own recent ones that aren't among them
 * added in time order: lines from before the server kept them all (tables
 * saved earlier), or ones still being saved. Matched whole, so a line said
 * twice is kept twice.
 */
export function withRecent<T extends { at: number }>(saved: T[], recent: T[]): T[] {
  // Keys in one order: a snapshot read back from jsonb has them in another.
  const keyOf = (x: T) => JSON.stringify(x, Object.keys(x).sort());
  const left = new Map<string, number>();
  for (const x of saved) left.set(keyOf(x), (left.get(keyOf(x)) ?? 0) + 1);
  const extra = recent.filter((x) => {
    const key = keyOf(x);
    const n = left.get(key) ?? 0;
    if (n) left.set(key, n - 1);
    return !n;
  });
  return extra.length ? [...saved, ...extra].sort((a, b) => a.at - b.at) : saved;
}

export interface AppDeps {
  clock?: Clock;
  identity?: IdentityService;
  store?: TableStore;
  tournaments?: TournamentStore;
  notes?: NotesStore;
  /** Setups signed-in players saved (table presets, tournament structures). */
  setups?: SetupStore;
  avatars?: AvatarStore;
  lobby?: LobbyStore;
  shared?: SharedHandStore;
  suggestions?: SuggestionStore;
  /** The database that keeps accounts. Without it, sign-up and sign-in answer that accounts are not available. */
  accounts?: Db | null;
  /** Sign in with Google; off when null (production reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET). */
  google?: GoogleConfig | null;
  /** Lets the roadmap admin page change suggestions. Defaults to the ADMIN_KEY environment variable. */
  adminKey?: string;
  /** Deck shuffles; tests pass a seeded one. */
  rng?: Rng;
  /** See RuntimeDeps.fairLeadMs; production passes FAIR_LEAD_MS. */
  fairLeadMs?: number;
  /** See RuntimeDeps.fairStopRevealMs; production leaves it out (FAIR_STOP_REVEAL_MS). */
  fairStopRevealMs?: number;
  /** A cash table nobody has had open for this long is saved and let go from memory (0 keeps every table loaded). */
  idleUnloadMs?: number;
  /** Built web client to serve (production). */
  webDist?: string | null;
  log?: (message: string, err?: unknown) => void;
  /** The public record (audit.ts); defaults to one kept in memory. */
  audit?: AuditLog;
  /** What this server says it was built from; production reads it from the environment. */
  build?: BuildInfo;
  /** Asks the database something trivial, for /api/health's `db` field. Without it the field is left out. */
  checkDb?: () => Promise<unknown>;
}

type C2S = ClientToServer & TournamentClientToServer;
type S2C = ServerToClient & TournamentServerToClient;
type Sock = Socket<C2S, S2C, object, { playerId: PlayerId; session: Session; tableId?: string; tournaments: Set<string>; device: string; lastExport?: number; lastFullLog?: number }>;

/** Least time between two lobby chat messages from one browser tab. */
const LOBBY_CHAT_GAP_MS = 1_000;

/** Least time between two hand downloads from one browser tab. */
const EXPORT_GAP_MS = 5_000;

const SAVE_DEBOUNCE_MS = 500;
/** How long a cash table sits with nobody at it before it is put away (saved, and loaded again when its link is opened). */
const IDLE_UNLOAD_MS = 45 * 60_000;
/** How often the server looks for tables to put away. */
const IDLE_SWEEP_MS = 5 * 60_000;
/** Table chat lines one player may send per window (across all their tabs): a burst could wipe the table's chat. */
const CHAT_BURST = 8;
const CHAT_WINDOW_MS = 10_000;
/** Gestures one player may throw per window (across all their tabs), so nobody floods the table. */
const GESTURE_BURST = 4;
const GESTURE_WINDOW_MS = 10_000;
/** Coach tips one player may ask for per window, across all their tabs. */
const TIP_BURST = 10;
const TIP_WINDOW_MS = 20_000;
/**
 * Time the whole server may spend working out coach tips per window. A tip
 * holds the event loop for up to about 150 ms, so tips tapped at once at
 * several practice tables could otherwise hold up turns at every table.
 */
const TIP_BUDGET_MS = 300;
const TIP_BUDGET_WINDOW_MS = 1_000;
/** Share links one player may make per window. */
const SHARE_BURST = 20;
const SHARE_WINDOW_MS = 60_000;
/** Picture changes one player may make per window. */
const AVATAR_BURST = 4;
const AVATAR_WINDOW_MS = 30_000;
/**
 * Cash tables, and tournaments, one player or one address may make per
 * window. Far more than any host needs, but a script can't fill the server's
 * memory with tables or bury the home page under events that never start.
 */
const TABLES_PER_WINDOW = 20;
const TOURNAMENTS_PER_WINDOW = 10;
const CREATE_WINDOW_MS = 10 * 60_000;
/**
 * Tournaments one player, or one address, may have open at once (not over or
 * archived). The limit above only slows down a script that waits it out; this
 * keeps what one of them can put on everyone's home page small.
 */
const OPEN_TOURNAMENTS = 10;
const NAME_MAX = 20;

/**
 * Which build of the web app a page is: the entry script it loads, whose name
 * Vite hashes from the code. A new release (a restart, so every tab
 * reconnects) changes it.
 */
export function webBuild(indexHtml: string): string | null {
  return /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(indexHtml)?.[1] ?? null;
}

/** Runs a handler and acks the result; expected failures become an error ack, not a crash. */
async function guarded<T extends object>(ack: Ack<T> | undefined, fn: () => T | void | Promise<T | void>, log: AppDeps['log']) {
  try {
    const result = await fn();
    if (typeof ack === 'function') ack({ ok: true, ...(result ?? {}) } as never);
  } catch (err) {
    const expected = err instanceof ActionError || err instanceof SettingsError || err instanceof IdentityError;
    if (!expected) log?.('handler failed', err);
    if (typeof ack === 'function') ack({ ok: false, error: expected && err instanceof Error ? err.message : 'something went wrong' });
  }
}

/**
 * The limits on working out coach tips: TIP_BURST per player per
 * TIP_WINDOW_MS (across their tabs), and TIP_BUDGET_MS of work per
 * TIP_BUDGET_WINDOW_MS across the whole server.
 */
export function tipLimits(now: () => number) {
  const times = new Map<PlayerId, number[]>();
  let work: { at: number; ms: number }[] = [];
  return {
    /** Throws if this player, or the server, has had enough for now; otherwise counts the tip and returns what to call with how long it took. */
    admit(playerId: PlayerId): (ms: number) => void {
      const t = now();
      const recent = (times.get(playerId) ?? []).filter((x) => t - x < TIP_WINDOW_MS);
      if (recent.length >= TIP_BURST) throw new ActionError('a few seconds between tips, please');
      work = work.filter((w) => t - w.at < TIP_BUDGET_WINDOW_MS);
      if (work.reduce((sum, w) => sum + w.ms, 0) >= TIP_BUDGET_MS) throw new ActionError('the coach is busy, try again in a moment');
      times.set(playerId, [...recent, t]);
      return (ms) => void work.push({ at: t, ms });
    },
    forget(playerId: PlayerId) {
      times.delete(playerId);
    },
  };
}

/** A limit kept per player and per address: true, and counted against both (unless `count` is false), when both have room for one more. */
function perPlayerAndAddress(burst: number, windowMs: number, now: () => number) {
  const byPlayer = limiter(burst, windowMs, now);
  const byAddress = limiter(burst, windowMs, now);
  return (playerId: PlayerId, address: string, count = true) => {
    if (!byPlayer(playerId, false) || !byAddress(address, false)) return false;
    if (count) {
      byPlayer(playerId);
      byAddress(address);
    }
    return true;
  };
}

/**
 * Makes something only while the player, and the address, each have fewer than
 * `max` open: when either has `max`, says which (the player first). One being
 * made holds its place, so a burst can't slip past while the first are saved.
 *
 * The player's count is what they host now and made themselves (`hosted`; not
 * the next of a series or Sit & Go, which the server opens), worked out from
 * what the server has loaded, so it still holds after a restart. The address's
 * is only the ones made from it since this server started: no address is saved
 * with anything, so after a restart it starts again from zero. An address is
 * kept (in memory only) just while something made from it is open or being
 * made; `sweep` forgets the rest, and runs every few minutes.
 */
function openPerPlayerAndAddress(max: number, hosted: (playerId: PlayerId) => number, isOpen: (id: string) => boolean) {
  const making = new Map<PlayerId, number>();
  const made = new Map<string, { ids: string[]; making: number }>();
  /** Forgets addresses with nothing open and nothing being made. */
  const sweep = () => {
    for (const [address, m] of made) {
      m.ids = m.ids.filter(isOpen);
      if (!m.ids.length && !m.making) made.delete(address);
    }
  };
  const open = async (playerId: PlayerId, address: string, make: () => Promise<string>): Promise<{ id: string } | { full: 'player' | 'address' }> => {
    const theirs = making.get(playerId) ?? 0;
    if (hosted(playerId) + theirs >= max) return { full: 'player' };
    const here = made.get(address) ?? { ids: [], making: 0 };
    here.ids = here.ids.filter(isOpen);
    if (here.ids.length + here.making >= max) return { full: 'address' };
    made.set(address, here);
    making.set(playerId, theirs + 1);
    here.making++;
    try {
      const id = await make();
      here.ids.push(id);
      return { id };
    } finally {
      // (A new one is hosted a moment before it stops counting as being made; nothing else runs in between.)
      const left = making.get(playerId)! - 1;
      if (left) making.set(playerId, left);
      else making.delete(playerId);
      here.making--;
      if (!here.ids.length && !here.making) made.delete(address);
    }
  };
  return Object.assign(open, { sweep, addresses: () => made.size });
}

/** A browser's address; Fly puts the real one in a header, as for HTTP requests (clientAddress). */
function socketAddress(socket: Sock): string {
  const fly = socket.handshake.headers['fly-client-ip'];
  return typeof fly === 'string' ? fly : socket.handshake.address;
}

export function createApp(deps: AppDeps = {}) {
  const clock = deps.clock ?? systemClock;
  const identity = deps.identity ?? memoryIdentity();
  const store = deps.store ?? memoryStore();
  const notes = deps.notes ?? memoryNotes();
  const setups = deps.setups ?? memorySetups();
  const avatarStore = deps.avatars ?? memoryAvatars();
  const sharedStore = deps.shared ?? memorySharedHands();
  // A failed query's own error: drizzle's wrapper repeats every value the query carried (a whole table snapshot).
  const log = deps.log ?? ((m, e) => console.error(m, dbCause(e) ?? ''));
  const audit = deps.audit ?? AuditLog.after(memoryAuditStore(), null, { now: () => clock.now(), log });
  const build = deps.build ?? buildFromEnv();
  const startedAt = clock.now();
  audit.boot(build);

  const app = express();
  const http = createServer(app);
  const io = new Server<C2S, S2C>(http, {
    cors: process.env.NODE_ENV === 'production' ? undefined : { origin: true },
    // A phone that loses its signal sends nothing; with the defaults (25 s + 20 s) the table waited up to 45 s
    // to notice and kept giving them the full clock and time bank. Now it notices within about 20 s.
    pingInterval: 10_000,
    pingTimeout: 10_000,
    // Socket.IO's default, set on purpose: a message over it drops the connection. The biggest a client sends is
    // a batch of saved setups being brought onto an account, which the page keeps to half of this.
    maxHttpBufferSize: 1_000_000,
  });

  const tables = new Map<string, TableRuntime>();
  const watchers = new Map<string, Set<Sock>>();
  const tournamentWatchers = new Map<string, Set<Sock>>();
  const playerSockets = new Map<PlayerId, Set<Sock>>();
  const pendingBroadcast = new Set<string>();
  /** Spectator delay: what each table looked like to spectators, oldest first. */
  const feeds = new Map<string, { at: number; part: DelayedPart; cards: boolean }[]>();
  const saveTimers = new Map<string, NodeJS.Timeout>();
  /** Saves wait for the table's row to exist. */
  const created = new Map<string, Promise<void>>();
  /** Pictures of players seen since the server started, as tables show them. */
  const avatars = new Map<PlayerId, string | null>();
  const avatarOf = (playerId: PlayerId) => avatars.get(playerId) ?? null;
  const gestureTimes = new Map<PlayerId, number[]>();
  const chatTimes = new Map<PlayerId, number[]>();
  const tips = tipLimits(() => clock.now());
  const shareTimes = new Map<PlayerId, number[]>();
  const avatarChanges = new Map<PlayerId, number[]>();
  const tableCreates = perPlayerAndAddress(TABLES_PER_WINDOW, CREATE_WINDOW_MS, () => clock.now());
  const tournamentCreates = perPlayerAndAddress(TOURNAMENTS_PER_WINDOW, CREATE_WINDOW_MS, () => clock.now());
  const openTournaments = openPerPlayerAndAddress(OPEN_TOURNAMENTS, (playerId) => tournaments.openHostedBy(playerId), (id) => tournaments.isOpen(id));
  /** Loads the pictures of seated players the server has not seen yet (after a restart), then shows them. */
  function loadAvatars(rt: TableRuntime) {
    const missing = rt.state.seats.filter((x) => x && !avatars.has(x.playerId)).map((x) => x!.playerId);
    if (!missing.length) return;
    for (const id of missing) avatars.set(id, null);
    // A failed lookup is forgotten, so the next view tries again.
    Promise.all(
      missing.map((id) =>
        avatarStore.get(id).then(
          (a) => avatars.set(id, avatarToken(a)),
          (e) => (avatars.delete(id), Promise.reject(e)),
        ),
      ),
    )
      .then(() => broadcast(rt))
      .catch((e) => log('loading avatars failed', e));
  }

  // `ok` and the 200 stay as they are whatever the database says: Fly's own health check reads them, and failing it
  // takes the only machine out of service. The site-down alert reads `db` too (docs/DEPLOY.md, "Site-down alert").
  const dbHealth = deps.checkDb ? databaseHealth(deps.checkDb, log) : null;
  app.get('/api/health', async (_req, res) => {
    const body = { ok: true, tables: tables.size, memoryMb: Math.round(process.memoryUsage().rss / 1_048_576) };
    res.json(dbHealth ? { ...body, db: await dbHealth() } : body);
  });
  auditRoutes(app, audit, build, startedAt, log);
  const isAdmin = adminGate(deps.adminKey ?? process.env.ADMIN_KEY, () => clock.now());
  suggestionRoutes(app, deps.suggestions ?? memorySuggestions(), { isAdmin, now: () => clock.now(), log, onAdmin: (action, id) => audit.admin(action, id) });
  const accountHooks: AccountHooks = {
    signedIn: (playerId) => avatars.delete(playerId),
    deleted: (playerIds) => {
      for (const id of playerIds) {
        avatars.delete(id);
        // Their tabs reconnect as new guests.
        for (const s of playerSockets.get(id) ?? []) s.disconnect(true);
      }
    },
    signedOutElsewhere: (playerIds, keepGuestToken) => {
      const keep = keepGuestToken ? hashSecret(keepGuestToken) : null;
      // Those tabs reload and connect again as whoever they are now.
      for (const id of playerIds) for (const s of playerSockets.get(id) ?? []) if (s.data.device !== keep) s.disconnect(true);
    },
    heldBy: async (playerId) => {
      const mine = (list: { playerId: PlayerId }[] | undefined) => !!list?.some((x) => x.playerId === playerId);
      const waits = (rt: TableRuntime) => mine(rt.state.requests) || mine(rt.state.waitlist) || mine(rt.state.offers);
      for (const [id, rt] of tables) {
        if (rt.isTournament) continue;
        const seated = !!rt.seatOf(playerId);
        if (seated || waits(rt)) return { table: rt.state.settings.table.name, id, waiting: !seated };
      }
      const event = tournaments.enteredIn(playerId);
      if (event !== null) return { tournament: event.name, id: event.id };
      // Tables put away while idle keep their seats in their last save; one being put away now is saved first.
      await Promise.allSettled([...unloading.values()]);
      const saved = (await store.tablesSeating?.(playerId)) ?? [];
      const away = saved.find((t) => !tables.has(t.id) && !deleted.has(t.id));
      return away ? { table: away.name, id: away.id, waiting: !away.seated } : null;
    },
    peopleAt: (tableId) => new Set([...(watchers.get(tableId) ?? [])].map((s) => s.data.playerId)).size,
    deletePracticeTable: async (tableId, playerIds, stillOnlyMine) => {
      const mine = new Set(playerIds);
      const someoneElse = (rt: TableRuntime | undefined) =>
        !!rt &&
        [...rt.state.seats, ...rt.state.history.flatMap((h) => h.hand.seats)].some((x) => x && !mine.has(x.playerId) && !rt.state.bots?.[x.playerId]);
      const refuse = (rt: TableRuntime | undefined) => {
        if ([...(watchers.get(tableId) ?? [])].length > 0) return 'Someone has that table open. Leave it first, then delete it.';
        if (rt?.state.realGame) return "That was a real game, so it can't be deleted. You can hide it from your profile instead.";
        if (someoneElse(rt)) return 'Someone else played at that table, so it stays. It has been left on your profile.';
        return null;
      };
      const first = refuse(tables.get(tableId));
      if (first) throw new StorageError('conflict', first);
      if (deleted.has(tableId)) return;
      // Nobody can open the table from here on, so nobody sits down while the last checks run.
      deleted.add(tableId);
      try {
        // A hand still being saved could have had someone else in it: look again once it's written.
        await Promise.allSettled([...(inFlight.get(tableId) ?? [])]);
        const again = refuse(tables.get(tableId));
        if (again) throw new StorageError('conflict', again);
        if (!(await stillOnlyMine())) throw new StorageError('conflict', 'Someone else played at that table, so it stays. It has been left on your profile.');
        if (!(await removeTable(tableId))) return;
      } catch (e) {
        deleted.delete(tableId);
        throw e;
      }
      log(`practice table ${tableId} deleted by the only person who played at it`);
      audit.deleted(tableId, 'player');
    },
  };
  const confirmations = googleConfirmations(() => clock.now());
  accountRoutes(app, deps.accounts ?? null, {
    isAdmin,
    confirmations,
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    log,
    hooks: accountHooks,
    onAdmin: (action) => audit.admin(action),
  });
  // A loaded table's own fairness state, which may be ahead of its last save (a game started again before its stopped hands opened).
  handSearchRoutes(app, deps.accounts ?? null, { shared: sharedStore, now: () => clock.now(), log, liveFair: (id) => (tables.has(id) ? (tables.get(id)!.state.fair ?? null) : undefined) });
  googleRoutes(app, deps.accounts ?? null, { config: deps.google ?? null, confirmations, now: () => clock.now(), log, hooks: accountHooks });
  // Shared hand links: anyone with the id may read the frozen hand.
  app.get('/api/shared/:id', (req, res) => {
    const id = String(req.params.id);
    if (!/^[\w-]{10,40}$/.test(id)) return void res.status(404).json({ error: 'not found' });
    sharedStore
      .get(id)
      .then((hand) => (hand ? res.set('Cache-Control', 'no-store').json(hand) : res.status(404).json({ error: 'not found' })))
      .catch((e) => {
        log('loading a shared hand failed', e);
        res.status(500).json({ error: 'something went wrong' });
      });
  });
  // Uploaded pictures. Tables name them with a version, so a new upload is a new URL and old ones can be cached for good.
  app.get('/api/avatars/:playerId', (req, res) => {
    avatarStore
      .get(String(req.params.playerId))
      .then((a) => {
        const img = avatarImage(a);
        if (!img) return void res.status(404).end();
        res.set({ 'Content-Type': img.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
        res.send(img.data);
      })
      .catch((e) => {
        log('loading an avatar failed', e);
        res.status(500).end();
      });
  });
  // Operator cleanup, only from a shell on the server itself (flyctl ssh console). Requests through
  // Fly's proxy come from another address and always carry Fly-Client-IP and X-Forwarded-For.
  const fromServerShell = (req: express.Request) =>
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') && !req.get('fly-client-ip') && !req.get('x-forwarded-for');
  app.get('/api/admin/tournaments', (req, res) => {
    if (!fromServerShell(req)) return void res.status(404).end();
    res.json(tournaments.adminList());
  });
  app.post('/api/admin/tournaments/:id/archive', (req, res) => {
    if (!fromServerShell(req)) return void res.status(404).end();
    tournaments.adminArchive(String(req.params.id)).then(
      (r) => {
        audit.admin('archive-tournament', subjectRef('tournament', String(req.params.id)));
        res.json(r);
      },
      (e) => res.status(e instanceof ActionError ? 400 : 500).json({ error: e instanceof Error ? e.message : String(e) }),
    );
  });
  // The admin page looks a cash table up by its id, then may delete it for good (tests and mistakes).
  const adminTableId = (req: express.Request) => {
    const id = String(req.params.id);
    return /^[\w-]{4,40}$/.test(id) ? id : null;
  };
  app.get('/api/admin/tables/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isAdmin(req, res)) return;
    const id = adminTableId(req);
    if (!id) return void res.status(404).json({ error: 'No table has that id.' });
    (tables.get(id) ? Promise.resolve(tables.get(id)!.state) : store.loadTable(id))
      .then(async (state) => {
        if (!state) return void res.status(404).json({ error: 'No table has that id.' });
        const live = tables.get(id);
        const bots = botIdsOf(state);
        const isBot = (pid: string) => bots.has(pid);
        const realGame =
          (state.realGame ?? ((await store.loadHands(id)).some((h) => realGameHand(h.seats, isBot)) || state.history.some((h) => realGameHand(h.hand.seats, isBot)))) ||
          (!!state.hand && state.hand.phase !== 'complete' && realGameHand(state.hand.seats, isBot));
        const people = Object.entries(state.handNames ?? {}).filter(([pid]) => !isBot(pid));
        res.json({
          id,
          name: state.settings.table.name,
          mode: state.settings.table.mode,
          createdAt: new Date(state.createdAt).toISOString(),
          hands: state.handNumber,
          players: people.map(([, name]) => name || 'Guest'),
          realGame,
          live: !!live,
        });
      })
      .catch((e) => {
        log('admin table lookup failed', e);
        res.status(500).json({ error: 'Something went wrong. Try again.' });
      });
  });
  app.post('/api/admin/tables/:id/delete', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isAdmin(req, res)) return;
    const id = adminTableId(req);
    if (!id) return void res.status(404).json({ error: 'No table has that id.' });
    removeTable(id).then(
      (found) => {
        if (!found) return void res.status(404).json({ error: 'No table has that id.' });
        log(`table ${id} deleted by the admin`);
        audit.deleted(id, 'admin');
        res.json({ ok: true });
      },
      (e) => {
        if (e instanceof StorageError && e.code === 'conflict') return void res.status(409).json({ error: e.message });
        log('admin table delete failed', e);
        res.status(500).json({ error: 'Something went wrong. Try again.' });
      },
    );
  });
  // The nightly off-site backup (GitHub Actions, backup.yml) downloads the whole database here. Each copy goes in the
  // public record: it holds any hand being played at that moment.
  /** The backup being downloaded, if one is: shutting down stops it, so its transaction can't hold up the final saves. */
  let backup: Promise<unknown> | null = null;
  let stopBackup = () => {};
  app.get('/api/admin/backup', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isAdmin(req, res)) return;
    const db = deps.accounts;
    if (!db) return void res.status(404).json({ error: 'This server has no database to back up.' });
    if (backup) return void res.status(429).json({ error: 'A backup is already running.' });
    // Recorded before the first byte goes out: a download stopped just short of the end has still seen almost everything.
    audit.admin('backup');
    res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="rsdp-backup.jsonl.gz"' });
    const gzip = createGzip();
    gzip.pipe(res);
    let stopped = false;
    stopBackup = () => (stopped = true);
    res.on('close', stopBackup);
    backup = writeBackup(db, (line) => {
      if (stopped) throw new Error('the download was closed');
      if (!gzip.write(line)) return new Promise<void>((done) => gzip.once('drain', done));
    })
      .then(() => gzip.end())
      .catch((e) => {
        log('backup failed', e);
        // Without its end line the download reads as cut short.
        res.destroy();
      })
      .finally(() => {
        backup = null;
        stopBackup = () => {};
      });
  });
  /** The web app served here, told to every tab that connects; null without a built app (development). */
  let webApp: string | null = null;
  if (deps.webDist && existsSync(deps.webDist)) {
    const dist = deps.webDist;
    // index: false, so "/" also goes through the preview below.
    app.use(express.static(dist, { index: false }));
    const indexHtml = readFileSync(path.join(dist, 'index.html'), 'utf8');
    webApp = webBuild(indexHtml);
    // Client-side routes (/t/:id, /tn/:id, ...) all load the app, with a link preview for chat apps.
    app.get('*', async (req, res, next) => {
      // A missing file (an old asset) is a 404, not the app.
      if (/\.[a-z0-9]+$/i.test(req.path)) return next();
      let html = indexHtml;
      try {
        const preview = await linkPreview(req.path);
        if (preview) {
          const origin = process.env.PUBLIC_URL ?? `${req.get('x-forwarded-proto')?.split(',')[0] ?? req.protocol}://${req.get('host')}`;
          html = withPreview(indexHtml, preview, `${origin}${req.path}`, origin);
        }
      } catch (e) {
        log('link preview failed', e);
      }
      res.type('html').send(html);
    });
  }
  // What broke in a browser, one line in the log (it compares the page's build with webApp).
  clientErrorRoutes(app, { now: () => clock.now(), log, build, served: webApp });
  // Last: anything a route passes on. Express's own handler would print the stack trace of every body that is
  // too big or isn't JSON (express.json in the API routes), so anyone could fill the log; those get a short
  // answer instead, and only real failures are logged.
  app.use(requestFailed(log));

  function broadcast(rt: TableRuntime) {
    const id = rt.state.id;
    if (pendingBroadcast.has(id)) return;
    pendingBroadcast.add(id);
    queueMicrotask(() => {
      pendingBroadcast.delete(id);
      const now = clock.now();
      loadAvatars(rt);
      const delayMs = rt.settings.spectators.delaySeconds * 1000;
      if (delayMs > 0) {
        // Remember what spectators would see now, and show it to them once the delay has passed.
        const cards = spectatorsSeeCards(rt.settings);
        // Once the host stops spectators seeing every card, the snapshots that show them are dropped, not played out.
        const feed = (feeds.get(id) ?? []).filter((f) => cards || !f.cards);
        feeds.set(id, feed);
        feed.push({ at: now, part: delayedPart(tableView(rt, '', now, null, [], avatarOf)), cards });
        // Keep only the newest snapshot old enough to show, and the ones after it.
        let old = 0;
        while (old + 1 < feed.length && feed[old + 1].at <= now - delayMs) old++;
        if (old > 0) feed.splice(0, old);
        clock.setTimeout(() => {
          if (tables.get(id) !== rt) return;
          // Timers can fire a millisecond early; the snapshot taken now must count as old enough.
          const later = Math.max(clock.now(), now + delayMs);
          for (const s of watchers.get(id) ?? []) if (isSpectator(rt, s)) s.emit('table:state', viewFor(rt, s, later));
        }, delayMs);
      } else feeds.delete(id);
      for (const s of watchers.get(id) ?? []) s.emit('table:state', viewFor(rt, s, now));
    });
  }

  /** One answer for a hand that isn't there and one a spectator's delay still hides. */
  const HAND_NOT_AVAILABLE = 'that hand isn’t available';

  const isSpectator = (rt: TableRuntime, s: Sock) => !rt.seatOf(s.data.playerId) && !rt.isStaff(s.data.playerId);

  /**
   * Finished hands a person may open: everything for players and the host;
   * for spectators nothing when watching is off, and only hands that ended
   * longer ago than the delay, so history can't get ahead of the table.
   */
  function spectatorCutoff(rt: TableRuntime, s: Sock): number {
    if (!isSpectator(rt, s)) return Infinity;
    if (!rt.settings.spectators.allowed) throw new ActionError('the host has turned watching off');
    return clock.now() - rt.settings.spectators.delaySeconds * 1000;
  }

  /** One person's view; a spectator at a table with a delay sees the hand as it was that long ago. */
  function viewFor(rt: TableRuntime, s: Sock, now: number) {
    const id = rt.state.id;
    const live = tableView(rt, s.data.playerId, now, tournaments.tournamentOf(id), audience(id), avatarOf);
    const delayMs = rt.settings.spectators.delaySeconds * 1000;
    if (delayMs <= 0 || !isSpectator(rt, s)) return live;
    const feed = feeds.get(id) ?? [];
    // The newest snapshot old enough to show; anything older than it is no longer needed.
    let i = -1;
    while (i + 1 < feed.length && feed[i + 1].at <= now - delayMs) i++;
    if (i > 0) feed.splice(0, i);
    return behind(live, i >= 0 ? feed[0].part : null, delayMs);
  }

  /** Everyone with a table open, once each, by the name they go by. */
  function audience(id: string) {
    const seen = new Map<PlayerId, string>();
    for (const s of watchers.get(id) ?? []) if (!seen.has(s.data.playerId)) seen.set(s.data.playerId, s.data.session.displayName || 'Guest');
    return [...seen].map(([playerId, name]) => ({ playerId, name }));
  }

  /** Saves still running for each table, so deleting it can wait for them. */
  const inFlight = new Map<string, Set<Promise<unknown>>>();
  function track(id: string, p: Promise<unknown>) {
    const set = inFlight.get(id) ?? new Set();
    inFlight.set(id, set);
    set.add(p);
    void p.finally(() => {
      set.delete(p);
      if (set.size === 0 && inFlight.get(id) === set) inFlight.delete(id);
    });
  }

  function scheduleSave(rt: TableRuntime) {
    const id = rt.state.id;
    if (saveTimers.has(id)) return;
    saveTimers.set(
      id,
      setTimeout(() => {
        saveTimers.delete(id);
        track(id, (created.get(id) ?? Promise.resolve()).then(() => store.saveTable(rt.state)).catch((e) => log(`saving table ${id} failed`, e)));
      }, SAVE_DEBOUNCE_MS),
    );
  }

  function attach(rt: TableRuntime, ready: Promise<void> = Promise.resolve()) {
    const id = rt.state.id;
    tables.set(id, rt);
    created.set(id, ready);
    lastWatched.set(id, clock.now());
    lastChange.set(id, clock.now());
    audit.watchTable(rt.state).catch((e) => log(`reading the public record for table ${id} failed`, e));
    rt.onChange = () => {
      audit.safely('chip totals', () => audit.tableChanged(rt.state));
      lastChange.set(id, clock.now());
      broadcast(rt);
      scheduleSave(rt);
    };
    // Hand saves run one after another, so a late show saved again can't be overwritten by the hand's first save.
    let handSaves = created.get(id) ?? Promise.resolve();
    rt.onHandFinished = (record) => {
      audit.safely('a hand', () => audit.hand(id, record));
      handSaves = handSaves.then(() => store.saveHand(id, record)).catch((e) => log(`saving hand ${record.handNumber} failed`, e));
      track(id, handSaves);
    };
    // Log and chat lines are saved in order too, the ones that come in while a save runs together in the next.
    // First the ones the table has now, if none are saved for it yet (a table saved before every line was kept).
    const earlier = structuredClone(startingLines(rt.state));
    let lineSaves = (created.get(id) ?? Promise.resolve()).then(() =>
      store.keepEarlierLines(id, earlier).catch((e) => log(`saving the earlier log of table ${id} failed`, e)),
    );
    track(id, lineSaves.catch(() => {}));
    let waiting: TableLine[] = [];
    rt.onLine = (line) => {
      waiting.push(line);
      if (waiting.length > 1) return;
      lineSaves = lineSaves
        .then(() => {
          const batch = waiting;
          waiting = [];
          return store.saveLines(id, batch);
        })
        .catch((e) => log(`saving the log of table ${id} failed`, e));
      track(id, lineSaves);
    };
    return rt;
  }

  /** Cash tables deleted since the server started, so a join racing the delete can't load one back. */
  const deleted = new Set<string>();

  /** When someone last had each loaded table open, and when it last changed. */
  const lastWatched = new Map<string, number>();
  const lastChange = new Map<string, number>();
  /** Final saves of tables being put away; opening one waits for its save before loading it again. */
  const unloading = new Map<string, Promise<void>>();

  /**
   * Puts away cash tables nobody has had open for a while, so old tables don't
   * fill the server's memory. Each is saved as it is and stops; its link loads
   * it again with everything kept (seats, stacks, ledger, chat, hands). A hand
   * still being played waits until it is over, unless the table has not changed
   * for as long (a hand nobody can finish).
   */
  function unloadIdle(): string[] {
    const idleMs = deps.idleUnloadMs ?? IDLE_UNLOAD_MS;
    if (idleMs <= 0) return [];
    const now = clock.now();
    const gone: string[] = [];
    for (const rt of [...tables.values()]) {
      const id = rt.state.id;
      if (rt.isTournament) continue;
      if (watchers.get(id)?.size) {
        lastWatched.set(id, now);
        continue;
      }
      if (now - (lastWatched.get(id) ?? now) < idleMs) continue;
      const hand = rt.state.hand;
      if (hand && hand.phase !== 'complete' && now - (lastChange.get(id) ?? now) < idleMs) continue;
      unload(rt);
      gone.push(id);
    }
    return gone;
  }

  function unload(rt: TableRuntime) {
    const id = rt.state.id;
    rt.onChange = () => {};
    rt.onHandFinished = () => {};
    rt.onLine = () => {};
    rt.dispose();
    tables.delete(id);
    audit.forgetTable(id);
    feeds.delete(id);
    watchers.delete(id);
    lastWatched.delete(id);
    lastChange.delete(id);
    // practiceStarts stays: a creator who opens the link later still gets the first deal.
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    // Saves already under way finish first, so the last one written is this one.
    const earlier = [...(inFlight.get(id) ?? [])];
    const done = (created.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => Promise.allSettled(earlier))
      .then(() => store.saveTable(rt.state))
      .catch((e) => {
        log(`saving idle table ${id} failed`, e);
        // Its newest state is only in memory: keep it loaded, to be saved on its next change or put away again later.
        if (!tables.has(id) && !deleted.has(id)) {
          attach(rt);
          rt.resume();
        }
      })
      .finally(() => {
        if (unloading.get(id) === done) unloading.delete(id);
        if (!tables.has(id)) created.delete(id);
      });
    unloading.set(id, done);
    track(id, done);
  }

  /** Forgets addresses the limits no longer need (the privacy page promises at most about an hour). */
  function forgetOldAddresses() {
    openTournaments.sweep();
    sweepLimiters();
  }

  const sweep = deps.idleUnloadMs === 0 ? null : setInterval(() => {
    try {
      unloadIdle();
    } catch (e) {
      log('putting idle tables away failed', e);
    }
    forgetOldAddresses();
  }, Math.min(IDLE_SWEEP_MS, Math.max(1_000, (deps.idleUnloadMs ?? IDLE_UNLOAD_MS) / 3)));
  sweep?.unref();

  /**
   * Deletes a cash table for good: everyone with it open is told and let go,
   * the runtime stops, and its saved state and hands are removed.
   */
  async function removeTable(id: string): Promise<boolean> {
    const rt = tables.get(id);
    // Refused before anything stops: tournament tables go with their tournament.
    if (rt ? rt.isTournament : (await store.loadTable(id))?.settings.table.mode === 'tournament') {
      throw new StorageError('conflict', 'tournament tables are kept with their tournament');
    }
    deleted.add(id);
    if (rt) {
      rt.onChange = () => {};
      rt.onHandFinished = () => {};
      rt.onLine = () => {};
      rt.dispose();
      tables.delete(id);
      feeds.delete(id);
      lastWatched.delete(id);
      lastChange.delete(id);
      practiceStarts.delete(id);
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      for (const s of watchers.get(id) ?? []) {
        s.data.tableId = undefined;
        s.emit('table:deleted', { id });
      }
      watchers.delete(id);
    }
    await (created.get(id) ?? Promise.resolve()).catch(() => {});
    // A hand or table save already under way would race the delete.
    await Promise.allSettled([...(inFlight.get(id) ?? [])]);
    created.delete(id);
    try {
      return (await store.deleteTable(id)) || !!rt;
    } catch (e) {
      // Nothing was deleted, so the table can be opened again (from its last save).
      deleted.delete(id);
      throw e;
    }
  }

  /** Practice tables waiting for their creator to arrive before the first deal: table id → creator. */
  const practiceStarts = new Map<string, PlayerId>();

  /** When each player last chatted in a lobby. */
  const lastLobbyChat = new Map<PlayerId, number>();
  const lobby = new LobbyLog(deps.lobby ?? memoryLobbyStore(), log);
  /** Adds to a lobby's log and sends the new items to everyone watching it. */
  function addToLobby(id: string, fresh: Parameters<LobbyLog['add']>[1]) {
    lobby
      .add(id, fresh)
      .then((items: LobbyItem[]) => {
        for (const s of tournamentWatchers.get(id) ?? []) s.emit('tournament:log', { id, items, append: true });
      })
      .catch((e) => log(`lobby log of ${id} failed`, e));
  }

  const tournaments = new TournamentManager({
    clock,
    rng: deps.rng,
    fairLeadMs: deps.fairLeadMs,
    store: deps.tournaments ?? memoryTournamentStore(),
    tables: {
      createTable: (state) => store.createTable(state),
      loadTable: (id) => store.loadTable(id),
      attach: (rt, _tournamentId, ready) => {
        attach(rt, ready);
      },
      detach: (rt) => {
        tables.delete(rt.state.id);
        audit.forgetTable(rt.state.id);
        feeds.delete(rt.state.id);
        lastWatched.delete(rt.state.id);
        lastChange.delete(rt.state.id);
        // Save the final state so the table's history stays readable.
        store.saveTable(rt.state).catch(() => {});
        broadcast(rt);
      },
    },
    onState: (id) => {
      for (const s of tournamentWatchers.get(id) ?? []) {
        const view = tournaments.view(id, s.data.playerId);
        if (view) s.emit('tournament:state', { id, view });
      }
    },
    onEvents: (state, before, events) => {
      const at = clock.now();
      const name = namesIn(state, before);
      const items = events.flatMap((e) => {
        const event = logEvent(e, name);
        return event ? [{ at, kind: 'event' as const, event }] : [];
      });
      if (items.length) addToLobby(state.id, items);
    },
    onMoved: (playerId, from, to) => {
      for (const s of playerSockets.get(playerId) ?? []) s.emit('table:moved', { from, to });
    },
    log,
  });

  /** Every finished hand of a table as one player may see it (spectators only those past the delay): saved hands, with the copies still in memory winning (they include cards shown after the hand). */
  async function allHandViews(rt: TableRuntime, playerId: PlayerId, cutoff = Infinity, notes = false) {
    const saved = await store.loadHands(rt.state.id);
    const byNumber = new Map(saved.map((h) => [h.handNumber, h]));
    for (const h of rt.state.history) byNumber.set(h.handNumber, pastHand(h));
    return [...byNumber.values()]
      .sort((a, b) => a.handNumber - b.handNumber)
      .filter((h) => h.endedAt <= cutoff)
      .map((h) => handRecordView(rt, h, playerId, { notes }));
  }

  async function getTable(id: string): Promise<TableRuntime | null> {
    const live = tables.get(id);
    if (live) return live;
    if (deleted.has(id)) return null;
    // A table being put away is read back once its last save is written.
    await unloading.get(id);
    if (tables.has(id)) return tables.get(id)!;
    if (deleted.has(id)) return null;
    // Tournament tables come back with their tournament, which gives them their clock and seats.
    if (await tournaments.loadTableOwner(id)) return tables.get(id) ?? null;
    const saved = await store.loadTable(id);
    if (!saved || saved.settings.table.mode === 'tournament') return null;
    // A hand is saved as soon as it ends, the table up to SAVE_DEBOUNCE_MS later: after a crash the table may still
    // be playing a hand already saved as finished. That hand is closed with its saved result, not played again.
    const handLive = !!saved.hand && saved.hand.phase !== 'complete';
    const ended = handLive ? await store.loadHand(id, saved.handNumber) : null;
    // Tables saved before the runtime kept count: look through their hands once.
    if (saved.realGame === undefined) {
      const bots = botIdsOf(saved);
      const isBot = (pid: string) => bots.has(pid);
      saved.realGame = (await store.loadHands(id)).some((h) => realGameHand(h.seats, isBot)) || saved.history.some((h) => realGameHand(h.hand.seats, isBot));
    }
    // Another join may have loaded it (or it was deleted) while we waited.
    if (deleted.has(id)) return null;
    if (tables.has(id)) return tables.get(id)!;
    const runtime = new TableRuntime(saved, { clock, rng: deps.rng, log, fairLeadMs: deps.fairLeadMs, fairStopRevealMs: deps.fairStopRevealMs });
    if (ended && runtime.closeSavedHand(ended)) log(`table ${id}: hand ${ended.handNumber} was saved as finished but the table as still playing it; closed it with its saved result`);
    const rt = attach(runtime);
    rt.resume();
    return rt;
  }

  /** What a pasted link to this page should show in a chat app. */
  async function linkPreview(pathname: string) {
    // Read only: a crawler opening a link must not load a tournament or wake a table up.
    const tn = /^\/tn\/([0-9a-f]{16})\/?$/.exec(pathname);
    if (tn) {
      const state = await tournaments.peek(tn[1]);
      return state && !isArchived(state) ? tournamentPreview(state, clock.now()) : null;
    }
    const t = /^\/t\/([\w-]{1,64})\/?$/.exec(pathname);
    if (t) {
      const owner = tournaments.tournamentOf(t[1]) ?? /^([0-9a-f]{16})-t\d+$/.exec(t[1])?.[1];
      if (owner) {
        const state = await tournaments.peek(owner);
        return state && !isArchived(state) ? tournamentPreview(state, clock.now()) : null;
      }
      const state = tables.get(t[1])?.state ?? (await store.loadTable(t[1]));
      if (!state) return null;
      const { settings } = state;
      const { smallBlind, bigBlind, centsMode } = settings.stakes;
      return tablePreview(settings.table.name, [settings.game.gameId], `${amountText(smallBlind, centsMode)}/${amountText(bigBlind, centsMode)}`, settings.game.betting, spectatorsSeeCards(settings));
    }
    if (/^\/whats-new\/?$/.test(pathname)) return { title: "What's new · RSDP Poker Live!", description: 'Everything that has been added to RSDP Poker Live!, newest first.' };
    if (/^\/changelog\/?$/.test(pathname)) return { title: 'Changelog · RSDP Poker Live!', description: 'Every release of RSDP Poker Live! and the small fixes in it.' };
    if (/^\/roadmap\/?$/.test(pathname)) return { title: 'Roadmap · RSDP Poker Live!', description: "What's live now and what's coming next to RSDP Poker Live!" };
    if (/^\/(signin|signup|reset|profile)\/?$/.test(pathname)) return { title: 'Your account · RSDP Poker Live!', description: 'Optional accounts: sign in to keep your name, picture, notes and history on every device.' };
    if (/^\/fairness\/?$/.test(pathname)) return { title: 'Fair dealing · RSDP Poker Live!', description: 'How every deck is shuffled, the audit and test results, and how to check any hand yourself.' };
    if (/^\/transparency\/?$/.test(pathname)) return { title: 'Checking John · RSDP Poker Live!', description: 'What the site runs, the public record of every hand and admin action, and how to check them from outside the server.' };
    if (/^\/privacy\/?$/.test(pathname)) return { title: 'Privacy · RSDP Poker Live!', description: 'What the site keeps about you, who can see it, how long it stays and how to delete it.' };
    if (/^\/terms\/?$/.test(pathname)) return { title: 'Terms of use · RSDP Poker Live!', description: 'The site is free and comes as it is, with no warranty: the terms for using it.' };
    if (/^\/credits\/?$/.test(pathname)) return { title: 'Credits · RSDP Poker Live!', description: 'The free, open-source software RSDP Poker Live! is built on, and its licenses.' };
    return { title: 'RSDP Poker Live!', description: 'Free poker with friends: cash games and tournaments that start on their own. Send a link, no sign-up.' };
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return next(new Error('missing token'));
    try {
      const signedIn = socket.handshake.auth?.session;
      const who = await identity.resolve(token, typeof signedIn === 'string' ? signedIn : undefined);
      if (!avatars.has(who.playerId)) {
        // A database hiccup shows no picture for now and tries again on the next connect.
        const saved = await avatarStore.get(who.playerId).then(avatarToken, () => undefined);
        if (saved !== undefined) avatars.set(who.playerId, saved);
      }
      socket.data.playerId = who.playerId;
      socket.data.session = { ...who, avatar: avatars.get(who.playerId) ?? null };
      socket.data.tournaments = new Set();
      socket.data.device = hashSecret(token);
      next();
    } catch (e) {
      next(e instanceof Error ? e : new Error('sign-in failed'));
    }
  });

  io.on('connection', (raw) => {
    const socket = raw as Sock;
    const me = socket.data.playerId;
    socket.emit('session', socket.data.session);
    if (webApp) socket.emit('build', webApp);
    if (!playerSockets.has(me)) playerSockets.set(me, new Set());
    playerSockets.get(me)!.add(socket);

    const current = () => {
      const rt = socket.data.tableId ? tables.get(socket.data.tableId) : undefined;
      if (!rt) throw new ActionError('join a table first');
      return rt;
    };
    /** Counts this tab's joins and leaves, so a join that finishes after a later one (or a leave) does nothing. */
    let joins = 0;
    const leave = () => {
      const id = socket.data.tableId;
      if (!id) return;
      watchers.get(id)?.delete(socket);
      if (tables.has(id)) lastWatched.set(id, clock.now());
      tables.get(id)?.disconnect(me);
      socket.data.tableId = undefined;
    };
    /** Remembers a name for every tab of this player. */
    const rename = async (value: unknown) => {
      const name = cleanName(value, NAME_MAX);
      if (!name) throw new ActionError('pick a name');
      if (name === socket.data.session.displayName) return;
      await identity.rename(me, name);
      for (const s of playerSockets.get(me) ?? []) {
        s.data.session = { ...s.data.session, displayName: name };
        s.emit('session', s.data.session);
        // Watchers are listed by this name.
        const rt = s.data.tableId ? tables.get(s.data.tableId) : undefined;
        rt?.guestNames.set(me, name);
        if (rt) broadcast(rt);
      }
    };
    /** A practice table: sits me in the first seat, adds the bots and deals. */
    const startPractice = async (rt: TableRuntime, practice: { name?: unknown; bots?: unknown; level?: unknown }) => {
      const name = cleanName(practice.name, NAME_MAX) || socket.data.session.displayName;
      if (!name) throw new ActionError('pick a name');
      const level = practice.level === undefined || practice.level === null ? undefined : (String(practice.level) as BotLevel);
      if (level && !BOT_LEVELS.includes(level)) throw new ActionError('no such level');
      if (!socket.data.session.displayName) await rename(name).catch(() => {});
      const bots = Math.max(1, Math.min(Math.floor(Number(practice.bots)) || 1, rt.state.seats.length - 1));
      rt.requestSeat(me, { seat: 0, name, stack: rt.defaultBuyIn(), consent: true });
      for (let i = 0; i < bots; i++) rt.addBot(me, { ownerName: name, level });
      // The cards come out once the creator is at the table, not before (their clock would run while the page loads).
      practiceStarts.set(rt.state.id, me);
    };
    // A malformed message (no payload, the wrong shape) must not throw out of the socket and restart the server for every table.
    const on = <K extends keyof C2S>(event: K, handler: C2S[K]) =>
      socket.on(event, ((...args: unknown[]) => {
        try {
          (handler as (...a: unknown[]) => unknown)(...args);
        } catch (e) {
          log(`bad ${String(event)} message`, e);
          const ack = args.at(-1);
          if (typeof ack === 'function') ack({ ok: false, error: 'something went wrong' });
        }
      }) as never);

    on('session:name', (input, ack) => guarded(ack, () => rename(input?.name), log));

    on('table:create', (input, ack) =>
      guarded(
        ack,
        async () => {
          const patch = input?.settings ?? {};
          // Tables made here are cash tables, played for dollars and cents; tournaments make their own.
          const settings = newCashSettings(mergePatches(patch, { table: { mode: 'cash' } }));
          if (!tableCreates(me, socketAddress(socket))) throw new ActionError('that is a lot of new tables; try again in a few minutes');
          const rt = TableRuntime.create({ hostId: me, settings }, { clock, rng: deps.rng, log, fairLeadMs: deps.fairLeadMs, fairStopRevealMs: deps.fairStopRevealMs });
          // A practice table is set up before it is saved, so one that can't be leaves nothing behind.
          if (input?.practice) {
            try {
              await startPractice(rt, input.practice);
            } catch (e) {
              rt.dispose();
              throw e;
            }
          }
          await store.createTable(rt.state);
          attach(rt);
          return { tableId: rt.state.id };
        },
        log,
      ),
    );

    on('table:join', ({ tableId } = { tableId: '' }, ack) =>
      guarded(
        ack,
        async () => {
          const seq = ++joins;
          const rt = await getTable(String(tableId));
          if (!rt) throw new ActionError('table not found');
          // A table read from the database takes a moment: the tab may have closed, left, or asked for another table
          // meanwhile. Joining now would leave the player counted at a table they have gone from.
          if (socket.disconnected || seq !== joins) return;
          if (socket.data.tableId !== rt.state.id) {
            leave();
            socket.data.tableId = rt.state.id;
            if (!watchers.has(rt.state.id)) watchers.set(rt.state.id, new Set());
            watchers.get(rt.state.id)!.add(socket);
            rt.connect(me);
          }
          if (practiceStarts.get(rt.state.id) === me) {
            practiceStarts.delete(rt.state.id);
            try {
              rt.start(me);
            } catch (e) {
              log(`practice table ${rt.state.id} could not start`, e);
            }
          }
          loadAvatars(rt);
          rt.guestNames.set(me, socket.data.session.displayName || 'Guest');
          socket.emit('table:state', viewFor(rt, socket, clock.now()));
        },
        log,
      ),
    );
    on('table:leave', () => {
      joins++;
      leave();
    });
    on('table:history', ({ handNumber }, ack) =>
      guarded(
        ack,
        () => {
          const rt = current();
          const record = rt.state.history.find((h) => h.handNumber === Number(handNumber));
          // A hand the delay still hides gets the same answer as one that isn't there, or a spectator learns it has ended.
          if (!record || record.endedAt > spectatorCutoff(rt, socket)) throw new ActionError(HAND_NOT_AVAILABLE);
          return { hand: handRecordView(rt, record, me, { notes: true }) };
        },
        log,
      ),
    );

    on('table:export', (ack) =>
      guarded(
        ack,
        async () => {
          const rt = current();
          const cutoff = spectatorCutoff(rt, socket);
          // Each download reads every hand of the table, so one per socket every few seconds.
          // It also feeds the Hands and Stats tabs, so it stays open while seated (see recordsLocked):
          // only finished hands, as this person saw them, never sooner than the table showed them.
          const now = clock.now();
          if (now - (socket.data.lastExport ?? 0) < EXPORT_GAP_MS) throw new ActionError('one download every few seconds, please');
          socket.data.lastExport = now;
          return { hands: await allHandViews(rt, me, cutoff, true) };
        },
        log,
      ),
    );

    on('table:fullLog', (ack) =>
      guarded(
        ack,
        async () => {
          const rt = current();
          if (rt.recordsLocked(me)) throw new ActionError('downloads open once you leave your seat or the game stops');
          const now = clock.now();
          if (now - (socket.data.lastFullLog ?? 0) < EXPORT_GAP_MS) throw new ActionError('one download every few seconds, please');
          const cutoff = spectatorCutoff(rt, socket);
          socket.data.lastFullLog = now;
          // Every line kept for the table; its state holds only the latest, and maybe some from before they were all kept.
          const saved = await store.loadLines(rt.state.id);
          return {
            log: withRecent(saved.log, rt.state.log).filter((l) => l.at <= cutoff).map((l) => ({ ...l })),
            chat: withRecent(saved.chat, rt.state.chat).filter((c) => c.at <= cutoff).map((c) => ({ ...c })),
            hands: await allHandViews(rt, me, cutoff),
          };
        },
        log,
      ),
    );
    on('hand:share', (input, ack) =>
      guarded(
        ack,
        async () => {
          const rt = current();
          const handNumber = Number(input?.handNumber);
          const now = clock.now();
          const recent = (shareTimes.get(me) ?? []).filter((t) => now - t < SHARE_WINDOW_MS);
          if (recent.length >= SHARE_BURST) throw new ActionError('that is a lot of links; try again in a minute');
          // Counted before the lookup, so asking for hands that aren't there can't read the table's history over and over.
          shareTimes.set(me, [...recent, now]);
          // Kept across reconnects (so reconnecting doesn't reset the limit); old entries are swept now and then.
          if (shareTimes.size > 500) for (const [id, times] of shareTimes) if (now - times.at(-1)! >= SHARE_WINDOW_MS) shareTimes.delete(id);
          const record = rt.state.history.find((h) => h.handNumber === handNumber) ?? (await store.loadHands(rt.state.id)).find((h) => h.handNumber === handNumber);
          // The same answer for a hand the delay still hides as for one that isn't there (see table:history).
          if (!record || record.endedAt > spectatorCutoff(rt, socket)) throw new ActionError(HAND_NOT_AVAILABLE);
          const id = newId();
          // A link is public and outlives the game: it never carries the seeds that rebuild the deck.
          const hand = { ...handRecordView(rt, record, me, { hideMine: !!input?.hideMine }), fair: null };
          // Which cards are mine, so the replay shows them; a link that hides them doesn't say.
          const sharerSeat = input?.hideMine ? undefined : hand.seats.find((s) => s.playerId === me)?.seat;
          await sharedStore.create({
            id,
            tableId: rt.state.id,
            handNumber,
            createdBy: me,
            snapshot: {
              id,
              tableName: rt.state.settings.table.name,
              centsMode: rt.state.settings.stakes.centsMode,
              seatCount: rt.state.seats.length,
              felt: rt.state.settings.table.felt ?? null,
              sharedBy: socket.data.session.displayName || rt.nameOf(me),
              ...(sharerSeat !== undefined ? { sharerSeat } : {}),
              createdAt: now,
              hand,
            },
          });
          return { id };
        },
        log,
      ),
    );
    on('hand:unshare', (input, ack) =>
      guarded(
        ack,
        async () => {
          if (!(await sharedStore.remove(String(input?.id ?? ''), me))) throw new ActionError('that link is not one of yours');
        },
        log,
      ),
    );

    on('seat:request', (input, ack) =>
      guarded(
        ack,
        async () => {
          current().requestSeat(me, { seat: Number(input?.seat), name: String(input?.name ?? ''), stack: Number(input?.stack), consent: input?.consent === true });
          // The name you sit with is the name you register for tournaments with.
          if (!socket.data.session.displayName) await rename(input?.name).catch(() => {});
        },
        log,
      ),
    );
    on('seat:cancel', () => guarded(undefined, () => current().cancelRequest(me), log));
    on('seat:stand', (input) => guarded(undefined, () => current().stand(me, { afterHand: !!input?.afterHand }), log));
    on('seat:sitOut', ({ value }, ack) => guarded(ack, () => current().sitOut(me, !!value), log));
    on('seat:prefs', (prefs, ack) => guarded(ack, () => current().setPreferences(me, prefs ?? {}), log));
    on('seat:rebuy', ({ amount }, ack) => guarded(ack, () => current().rebuy(me, Number(amount)), log));
    on('waitlist:join', (input, ack) =>
      guarded(
        ack,
        async () => {
          current().joinWaitlist(me, { name: String(input?.name ?? ''), stack: Number(input?.stack) });
          if (!socket.data.session.displayName) await rename(input?.name).catch(() => {});
        },
        log,
      ),
    );
    on('waitlist:leave', (ack) => guarded(ack, () => current().leaveWaitlist(me), log));

    // A move carries the turn it was pressed on (TurnKey), checked apart from the move itself so it never reaches the engine.
    on('hand:act', (action, ack) => guarded(ack, () => current().act(me, sanitizeAction(action), turnOf(action)), log));
    on('hand:draw', (input, ack) => guarded(ack, () => current().draw(me, toIndexes(input?.discard), turnOf(input)), log));
    on('hand:runItTwice', (input, ack) => guarded(ack, () => current().voteRunItTwice(me, !!input?.yes, { handNumber: turnOf(input).handNumber }), log));
    on('hand:show', (input, ack) => guarded(ack, () => current().show(me, toIndexes(input?.cards), { handNumber: turnOf(input).handNumber }), log));
    on('hand:timeBank', (...args) => {
      // The ack comes last; a page from before turn keys sends nothing before it.
      const ack = args.at(-1) as Ack;
      return guarded(ack, () => current().useTimeBank(me, turnOf(args.length > 1 ? args[0] : undefined)), log);
    });
    on('hand:rabbit', (ack) =>
      guarded(
        ack,
        () => {
          const rt = current();
          // Checked first, the same answer at any moment: the live hand's end would tell a spectator on a delay what is coming.
          if (rt.settings.spectators.delaySeconds > 0 && isSpectator(rt, socket)) throw new ActionError('spectators on a delay can’t rabbit hunt');
          rt.rabbitHunt(me);
        },
        log,
      ),
    );
    on('hand:tip', (input, ack) =>
      guarded(
        ack,
        () => {
          const handNumber = Number(input?.handNumber);
          const at = Number(input?.at);
          if (!Number.isSafeInteger(handNumber) || !Number.isSafeInteger(at)) throw new ActionError('that turn is over');
          // Only a tip that is about to be worked out counts: a refused request, or one already cached for this turn, costs
          // nothing.
          let spent = (_ms: number) => {};
          let started = 0;
          const tip = current().coachTip(me, handNumber, at, () => {
            spent = tips.admit(me);
            started = performance.now();
          });
          spent(performance.now() - started);
          return { tip };
        },
        log,
      ),
    );
    on('fair:seed', (input, ack) => guarded(ack, () => current().addClientSeed(me, input ?? {}), log));
    on('notes:list', (ack) => guarded(ack, async () => ({ notes: await notes.list(me) }), log));
    on('notes:set', (input, ack) =>
      guarded(
        ack,
        async () => {
          const note = await notes.set(me, cleanNote(input));
          // Every tab of mine gets the new list; nobody else ever sees it.
          const all = await notes.list(me);
          for (const s of playerSockets.get(me) ?? []) s.emit('notes', all);
          return { note };
        },
        log,
      ),
    );
    // Saved setups live on the account; a guest's stay in their browser, so nothing is kept for a browser that may be thrown away.
    const signedIn = () => {
      if (!socket.data.session.account) throw new ActionError('sign in to keep setups on your account');
    };
    const pushSetups = async (kind: SetupKind) => {
      const all = await setups.list(me, kind);
      for (const s of playerSockets.get(me) ?? []) s.emit('setups', { kind, setups: all });
    };
    on('setups:list', (input, ack) =>
      guarded(
        ack,
        async () => {
          signedIn();
          return { setups: await setups.list(me, cleanKind(input?.kind)) };
        },
        log,
      ),
    );
    on('setups:save', (input, ack) =>
      guarded(
        ack,
        async () => {
          signedIn();
          const kind = cleanKind(input?.kind);
          const setup = cleanSetup(kind, input, clock.now());
          await setups.save(me, kind, setup);
          await pushSetups(kind);
          return { name: setup.name };
        },
        log,
      ),
    );
    on('setups:rename', (input, ack) =>
      guarded(
        ack,
        async () => {
          signedIn();
          const kind = cleanKind(input?.kind);
          const from = String(input?.from ?? '');
          const to = cleanSetupName(input?.to);
          const setup = (await setups.list(me, kind)).find((x) => x.name === from);
          if (!setup) throw new ActionError('that setup is gone');
          if (!(await setups.rename(me, kind, from, renamed(kind, setup, to)))) {
            const gone = !(await setups.list(me, kind)).some((x) => x.name === from);
            throw new ActionError(gone ? 'that setup is gone' : `you already have one called “${to}”`);
          }
          await pushSetups(kind);
          return { name: to };
        },
        log,
      ),
    );
    on('setups:delete', (input, ack) =>
      guarded(
        ack,
        async () => {
          signedIn();
          const kind = cleanKind(input?.kind);
          await setups.remove(me, kind, String(input?.name ?? ''));
          await pushSetups(kind);
        },
        log,
      ),
    );
    on('setups:import', (input, ack) =>
      guarded(
        ack,
        async () => {
          signedIn();
          const kind = cleanKind(input?.kind);
          const list = Array.isArray(input?.setups) ? input.setups.slice(0, SETUPS_PER_KIND) : [];
          const existing = await setups.list(me, kind);
          const taken = new Set(existing.map((x) => x.name));
          let added = 0;
          // The names (as sent) the account now holds, so the browser forgets only those.
          const kept: string[] = [];
          for (const raw of list) {
            let setup: SavedSetup;
            try {
              setup = cleanImportedSetup(kind, raw, clock.now());
            } catch {
              continue;
            }
            const sent = String((raw as SavedSetup).name);
            // The same setup saved twice (two tabs bringing it over) is kept once.
            if (existing.some((x) => x.name === setup.name && x.json === setup.json)) {
              kept.push(sent);
              continue;
            }
            // A numbered table preset carries its new name inside too, so its export file says so.
            const name = freeName(setup.name, taken);
            if (name !== setup.name) setup = renamed(kind, setup, name);
            try {
              await setups.save(me, kind, setup);
            } catch {
              // Full: the rest stay in the browser.
              break;
            }
            taken.add(setup.name);
            kept.push(sent);
            added++;
          }
          if (added) await pushSetups(kind);
          return { added, kept };
        },
        log,
      ),
    );
    on('chat:send', (input, ack) =>
      guarded(
        ack,
        () => {
          const rt = current();
          const now = clock.now();
          const recent = (chatTimes.get(me) ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
          if (recent.length >= CHAT_BURST) throw new ActionError('slow down a little');
          rt.chat(me, String(input?.text ?? ''));
          chatTimes.set(me, [...recent, now]);
        },
        log,
      ),
    );
    on('table:gesture', (input, ack) =>
      guarded(
        ack,
        () => {
          const rt = current();
          const kind = String(input?.kind ?? '') as GestureKind;
          if (!GESTURES.includes(kind)) throw new ActionError('unknown gesture');
          const to = String(input?.to ?? '');
          rt.checkGesture(me, to);
          const now = clock.now();
          const recent = (gestureTimes.get(me) ?? []).filter((t) => now - t < GESTURE_WINDOW_MS);
          if (recent.length >= GESTURE_BURST) throw new ActionError('easy there: a few seconds between gestures');
          gestureTimes.set(me, [...recent, now]);
          for (const s of watchers.get(rt.state.id) ?? []) s.emit('table:gesture', { from: me, to, kind, at: now });
        },
        log,
      ),
    );
    on('avatar:set', (input, ack) =>
      guarded(
        ack,
        async () => {
          const next = cleanAvatar(input);
          const now = clock.now();
          const recent = (avatarChanges.get(me) ?? []).filter((t) => now - t < AVATAR_WINDOW_MS);
          if (recent.length >= AVATAR_BURST) throw new ActionError('too many picture changes; try again in a moment');
          avatarChanges.set(me, [...recent, now]);
          const saved = await avatarStore.set(me, next);
          const avatar = avatarToken(saved);
          avatars.set(me, avatar);
          // Every tab of mine learns it, and every table I'm at shows it.
          const shown = new Set<string>();
          for (const s of playerSockets.get(me) ?? []) {
            s.data.session = { ...s.data.session, avatar };
            s.emit('session', s.data.session);
            if (s.data.tableId) shown.add(s.data.tableId);
          }
          for (const rt of tables.values()) if (rt.seatOf(me)) shown.add(rt.state.id);
          for (const id of shown) {
            const rt = tables.get(id);
            if (rt) broadcast(rt);
          }
          return { avatar };
        },
        log,
      ),
    );

    on('host:approve', ({ requestId, seat }, ack) => guarded(ack, () => current().approve(me, String(requestId), seat === undefined || seat === null ? undefined : Number(seat)), log));
    on('host:reject', ({ requestId }) => guarded(undefined, () => current().reject(me, String(requestId)), log));
    on('host:start', (ack) => guarded(ack, () => current().start(me), log));
    on('host:stop', (ack) => guarded(ack, () => current().stop(me), log));
    on('host:deleteTable', (ack) =>
      guarded(
        ack,
        async () => {
          const rt = current();
          rt.checkDeletable(me);
          log(`table ${rt.state.id} deleted by its host`);
          await removeTable(rt.state.id);
          audit.deleted(rt.state.id, 'host');
        },
        log,
      ),
    );
    on('host:deal', (ack) => guarded(ack, () => current().dealNext(me), log));
    on('host:pause', ({ value }, ack) => guarded(ack, () => current().pause(me, !!value), log));
    on('host:bombPot', ({ value }, ack) => guarded(ack, () => current().requestBombPot(me, !!value), log));
    on('host:settings', ({ patch }, ack) => guarded(ack, () => current().updateSettings(me, patch ?? {}), log));
    on('host:setStack', ({ playerId, stack }, ack) => guarded(ack, () => current().setStack(me, String(playerId), Number(stack)), log));
    on('host:kick', ({ playerId }, ack) => guarded(ack, () => current().kick(me, String(playerId)), log));
    on('host:sitOut', ({ playerId }, ack) => guarded(ack, () => current().hostSitOut(me, String(playerId)), log));
    on('host:transfer', ({ playerId }, ack) => guarded(ack, () => current().transferHost(me, String(playerId)), log));
    on('host:shuffle', (ack) => guarded(ack, () => current().shuffleSeats(me), log));
    on('host:move', ({ playerId, seat }, ack) => guarded(ack, () => current().moveSeat(me, String(playerId), Number(seat)), log));
    on('host:coHost', (input, ack) => guarded(ack, () => current().setCoHost(me, String(input?.playerId ?? ''), input?.powers), log));
    on('host:removeCoHost', (input, ack) => guarded(ack, () => current().removeCoHost(me, String(input?.playerId ?? '')), log));
    on('host:mute', ({ playerId, value }, ack) => guarded(ack, () => current().mute(me, String(playerId), !!value), log));
    on('bot:add', (input, ack) =>
      guarded(
        ack,
        () => {
          const seat = input?.seat === undefined || input?.seat === null ? undefined : Number(input.seat);
          const level = input?.level === undefined || input?.level === null ? undefined : (String(input.level) as BotLevel);
          return { playerId: current().addBot(me, { ownerName: socket.data.session.displayName, seat, level }) };
        },
        log,
      ),
    );
    on('bot:remove', (input, ack) => guarded(ack, () => current().removeBot(me, String(input?.playerId ?? '')), log));
    on('bot:level', (input, ack) => guarded(ack, () => current().setBotLevel(me, String(input?.playerId ?? ''), String(input?.level ?? '') as BotLevel), log));

    on('tournament:create', (input, ack) =>
      guarded(
        ack,
        async () => {
          const address = socketAddress(socket);
          const tooMany = () => new ActionError('that is a lot of new tournaments; try again in a few minutes');
          // Asked first without counting, so someone past both limits hears about this one. It's counted only once
          // the open limit lets it through, so being told to archive one costs nothing; one that fails after that
          // (a season that isn't there) still counts, so a script can't look up seasons for free.
          if (!tournamentCreates(me, address, false)) throw tooMany();
          const made = await openTournaments(me, address, async () => {
            if (!tournamentCreates(me, address)) throw tooMany();
            return tournaments.create(me, input?.settings);
          });
          if ('id' in made) return made;
          if (made.full === 'player') throw new ActionError('that is a lot of open tournaments; archive one you made, or wait for one to finish');
          // Only their address is full (a club's or an office's Wi-Fi, say): they may have made none to archive.
          throw new ActionError('too many tournaments are open from your network right now; try again once one finishes');
        },
        log,
      ),
    );
    on('tournament:subscribe', (input, ack) =>
      guarded(
        ack,
        async () => {
          const id = String(input?.id ?? '');
          if (!(await tournaments.get(id))) throw new ActionError('tournament not found');
          // Closed while the tournament loaded: nothing to send it to.
          if (socket.disconnected) return;
          if (!tournamentWatchers.has(id)) tournamentWatchers.set(id, new Set());
          tournamentWatchers.get(id)!.add(socket);
          socket.data.tournaments.add(id);
          socket.emit('tournament:state', { id, view: tournaments.view(id, me)! });
          const items = await lobby.items(id);
          // Items added while this loaded reach the socket as appends, which the browser skips if it has them.
          if (socket.data.tournaments.has(id)) socket.emit('tournament:log', { id, items, append: false });
        },
        log,
      ),
    );
    on('tournament:unsubscribe', (input) => {
      const id = String(input?.id ?? '');
      tournamentWatchers.get(id)?.delete(socket);
      socket.data.tournaments.delete(id);
    });
    on('tournament:chat', (input, ack) =>
      guarded(
        ack,
        async () => {
          const id = String(input?.id ?? '');
          const name = socket.data.session.displayName;
          if (!name) throw new ActionError('pick a name first');
          const text = Array.from(
            String(input?.text ?? '')
              .replace(/\p{Cs}/gu, '')
              .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
              .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
              .replace(/(\p{M}{3})\p{M}+/gu, '$1')
              .trim(),
          )
            .slice(0, LOBBY_CHAT_MAX)
            .join('')
            .trim();
          if (!text) return;
          // Only from a tab with the lobby (or its table strip) open.
          if (!socket.data.tournaments.has(id)) throw new ActionError('open the tournament first');
          const now = clock.now();
          // Per player, so more tabs don't mean more messages.
          if (now - (lastLobbyChat.get(me) ?? 0) < LOBBY_CHAT_GAP_MS) throw new ActionError('slow down a little');
          lastLobbyChat.set(me, now);
          addToLobby(id, [{ at: now, kind: 'chat', playerId: me, name, text }]);
        },
        log,
      ),
    );
    on('tournament:list', (ack) => guarded(ack, async () => ({ tournaments: await tournaments.list(me), serverNow: clock.now() }), log));
    on('season:get', (input, ack) =>
      guarded(
        ack,
        async () => {
          const board = await tournaments.season(String(input?.id ?? ''));
          if (!board) throw new ActionError('season not found');
          return { board };
        },
        log,
      ),
    );
    on('season:mine', (_input, ack) => guarded(ack, async () => ({ seasons: await tournaments.hostSeasons(me) }), log));
    on('tournament:command', (input, ack) => guarded(ack, () => tournaments.command(String(input?.id ?? ''), me, socket.data.session.displayName, input?.command), log));

    socket.on('disconnect', () => {
      leave();
      for (const id of socket.data.tournaments) tournamentWatchers.get(id)?.delete(socket);
      playerSockets.get(me)?.delete(socket);
      if (!playerSockets.get(me)?.size) {
        playerSockets.delete(me);
        gestureTimes.delete(me);
        chatTimes.delete(me);
        tips.forget(me);
        avatarChanges.delete(me);
        lastLobbyChat.delete(me);
      }
    });
  });

  return {
    app,
    http,
    io,
    tables,
    tournaments,
    getTable,
    /** Puts away idle cash tables now (the server also does this every few minutes); the ids put away. */
    unloadIdle,
    /** Brings back unfinished tournaments (and their tables) after a restart. */
    resume: () => tournaments.resumeAll(),
    /** Forgets addresses the limits no longer need now (the server also does this every few minutes). */
    forgetOldAddresses,
    /** How many addresses the open-tournament limit remembers now. */
    openTournamentAddresses: () => openTournaments.addresses(),
    async close() {
      // Everything goes quiet before anything is saved, so tournaments and their tables are saved as of the same moment:
      // no more input, the director acts on every hand already reported, and no table deals, runs a clock or saves again.
      // The server going down is not players leaving, so their tables never see them drop (and time them out).
      for (const s of io.of('/').sockets.values()) s.removeAllListeners('disconnect');
      io.close();
      stopBackup();
      await backup;
      tournaments.dispose();
      if (sweep) clearInterval(sweep);
      await Promise.allSettled([...unloading.values()]);
      const open = [...tables.values()];
      for (const rt of open) rt.dispose();
      for (const t of saveTimers.values()) clearTimeout(t);
      saveTimers.clear();
      await tournaments.flush();
      await lobby.flush();
      await Promise.all(open.map((rt) => (created.get(rt.state.id) ?? Promise.resolve()).then(() => store.saveTable(rt.state)).catch(() => {})));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await audit.flush();
    },
  };
}

/**
 * The error handler behind every route. A request the client got wrong (a body too big or not JSON, which
 * express.json and express.static mark with a 4xx status and `expose`) is answered with that status and a
 * short JSON error, and not logged. Anything else is logged once and answered 500, without its details.
 */
export function requestFailed(log: (message: string, err?: unknown) => void): express.ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500 && err?.expose !== false) {
      res.status(status).json({ error: status === 413 ? 'That request is too large.' : 'That request could not be read.' });
      return;
    }
    // The route's pattern, not the address: an address can hold a table's or a hand's link.
    log(`${req.method} ${req.route?.path ?? 'request'} failed`, err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  };
}

/** How long /api/health waits for the database before calling it slow: well inside Fly's 5 s health check timeout. */
export const DB_HEALTH_MS = 1_000;

/**
 * Whether the database answers: 'ok', 'slow' (no answer within DB_HEALTH_MS)
 * or 'error'. A check still waiting is shared, so a stuck database doesn't
 * pile up a query for every health check. Logs only when the answer changes.
 */
export function databaseHealth(check: () => Promise<unknown>, log: (message: string, err?: unknown) => void) {
  let pending: Promise<'ok' | 'error'> | null = null;
  let last: 'ok' | 'slow' | 'error' = 'ok';
  return async (): Promise<'ok' | 'slow' | 'error'> => {
    pending ??= check().then(
      () => 'ok' as const,
      (err: unknown) => {
        if (last !== 'error') log('database health check failed', err);
        return 'error' as const;
      },
    );
    const mine = pending;
    void mine.finally(() => {
      if (pending === mine) pending = null;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), DB_HEALTH_MS);
    });
    const now = await Promise.race([mine, slow]);
    clearTimeout(timer);
    if (now === 'slow' && last !== 'slow') log(`database health check: no answer within ${DB_HEALTH_MS} ms`);
    if (now === 'ok' && last !== 'ok') log('database health check: answering again');
    last = now;
    return now;
  };
}

function toIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) throw new ActionError('pick some cards');
  return value.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0 && v < 10);
}

/**
 * The turn a move was sent for, as the runtime checks it: each part a whole
 * number, like hand:tip's. A part left out (or null) is not checked; any
 * other part that isn't a whole number becomes NaN, which matches no turn.
 */
function turnOf(input: unknown): TurnKey {
  const x = (input ?? {}) as { handNumber?: unknown; at?: unknown };
  const part = (v: unknown) => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : NaN;
  };
  const handNumber = part(x.handNumber);
  const at = part(x.at);
  return { ...(handNumber !== undefined ? { handNumber } : {}), ...(at !== undefined ? { at } : {}) };
}

function sanitizeAction(action: unknown) {
  const a = (action ?? {}) as { type?: unknown; to?: unknown };
  switch (a.type) {
    case 'fold':
    case 'check':
    case 'call':
    case 'bring-in':
      return { type: a.type } as const;
    case 'bet':
    case 'raise':
      return { type: a.type, to: Number(a.to) } as const;
    default:
      throw new ActionError('unknown action');
  }
}
