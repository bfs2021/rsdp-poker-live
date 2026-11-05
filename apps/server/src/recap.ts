// The operator's game-night recap (docs/DEPLOY.md, "Game-night recap"): what broke, what restarted, how much was
// played, and what players said that sounds like a problem, over a window of time. The server's error lines are kept
// here for 30 days (ops_log) as well as in Fly's log, which forgets them within days. Read-only: the route takes the
// admin key or the read-only report key, and changes nothing.

import { sql } from 'drizzle-orm';
import type express from 'express';
import type { AdminCheck } from './admin';
import { withoutLinks, oneLine } from './clientErrors';
import { errorText, queryRows, type Db, schema } from './db';
import type { OpsKind } from './db/schema';

/** How long error lines are kept. */
export const OPS_KEEP_DAYS = 30;
/** Longest window one recap covers. */
export const RECAP_MAX_HOURS = 7 * 24;
/** Longest line kept. */
export const OPS_MESSAGE_MAX = 500;
/** Most chat lines one recap returns. */
const CHAT_MAX = 200;
/** Lines one server start may write per hour, so a fault looping in a hot path can't fill the disk. */
const OPS_PER_HOUR = 2_000;
/** A restart counts as clean when the server said it was stopping at most this long before it started again. */
const CLEAN_GAP_MS = 15 * 60_000;

/** Words that make a chat line worth a look: problems with the site, not poker talk. Kept loose on purpose. */
const PROBLEM_WORDS =
  /\b(bug\w*|glitch\w*|froze|frozen|freez\w*|lag\w*|stuck|broke\w*|crash\w*|errors?|disconnect\w*|kicked|refresh\w*|reload\w*|wrong|weird|not working|doesn'?t work|didn'?t work|won'?t (load|let|work)|can'?t (see|click|join|sit|bet|act|hear)|timer|timed? out|missing|disappear\w*|vanish\w*|blank|white screen|spinning|loading|site|app)\b/i;

/** Whether a chat line sounds like someone reporting a problem with the site. */
export const soundsLikeAProblem = (text: string) => PROBLEM_WORDS.test(text);

/**
 * Table, tournament and hand ids are their invite links: a server line names them bare ("saving table Ab3_x9KqLm
 * failed"). Any word of 8 or more id characters with both a letter and a digit (and a tournament table's ":t2") goes.
 */
