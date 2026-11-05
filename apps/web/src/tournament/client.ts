// How tournament pages talk to the server. SocketTournamentClient is the real
// one; LocalTournamentClient runs the same director in this tab so the pages
// can be tried on their own (open any page with ?demo).

import {
  apply,
  createTournament,
  DirectorError,
  nextWakeAt,
  tableGate,
  tick,
  tournamentListing,
  sortListings,
  type Command,
  type LobbyItem,
  type TournamentListing,
  type TournamentSettings,
  type TournamentState,
  type TournamentTableChat,
  type TournamentView,
} from '@rsdp/tournament';
import { call, currentSession, NoAnswerError, onSession, setName, socket, type Session } from '../socket';

export type { Session, TournamentListing, TournamentView };

export interface TournamentList {
  tournaments: TournamentListing[];
  serverNow: number;
}

export interface TournamentClient {
  session(): Session | null;
  onSession(cb: (s: Session | null) => void): () => void;
  /** The name other players see; registering needs one. */
  setName(name: string): Promise<void>;
  /** Calls onView with the current view and again on every change. */
  subscribe(id: string, onView: (v: TournamentView) => void, onError: (message: string) => void): () => void;
  /** Rejects with the server's message when the command is refused. */
  send(id: string, command: Command): Promise<void>;
  create(settings: TournamentSettings): Promise<string>;
  /** Upcoming and running events, and the viewer's own. */
  list(): Promise<TournamentList>;
  /** Lobby chat and events of a tournament being followed (see subscribe): now and on every change. */
  onLog(id: string, cb: (items: LobbyItem[]) => void): () => void;
  chat(id: string, text: string): Promise<void>;
  /** Once the tournament is over: every table's chat and log (host, co-hosts and players only). */
  tableChat(id: string): Promise<TournamentTableChat[]>;
}

/** Tournaments run on the server; this tab follows the ones on screen. */
export class SocketTournamentClient implements TournamentClient {
  private watchers = new Map<string, { onView: Set<(v: TournamentView) => void>; onError: Set<(m: string) => void>; last: TournamentView | null }>();
  /** Lobby items per followed tournament, and who wants them. */
  private logs = new Map<string, { items: LobbyItem[]; listeners: Set<(items: LobbyItem[]) => void> }>();

  constructor() {
    socket.on('tournament:state', ({ id, view }) => {
      const w = this.watchers.get(id);
      if (!w) return;
      w.last = view;
      w.onView.forEach((cb) => cb(view));
    });
    socket.on('tournament:log', ({ id, items, append }) => {
      const log = this.logs.get(id);
      if (!log) return;
      if (append) {
        const have = new Set(log.items.map((x) => x.id));
        log.items = [...log.items, ...items.filter((x) => !have.has(x.id))];
      } else {
        // The full list may be older than appends that beat it here.
        const fresh = new Set(items.map((x) => x.id));
        log.items = [...items, ...log.items.filter((x) => !fresh.has(x.id) && x.at >= (items.at(-1)?.at ?? 0))];
      }
      log.listeners.forEach((cb) => cb(log.items));
    });
    // The server forgets what a socket followed when it drops.
    socket.on('connect', () => {
      for (const id of this.watchers.keys()) this.follow(id);
    });
  }

  session() {
    return currentSession();
  }

  onSession(cb: (s: Session | null) => void) {
    return onSession(cb);
  }

  setName(name: string) {
    return setName(name);
  }

  subscribe(id: string, onView: (v: TournamentView) => void, onError: (message: string) => void) {
    let w = this.watchers.get(id);
    if (!w) {
      w = { onView: new Set(), onError: new Set(), last: null };
      this.watchers.set(id, w);
      // The server sends the lobby log right after the first view.
      if (!this.logs.has(id)) this.logs.set(id, { items: [], listeners: new Set() });
      if (socket.connected) this.follow(id);
    } else if (w.last) onView(w.last);
    w.onView.add(onView);
    w.onError.add(onError);
    const mine = w;
    return () => {
      mine.onView.delete(onView);
      mine.onError.delete(onError);
      if (mine.onView.size === 0 && this.watchers.get(id) === mine) {
        this.watchers.delete(id);
        socket.emit('tournament:unsubscribe', { id });
      }
    };
  }

  async send(id: string, command: Command) {
    await call('tournament:command', { id, command });
  }

