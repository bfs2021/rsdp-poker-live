// Feedback from the table: a player presses Send feedback, says what's wrong
// or what they'd like, and it is saved with which table and hand it was. It is
// private: unlike roadmap suggestions, only someone holding ADMIN_KEY reads it.

import express from 'express';
import type { AdminCheck } from './admin';
import { deleteFeedback, insertFeedback, listFeedback, markFeedback, pruneFeedback, type Db, type FeedbackKind, type NewFeedback } from './db';
import { FEEDBACK_KINDS } from './db/schema';

export interface Feedback extends Omit<NewFeedback, 'kind'> {
  id: number;
  kind: FeedbackKind;
  createdAt: string;
  done: boolean;
}

/** What the table knows when feedback is sent: everything but the words. */
export type FeedbackInput = Omit<Feedback, 'id' | 'createdAt' | 'done'>;

/** Where feedback is kept. The default keeps it in memory. */
export interface FeedbackStore {
  create(input: FeedbackInput): Promise<Feedback>;
  /** Newest first; only what was sent at or after `since` when given. */
  list(opts?: { since?: Date }): Promise<Feedback[]>;
  mark(id: number, done: boolean): Promise<Feedback | null>;
  remove(id: number): Promise<boolean>;
}

/** Feedback is forgotten a year after it was sent (docs/PRIVACY.md). */
export const FEEDBACK_KEEP_MS = 365 * 24 * 60 * 60_000;
export const FEEDBACK_MAX = 1000;
/** Feedback one player may send per window, and the whole site per hour. */
export const FEEDBACK_BURST = 5;
export const FEEDBACK_WINDOW_MS = 10 * 60_000;
export const FEEDBACK_SITE_PER_HOUR = 60;
/** Feedback one address may send per window, so new guest ids can't use up the site's hour on their own. */
export const FEEDBACK_ADDRESS_BURST = 10;

export const isFeedbackKind = (k: unknown): k is FeedbackKind => typeof k === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(k);

/** The words as kept: control characters dropped, runs of blank lines and spaces squeezed. Null when empty or too long. */
export function cleanFeedback(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/[^\P{Cc}\n]/gu, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s && s.length <= FEEDBACK_MAX ? s : null;
}

export function memoryFeedback(now: () => number = Date.now): FeedbackStore {
  const rows = new Map<number, Feedback>();
  let next = 1;
  return {
    async create(input) {
      for (const [id, r] of rows) if (Date.parse(r.createdAt) < now() - FEEDBACK_KEEP_MS) rows.delete(id);
      const row: Feedback = { ...input, id: next++, createdAt: new Date(now()).toISOString(), done: false };
      rows.set(row.id, row);
      return { ...row };
    },
    async list(opts = {}) {
      const since = Math.max(opts.since?.getTime() ?? -Infinity, now() - FEEDBACK_KEEP_MS);
      return [...rows.values()]
        .filter((r) => Date.parse(r.createdAt) >= since)
        .sort((a, b) => b.id - a.id)
        .map((r) => ({ ...r }));
    },
    async mark(id, done) {
      const row = rows.get(id);
      if (!row) return null;
      row.done = done;
      return { ...row };
    },
    async remove(id) {
      return rows.delete(id);
    },
  };
}

export function dbFeedback(db: Db, now: () => number = Date.now): FeedbackStore {
  const view = (r: Awaited<ReturnType<typeof insertFeedback>>): Feedback => ({ ...r, kind: r.kind as FeedbackKind, createdAt: r.createdAt.toISOString() });
  return {
    create: async (input) => {
      // Old feedback goes as new feedback comes and whenever it is read, so none is shown or kept past a year for long.
      await pruneFeedback(db, new Date(now() - FEEDBACK_KEEP_MS));
      return view(await insertFeedback(db, { ...input, createdAt: new Date(now()) }));
    },
    list: async (opts) => {
      await pruneFeedback(db, new Date(now() - FEEDBACK_KEEP_MS));
      return (await listFeedback(db, opts)).map(view);
    },
    mark: async (id, done) => {
      const row = await markFeedback(db, id, done);
      return row ? view(row) : null;
    },
    remove: (id) => deleteFeedback(db, id),
  };
}

/** The admin page's routes: read feedback, mark it dealt with, delete it. */
export function feedbackRoutes(
  app: express.Express,
  store: FeedbackStore,
  opts: {
    /** Who may read feedback (the admin; a read-only key could be added here). */
    canRead: AdminCheck;
    /** Who may mark or delete it (the admin). */
    isAdmin: AdminCheck;
    log: (message: string, err?: unknown) => void;
  },
) {
  const { canRead, isAdmin, log } = opts;
  const json = express.json({ limit: '1kb' });
  const failed = (res: express.Response) => (e: unknown) => {
    log('feedback failed', e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  };
  const idOf = (req: express.Request) => {
    const id = Number(req.params.id);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
  };

  // Everything, or only what came in since a time (?since=2026-11-05T00:00:00Z), newest first.
  app.get('/api/feedback', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!canRead(req, res)) return;
    let since: Date | undefined;
    if (req.query.since !== undefined) {
      since = new Date(String(req.query.since));
      if (Number.isNaN(since.getTime())) return void res.status(400).json({ error: 'since must be a date and time, e.g. 2026-11-05T18:00:00Z' });
    }
    store
      .list({ since })
      .then((list) => res.json({ feedback: list }))
      .catch(failed(res));
  });

  app.patch('/api/feedback/:id', json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isAdmin(req, res)) return;
    const id = idOf(req);
    const done = (req.body as Record<string, unknown> | undefined)?.done;
    if (typeof done !== 'boolean') return void res.status(400).json({ error: 'done must be true or false' });
    if (!id) return void res.status(404).json({ error: 'not found' });
    store
      .mark(id, done)
      .then((f) => (f ? res.json({ feedback: f }) : res.status(404).json({ error: 'not found' })))
      .catch(failed(res));
  });

  app.delete('/api/feedback/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isAdmin(req, res)) return;
    const id = idOf(req);
    if (!id) return void res.status(404).json({ error: 'not found' });
    store
      .remove(id)
      .then((ok) => (ok ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' })))
      .catch(failed(res));
  });
}