const BARE_ID = /(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{8,}(?::t\d+)?(?![\w-])/g;
export const withoutIds = (text: string) => text.replace(BARE_ID, ':id');

/** One line as kept: a single line, links and ids reduced to their kind, cut to OPS_MESSAGE_MAX. */
export function opsLine(message: string, err?: unknown): string {
  const reason = err === undefined || err === '' ? '' : `: ${errorText(err)}`;
  const text = oneLine(withoutIds(withoutLinks(`${message}${reason}`)));
  return text.length <= OPS_MESSAGE_MAX ? text : `${text.slice(0, OPS_MESSAGE_MAX - 1)}…`;
}

export interface OpsRecorder {
  /** Keeps one line (written behind; a failed write is dropped, never logged again). */
  record(kind: Exclude<OpsKind, 'stop'>, message: string, err?: unknown): void;
  /** Writes the clean-shutdown line and waits for every line before it. */
  stopping(): Promise<void>;
  /** Keeps the error the server is stopping for, with no clean-shutdown line, and waits for every line before it. */
  crashing(err: unknown): Promise<void>;
}

/** Keeps error lines in ops_log; with no database it keeps nothing. Lines older than OPS_KEEP_DAYS go at start and every 6 hours. */
export function opsRecorder(db: Db | null | undefined, now: () => number): OpsRecorder {
  if (!db) return { record() {}, async stopping() {}, async crashing() {} };
  let pending: Promise<unknown> = Promise.resolve();
  const prune = () => {
    pending = pending.then(() => db.execute(sql`delete from ops_log where at < ${new Date(now() - OPS_KEEP_DAYS * 86_400_000)}`)).catch(() => {});
  };
  prune();
  // And every few hours, so a server that runs for weeks still keeps lines only 30 days.
  setInterval(prune, 6 * 3_600_000).unref();
  let hour = 0;
  let written = 0;
  const write = (kind: OpsKind, message: string) => {
    const at = new Date(now());
    // In order, one after another: a burst of errors never holds more than one connection.
    pending = pending.then(() => db.insert(schema.opsLog).values({ at, kind, message })).catch(() => {});
    return pending;
  };
  return {
    record(kind, message, err) {
      const h = Math.floor(now() / 3_600_000);
      if (h !== hour) ((hour = h), (written = 0));
      if (++written > OPS_PER_HOUR) return;
      void write(kind, opsLine(message, err));
    },
    async stopping() {
      await write('stop', 'server stopping');
    },
    async crashing(err) {
      await write('server', opsLine('server stopping after an uncaught error', err));
    },
  };
}

export interface Recap {
  from: string;
  to: string;
  /** No hand was dealt in the window. */
  quiet: boolean;
  restarts: { at: string; commit: string | null; clean: boolean }[];
  /** Grouped by message, most frequent first (at most 200). Lines past the hourly cap were never kept. */
  errors: {
    kind: 'server' | 'browser';
    message: string;
    count: number;
    first: string;
    last: string;
  }[];
  activity: {
    hands: number;
    cashTables: number;
    tournamentTables: number;
    cashHands: number;
    tournamentHands: number;
  };
  tournaments: {
    name: string;
    status: string;
    start: string;
    entries: number;
    scheduledFor: string | null;
    startedAt: string | null;
    /** Minutes after its scheduled time it dealt, for a scheduled tournament that dealt. */
    lateByMinutes: number | null;
    /** Its deal time passed inside the window and it still hasn't started (or was cancelled). */
    didNotStart: boolean;
    finishedAt: string | null;
  }[];
  /** Chat lines (tables and tournament lobbies) that sound like problem reports, oldest first, without names. */
  chat: {
    at: string;
    where: 'cash table' | 'tournament table' | 'tournament lobby';
    text: string;
  }[];
  chatLinesRead: number;
}

const iso = (v: unknown) => new Date(v as string | number | Date).toISOString();
const num = (v: unknown) => Number(v ?? 0);

/** Everything the recap says about [from, to). */
export async function buildRecap(db: Db, from: Date, to: Date): Promise<Recap> {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const [boots, stops, errors, hands, tourneys, tableChat, lobbyChat] = await Promise.all([
    queryRows<{ at: string; data: { commit?: string | null } }>(
      db,
      // From a little before the window: a stop only counts for the first start after it.
      sql`select at, data from audit_log where kind = 'boot' and at >= ${fromMs - CLEAN_GAP_MS} and at < ${toMs} order by seq`,
    ),
    queryRows<{ at: string }>(db, sql`select at from ops_log where kind = 'stop' and at >= ${new Date(fromMs - CLEAN_GAP_MS)} and at < ${to} order by at`),
    queryRows<{
      kind: 'server' | 'browser';
      message: string;
      count: string;
      first: string;
      last: string;
    }>(
      db,
      sql`select kind, message, count(*) as count, min(at) as first, max(at) as last from ops_log
          where kind <> 'stop' and at >= ${from} and at < ${to} group by kind, message order by count(*) desc, min(at) limit 200`,
    ),
    queryRows<{ mode: string; tables: string; hands: string }>(
      db,
      sql`select t.mode, count(distinct h.table_id) as tables, count(*) as hands from hands h join tables t on t.id = h.table_id
          where h.started_at >= ${from} and h.started_at < ${to} group by t.mode`,
    ),
    queryRows<{ status: string; state: Record<string, unknown> }>(
      db,
      // Open ones too: a scheduled tournament that never started may not have been saved for days.
      sql`select status, state from tournaments where updated_at >= ${from} or status in ('registering', 'seating')`,
    ),
    queryRows<{ at: string; mode: string; item: { text?: unknown } }>(
      db,
      sql`select l.at, t.mode, l.item from table_log l join tables t on t.id = l.table_id
          where l.kind = 'chat' and l.at >= ${from} and l.at < ${to} order by l.n`,
    ),
    queryRows<{ at: string; item: { kind?: unknown; text?: unknown } }>(
      db,
      sql`select at, item from tournament_log where at >= ${from} and at < ${to} and item->>'kind' = 'chat' order by n`,
    ),
  ]);

  const stopTimes = stops.map((s) => new Date(s.at).getTime());
  const restarts: Recap['restarts'] = [];
  let previous = -Infinity;
  for (const b of boots) {
    const at = num(b.at);
    // Clean: the server said it was stopping after the start before this one, shortly before this one.
    const clean = stopTimes.some((s) => s > previous && s <= at && at - s <= CLEAN_GAP_MS);
    if (at >= fromMs) restarts.push({ at: iso(at), commit: b.data?.commit ?? null, clean });
    previous = at;
  }

  const byMode = (mode: string) => hands.find((h) => h.mode === mode);
  const activity = {
    hands: hands.reduce((n, h) => n + num(h.hands), 0),
    cashTables: num(byMode('cash')?.tables),
    tournamentTables: num(byMode('tournament')?.tables),
    cashHands: num(byMode('cash')?.hands),
    tournamentHands: num(byMode('tournament')?.hands),
  };

  const inWindow = (t: unknown) => typeof t === 'number' && t >= fromMs && t < toMs;
  const tournaments: Recap['tournaments'] = [];
  for (const { status, state } of tourneys) {
    const settings = (state.settings ?? {}) as {
      name?: unknown;
      start?: { kind?: unknown; startAt?: unknown };
    };
    const startAt = typeof state.startAt === 'number' ? state.startAt : null;
    const startedAt = typeof state.startedAt === 'number' ? state.startedAt : null;
    const finishedAt = typeof state.finishedAt === 'number' ? state.finishedAt : null;
    if (!inWindow(startAt) && !inWindow(startedAt) && !inWindow(finishedAt)) continue;
    const kind = typeof settings.start?.kind === 'string' ? settings.start.kind : 'unknown';
    const scheduledFor = kind === 'scheduled' && typeof settings.start?.startAt === 'number' ? settings.start.startAt : null;
    tournaments.push({
      name: typeof settings.name === 'string' ? settings.name.slice(0, 80) : 'Tournament',
      status,
      start: kind,
      entries: Array.isArray(state.entries) ? state.entries.length : 0,
      scheduledFor: scheduledFor === null ? null : iso(scheduledFor),
      startedAt: startedAt === null ? null : iso(startedAt),
      lateByMinutes: scheduledFor !== null && startedAt !== null ? Math.round((startedAt - scheduledFor) / 60_000) : null,
      finishedAt: finishedAt === null ? null : iso(finishedAt),
      didNotStart: startAt !== null && startAt < toMs && (startedAt === null || startedAt >= toMs),
    });
  }
  tournaments.sort((a, b) => (a.scheduledFor ?? a.startedAt ?? '').localeCompare(b.scheduledFor ?? b.startedAt ?? ''));

  const lines: Recap['chat'] = [];
  const keep = (at: unknown, where: Recap['chat'][number]['where'], text: unknown) => {
    if (typeof text !== 'string' || !soundsLikeAProblem(text)) return;
    lines.push({
      at: iso(at),
      where,
      text: oneLine(withoutLinks(text)).slice(0, 300),
    });
  };
  for (const c of tableChat) keep(c.at, c.mode === 'tournament' ? 'tournament table' : 'cash table', c.item?.text);
  for (const c of lobbyChat) keep(c.at, 'tournament lobby', c.item?.text);
  lines.sort((a, b) => a.at.localeCompare(b.at));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    quiet: activity.hands === 0,
    restarts,
    errors: errors.map((e) => ({
      kind: e.kind,
      message: e.message,
      count: num(e.count),
      first: iso(e.first),
      last: iso(e.last),
    })),
    activity,
    tournaments,
    chat: lines.slice(-CHAT_MAX),
    chatLinesRead: tableChat.length + lobbyChat.length,
  };
}

