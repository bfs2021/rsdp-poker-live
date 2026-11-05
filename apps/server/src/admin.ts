// Small helpers shared by the HTTP routes: rate limits, the caller's address,
// and the ADMIN_KEY check for the admin pages.

import { createHash, timingSafeEqual } from 'node:crypto';
import type express from 'express';

type Counts = { hits: Map<string, number[]>; windowMs: number; now: () => number };
/** Every limiter made, held weakly so one that is no longer used (a server closed in tests) can go. */
const everyLimiter = new Set<WeakRef<Counts>>();

/** Forgets keys with no hits left in their window: e.g. an address that hasn't tried anything for a while. */
function forgetOld({ hits, windowMs, now }: Counts) {
  const t = now();
  for (const [k, v] of hits) if (v.every((x) => x <= t - windowMs)) hits.delete(k);
}

/**
 * Forgets old keys in every limiter. The server runs this every few minutes, so an address
 * (the keys are mostly addresses) stays in memory only for its limit's window, at most an hour.
 */
export function sweepLimiters() {
  for (const ref of everyLimiter) {
    const counts = ref.deref();
    if (counts) forgetOld(counts);
    else everyLimiter.delete(ref);
  }
}

/** Sliding-window counter: true (and counted) when `key` has room for one more. */
export function limiter(burst: number, windowMs: number, now: () => number) {
  const counts: Counts = { hits: new Map(), windowMs, now };
  everyLimiter.add(new WeakRef(counts));
  return (key: string, count = true) => {
    const { hits } = counts;
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (recent.length >= burst) return hits.set(key, recent), false;
    if (count) recent.push(t);
    if (recent.length) hits.set(key, recent);
    else hits.delete(key);
    // Lots of keys: sweep now rather than wait for sweepLimiters.
    if (hits.size > 5_000) forgetOld(counts);
    return true;
  };
}

/** How many limiters remember `key` now (for tests). */
export const limiterKeys = (key: string) => {
  let n = 0;
  for (const ref of everyLimiter) if (ref.deref()?.hits.has(key)) n++;
  return n;
};

/** The caller's address; Fly puts the real one in a header. */
export const clientAddress = (req: express.Request) => req.get('fly-client-ip') ?? req.socket.remoteAddress ?? '';

/** Wrong admin keys one address may try per window. */
const ADMIN_TRIES = 10;
const ADMIN_WINDOW_MS = 10 * 60_000;

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Responds and returns false unless the request carries the admin key (header X-Admin-Key). */
export type AdminCheck = (req: express.Request, res: express.Response) => boolean;

/** Wrong keys counted per address. Give every gate on one server the same one, so they share one limit. */
export const adminTries = (now: () => number) => limiter(ADMIN_TRIES, ADMIN_WINDOW_MS, now);

/**
 * A check for a set of routes. Takes any of `keys`: the admin routes take ADMIN_KEY alone; read-only reports also
 * take REPORT_KEY, which can't change or download anything. Gates built with the same `tries` count wrong keys
 * against one limit, so a second gate doesn't double the guesses an address may make at ADMIN_KEY.
 */
export function adminGate(keys: string | undefined | (string | undefined)[], now: () => number, tries = adminTries(now)): AdminCheck {
  // A short key would be guessable; treat it as unset.
  const accepted = (Array.isArray(keys) ? keys : [keys]).filter((k): k is string => !!k && k.length >= 12).map(digest);
  return (req, res) => {
    if (!accepted.length) return res.status(403).json({ error: 'The admin key is not set up on this server yet.' }), false;
    const ip = clientAddress(req);
    if (!tries(ip, false)) return res.status(429).json({ error: 'Too many wrong keys. Try again in a few minutes.' }), false;
    const given = req.get('x-admin-key') ?? '';
    // Every key compared, so the time taken doesn't say which one matched.
    const hashed = given ? digest(given) : null;
    const match = hashed ? accepted.map((k) => timingSafeEqual(hashed, k)).includes(true) : false;
    if (match) return true;
    tries(ip);
    res.status(401).json({ error: 'That admin key is not right.' });
    return false;
  };
}
