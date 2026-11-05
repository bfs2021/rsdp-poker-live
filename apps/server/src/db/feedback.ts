/** Feedback players send from a table: private, read only by the admin. */

import { desc, eq, gte, lt } from 'drizzle-orm';
import type { Db } from './client';
import { feedback, type FEEDBACK_KINDS } from './schema';

export type FeedbackRow = typeof feedback.$inferSelect;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type NewFeedback = Omit<typeof feedback.$inferInsert, 'id' | 'createdAt' | 'done'>;

/** `createdAt` defaults to the database's clock. */
export async function insertFeedback(db: Db, row: NewFeedback & { createdAt?: Date }): Promise<FeedbackRow> {
  const [created] = await db.insert(feedback).values(row).returning();
  return created;
}

/** Newest first; only what was sent at or after `since` when given. */
export async function listFeedback(db: Db, opts: { since?: Date } = {}): Promise<FeedbackRow[]> {
  const q = db.select().from(feedback);
  return (opts.since ? q.where(gte(feedback.createdAt, opts.since)) : q).orderBy(desc(feedback.id));
}

export async function markFeedback(db: Db, id: number, done: boolean): Promise<FeedbackRow | null> {
  const [row] = await db.update(feedback).set({ done }).where(eq(feedback.id, id)).returning();
  return row ?? null;
}

export async function deleteFeedback(db: Db, id: number): Promise<boolean> {
  const rows = await db.delete(feedback).where(eq(feedback.id, id)).returning({ id: feedback.id });
  return rows.length > 0;
}

/** Forgets feedback sent before `before` (see FEEDBACK_KEEP_MS). Returns how many went. */
export async function pruneFeedback(db: Db, before: Date): Promise<number> {
  const rows = await db.delete(feedback).where(lt(feedback.createdAt, before)).returning({ id: feedback.id });
  return rows.length;
}