/** The window a request asks for: `from` and `to` (ISO times), or the last `hours` (default 24) up to now. */
export function recapWindow(query: Record<string, unknown>, now: number): { from: Date; to: Date } | string {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  const bad = 'from and to must be ISO times with a zone (2026-11-04T23:00:00Z), hours a number above 0.';
  const given = (v: unknown) => v !== undefined && v !== '';
  for (const v of [query.from, query.to]) if (given(v) && (typeof v !== 'string' || !ISO.test(v))) return bad;
  const to = given(query.to) ? new Date(query.to as string) : new Date(now);
  let from: Date;
  if (given(query.from)) from = new Date(query.from as string);
  else {
    const hours = given(query.hours) ? Number(query.hours) : 24;
    if (typeof query.hours === 'object' || !Number.isFinite(hours) || hours <= 0) return bad;
    from = new Date(to.getTime() - hours * 3_600_000);
  }
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) return bad;
  if (from >= to) return 'from must be before to.';
  if (to.getTime() - from.getTime() > RECAP_MAX_HOURS * 3_600_000) return `A recap covers at most ${RECAP_MAX_HOURS} hours.`;
  return { from, to };
}

export function recapRoutes(
  app: express.Express,
  opts: {
    canRead: AdminCheck;
    db: Db | null | undefined;
    now: () => number;
    log: (message: string, err?: unknown) => void;
  },
) {
  const { canRead, db, now, log } = opts;
  app.get('/api/admin/recap', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!canRead(req, res)) return;
    if (!db) return void res.status(404).json({ error: 'This server has no database to read.' });
    const window = recapWindow(req.query as Record<string, unknown>, now());
    if (typeof window === 'string') return void res.status(400).json({ error: window });
    buildRecap(db, window.from, window.to).then(
      (recap) => res.json(recap),
      (e) => {
        log('recap failed', e);
        res.status(500).json({ error: 'Something went wrong. Try again.' });
      },
    );
  });
}