  async create(settings: TournamentSettings) {
    const { id } = await call<{ id: string }>('tournament:create', { settings });
    return id;
  }

  list() {
    return call<TournamentList>('tournament:list');
  }

  onLog(id: string, cb: (items: LobbyItem[]) => void) {
    let log = this.logs.get(id);
    if (!log) {
      log = { items: [], listeners: new Set() };
      this.logs.set(id, log);
    }
    const mine = log;
    mine.listeners.add(cb);
    cb(mine.items);
    return () => {
      mine.listeners.delete(cb);
    };
  }

  async chat(id: string, text: string) {
    await call('tournament:chat', { id, text });
  }

  async tableChat(id: string) {
    return (await call<{ tables: TournamentTableChat[] }>('tournament:tableChat', { id })).tables;
  }

  private follow(id: string) {
    call('tournament:subscribe', { id }).catch((e: Error) => {
      // One lost to a dropped connection is sent again when it comes back.
      if (e instanceof NoAnswerError) return;
      this.watchers.get(id)?.onError.forEach((cb) => cb(e.message === 'tournament not found' ? 'Tournament not found' : e.message));
    });
  }
}

// ---------------------------------------------------------------------------

const STORE_KEY = 'rsdp.localTournaments';
const GUEST_KEY = 'rsdp.demoPlayer';

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function randomId(bytes = 8): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Runs @rsdp/tournament in this tab. Tournaments are saved to localStorage so
 * a refresh keeps them, and a 1 s timer calls tick whenever nextWakeAt passes.
 * Demo helpers add test players and play hands, since there are no tables yet.
 */
export class LocalTournamentClient implements TournamentClient {
  private states = new Map<string, TournamentState>();
  private listeners = new Map<string, Set<(v: TournamentView) => void>>();
  private sessionListeners = new Set<(s: Session | null) => void>();
  private me: Session;
  private rng = (Date.now() >>> 0) | 1;

  constructor() {
    const store = storage();
    try {
      const saved = JSON.parse(store?.getItem(STORE_KEY) ?? '{}') as Record<string, TournamentState>;
      for (const [id, s] of Object.entries(saved)) this.states.set(id, s);
    } catch {
      /* start empty */
    }
    let guest = store?.getItem(GUEST_KEY) ?? null;
    if (!guest) {
      guest = randomId();
      store?.setItem(GUEST_KEY, guest);
    }
    this.me = { playerId: guest, displayName: store?.getItem('rsdp.name') || 'You', account: null };
    setInterval(() => this.wake(), 1000);
  }

  session() {
    return this.me;
  }

  onSession(cb: (s: Session | null) => void) {
    this.sessionListeners.add(cb);
    return () => this.sessionListeners.delete(cb);
  }

  async setName(name: string) {
    this.actAs(this.me.playerId, name.trim());
  }

  /** Demo: act as another player (or the host) in this tab. */
  actAs(playerId: string, displayName: string) {
    this.me = { playerId, displayName, account: null };
    this.sessionListeners.forEach((cb) => cb(this.me));
    this.states.forEach((_, id) => this.emit(id));
  }

  subscribe(id: string, onView: (v: TournamentView) => void, onError: (message: string) => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(onView);
    this.listeners.set(id, set);
    const s = this.states.get(id);
    if (s) onView({ state: s, serverNow: Date.now() });
    else onError('Tournament not found');
    return () => set.delete(onView);
  }

  async send(id: string, command: Command) {
    const s = this.states.get(id);
    if (!s) throw new Error('Tournament not found');
    try {
      this.commit(id, apply(s, command, Date.now()).state);
    } catch (e) {
      throw new Error(e instanceof DirectorError ? e.message : String(e));
    }
  }

  async create(settings: TournamentSettings) {
    const id = randomId(4);
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    try {
      this.commit(id, createTournament({ id, hostId: this.me.playerId, settings, now: Date.now(), seed }));
    } catch (e) {
      throw new Error(e instanceof DirectorError ? e.message : String(e));
    }
    return id;
  }

  /** Demo: register `count` test players. */
  async addTestPlayers(id: string, count: number) {
    const s = this.states.get(id)!;
    const n = s.entries.length + s.requests.length;
    for (let i = 0; i < count; i++) {
      const k = n + i + 1;
      await this.send(id, { type: 'register', playerId: `test-${k}`, displayName: `Player ${k}` }).catch(() => {});
    }
  }

