/** Feedback players sent from tables: the admin page reads it from /api/feedback. */

import { ApiError } from './suggestions';

export interface Feedback {
  id: number;
  createdAt: string;
  playerId: string;
  name: string;
  kind: 'problem' | 'idea' | 'other';
  text: string;
  tableId: string;
  tableName: string;
  mode: string;
  game: string;
  handNumber: number;
  seated: boolean;
  screen: string;
  commit: string;
  done: boolean;
}

export const KIND_LABEL: Record<Feedback['kind'], string> = { problem: 'Something’s wrong', idea: 'Idea', other: 'Other' };

async function call<T>(adminKey: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/feedback${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-admin-key': adminKey } }).catch(() => {
    throw new ApiError('Could not reach the server. Try again.', 0);
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? 'Something went wrong. Try again.', res.status);
  return body;
}

export const fetchFeedback = (adminKey: string) => call<{ feedback: Feedback[] }>(adminKey, '').then((r) => r.feedback);

export const markFeedback = (adminKey: string, id: number, done: boolean) =>
  call<{ feedback: Feedback }>(adminKey, `/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }).then((r) => r.feedback);

export const deleteFeedback = (adminKey: string, id: number) => call(adminKey, `/${id}`, { method: 'DELETE' });

/** Open feedback first, newest first within each. */
export function feedbackOrder(list: Feedback[]): Feedback[] {
  return [...list].sort((a, b) => Number(a.done) - Number(b.done) || b.id - a.id);
}