  /** Demo: play one hand on every table that may deal; some players bust. */
  playHands(id: string) {
    let s = this.states.get(id)!;
    for (const t of s.tables) {
      if (tableGate(s, t.id, Date.now()) !== 'deal') continue;
      const players = t.seats.filter((x): x is string => !!x).map((eid) => s.entries.find((e) => e.id === eid)!);
      const startStacks = Object.fromEntries(players.map((e) => [e.playerId, e.stack]));
      const endStacks = { ...startStacks };
      const winner = players[Math.floor(this.random() * players.length)];
      const knockedOutBy: Record<string, string[]> = {};
      for (const p of players) {
        if (p === winner) continue;
        const r = this.random();
        // Everyone else pays a little; about one in eight goes all in and loses.
        const loss = r < 0.12 ? endStacks[p.playerId] : Math.min(endStacks[p.playerId], Math.floor(endStacks[p.playerId] * r * 0.15));
        endStacks[p.playerId] -= loss;
        endStacks[winner.playerId] += loss;
        if (endStacks[p.playerId] === 0) knockedOutBy[p.playerId] = [winner.playerId];
      }
      const handNumber = t.lastHandNumber + 1;
      const button = t.seats.findIndex((x, i) => x && i > (t.button ?? -1));
      s = apply(s, { type: 'handStarted', tableId: t.id, handNumber }, Date.now()).state;
      s = apply(s, { type: 'handResult', result: { tableId: t.id, handNumber, startStacks, endStacks, knockedOutBy, button: button >= 0 ? button : t.seats.findIndex(Boolean) } }, Date.now()).state;
    }
    this.commit(id, s);
  }

  /** Demo: move the tournament clock forward, as if `ms` had passed. */
  skipAhead(id: string, ms: number) {
    const s = structuredClone(this.states.get(id)!);
    if (s.startAt !== null && (s.status === 'registering' || s.status === 'seating')) s.startAt -= ms;
    if (s.graceUntil !== null) s.graceUntil -= ms;
    if (s.clock.runningSince !== null) s.clock.runningSince -= ms;
    for (const e of s.entries) if (e.rebuyOfferExpiresAt !== undefined) e.rebuyOfferExpiresAt -= ms;
    this.commit(id, tick(s, Date.now()).state);
  }

  remove(id: string) {
    this.states.delete(id);
    this.save();
  }

  onLog(_id: string, cb: (items: LobbyItem[]) => void) {
    // Test mode has no lobby chat or log.
    cb([]);
    return () => {};
  }

  async chat() {
    throw new Error('Chat needs the server');
  }

  async tableChat(): Promise<TournamentTableChat[]> {
    throw new Error('Table chat needs the server');
  }

  async list(): Promise<TournamentList> {
    const now = Date.now();
    return { tournaments: sortListings([...this.states.values()].map((s) => tournamentListing(s, this.me.playerId, now))), serverNow: now };
  }

  private random() {
    // xorshift; demo only.
    this.rng ^= this.rng << 13;
    this.rng ^= this.rng >>> 17;
    this.rng ^= this.rng << 5;
    return (this.rng >>> 0) / 4294967296;
  }

  private wake() {
    const now = Date.now();
    for (const [id, s] of this.states) {
      const at = nextWakeAt(s);
      if (at !== null && at <= now) this.commit(id, tick(s, now).state);
    }
  }

  private commit(id: string, s: TournamentState) {
    this.states.set(id, s);
    this.save();
    this.emit(id);
  }

  private emit(id: string) {
    const s = this.states.get(id);
    if (s) this.listeners.get(id)?.forEach((cb) => cb({ state: s, serverNow: Date.now() }));
  }

  private save() {
    try {
      storage()?.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(this.states)));
    } catch {
      /* storage full or blocked */
    }
  }
}

let client: TournamentClient | null = null;

/** Test mode (?demo) keeps tournaments in this browser; it sticks for the tab. */
function demoMode(): boolean {
  try {
    if (new URLSearchParams(location.search).has('demo')) sessionStorage.setItem('rsdp.demo', '1');
    return sessionStorage.getItem('rsdp.demo') === '1';
  } catch {
    return false;
  }
}

/** The client the pages use. */
export function tournamentClient(): TournamentClient {
  client ??= demoMode() ? new LocalTournamentClient() : new SocketTournamentClient();
  return client;
}
