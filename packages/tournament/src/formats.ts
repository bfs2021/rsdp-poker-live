// Tournament formats layered on the director: bounties (regular and
// progressive knockout), invite codes, and check-in groups. These are the
// pure helpers; the director calls them from its transitions.

import { hasPower } from '@rsdp/engine/roles';
import { MAX_PRIZE_AMOUNT } from './payouts';
import { nextRandom } from './seating';
import type { Entry, InviteCode, PlayerId, TournamentSettings, TournamentState } from './types';

const isWhole = (n: unknown, min: number, max: number) => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const MAX_CHECK_IN_GROUPS = 15;
export const MAX_INVITE_CODES = 1000;
/** Most codes one request makes. */
export const MAX_INVITES_PER_BATCH = 200;
/** Check-in lists can run past max entrants: seats go to whoever checks in first. */
export const MAX_REGISTRATION_LIST = 1000;
/** No 0/O or 1/I/L, so a code read aloud or off a phone is typed right. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_PATTERN = /^[A-Z0-9]{4,16}$/;

export function validateFormats(s: TournamentSettings): string[] {
  const errors: string[] = [];
  if (s.bounty !== undefined) {
    const b: Partial<NonNullable<TournamentSettings['bounty']>> = isObject(s.bounty) ? s.bounty : {};
    if (!isWhole(b.amount, 1, Number.MAX_SAFE_INTEGER)) errors.push('The bounty must be a whole amount above 0');
    else if (b.amount! > MAX_PRIZE_AMOUNT) errors.push('The bounty must be at most $100,000');
    if (!isWhole(b.progressivePercent, 0, 100)) errors.push('The progressive share must be 0-100%');
  }
  if (s.invites !== undefined) {
    const i: Record<string, unknown> = isObject(s.invites) ? s.invites : {};
    if (typeof i.required !== 'boolean' || typeof i.autoApprove !== 'boolean') errors.push('On/off settings must be true or false');
  }
  if (s.checkIn !== undefined) {
    const c: Partial<NonNullable<TournamentSettings['checkIn']>> = isObject(s.checkIn) ? s.checkIn : {};
    if (s.start?.kind === 'sng') errors.push('Sit & Go events have no check-in');
    if (!Array.isArray(c.groups) || c.groups.length < 1 || c.groups.length > MAX_CHECK_IN_GROUPS) errors.push(`Check-in needs 1-${MAX_CHECK_IN_GROUPS} groups`);
    else {
      if (!c.groups.every((g) => isObject(g) && (g.firstN === null || isWhole(g.firstN, 1, MAX_REGISTRATION_LIST))))
        errors.push('Each check-in group is everyone registered or the first 1 or more');
      if (!c.groups.every((g) => isObject(g) && isWhole(g.waitMinutes, 1, 599))) errors.push('The wait before the next check-in group must be 1-599 minutes');
    }
    if (!isWhole(c.opensMinutesBefore, 1, 7 * 24 * 60)) errors.push('Check-in must open 1 minute to 7 days before the start');
    else if (s.start?.kind === 'scheduled' && isWhole(s.seatLeadSeconds, 0, 3600)) {
      if (c.opensMinutesBefore! * 60 <= s.seatLeadSeconds) errors.push('Check-in must open before the seats are drawn');
      // Every group must open before the draw, or its players are dropped without a chance to check in.
      const waits = Array.isArray(c.groups) ? c.groups.slice(0, -1).reduce((sum, g) => sum + (isObject(g) && isWhole(g.waitMinutes, 1, 599) ? g.waitMinutes : 0), 0) : 0;
      if (waits * 60 >= c.opensMinutesBefore! * 60 - s.seatLeadSeconds) errors.push('Every check-in group must open before the seats are drawn');
    }
  }
  if (s.season !== undefined) {
    const v: Record<string, unknown> = isObject(s.season) ? s.season : {};
    if (typeof v.id !== 'string' || !/^[0-9A-Za-z_-]{0,40}$/.test(v.id)) errors.push('Pick a season');
    const length = typeof v.name === 'string' ? Array.from(v.name.trim()).length : 0;
    if (length < 1 || length > 40) errors.push('The season name must be 1-40 characters');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Bounties

/** How a bounty is split between the players who won the busting pot: cash to each, and what goes onto their own heads. */
export function splitBounty(head: number, winners: number, progressivePercent: number): { cash: number; headAdded: number }[] {
  if (winners < 1 || head <= 0) return [];
  const base = Math.floor(head / winners);
  return Array.from({ length: winners }, (_, i) => {
    // The odd cents go to the first winners.
    const share = base + (i < head - base * winners ? 1 : 0);
    const headAdded = Math.floor((share * progressivePercent) / 100);
    return { cash: share - headAdded, headAdded };
  });
}

// ---------------------------------------------------------------------------
// Invite codes

export const normalizeCode = (code: unknown) => (typeof code === 'string' ? code.trim().toUpperCase().replace(/[\s-]/g, '') : '');

export const isCodeFormat = (code: string) => CODE_PATTERN.test(code);

/** Draws codes with the director's seeded generator; the server passes in codes from a secure source instead. */
export function drawCodes(rng: number, count: number, taken: Set<string>): [string[], number] {
  const out: string[] = [];
  while (out.length < count) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      const [r, next] = nextRandom(rng);
      rng = next;
      code += CODE_ALPHABET[Math.floor(r * CODE_ALPHABET.length)];
    }
    if (!taken.has(code)) {
      taken.add(code);
      out.push(code);
    }
  }
  return [out, rng];
}

/** A fresh code from any source of random 32-bit words (the server uses crypto). */
export function codeFromWords(words: Uint32Array | number[]): string {
  return Array.from({ length: CODE_LENGTH }, (_, i) => CODE_ALPHABET[(words[i] >>> 0) % CODE_ALPHABET.length]).join('');
}

/** A code that can still be used, counting registrations waiting for the host as using it. */
export function usableCode(s: TournamentState, code: string): InviteCode | null {
  const c = s.invites?.find((x) => x.code === code);
  if (!c || c.cancelled) return null;
  if (c.maxUses === null) return c;
  const waiting = s.requests.filter((r) => r.kind === 'register' && r.code === code).length;
  return c.usedBy.length + waiting < c.maxUses ? c : null;
}

/** The state a viewer is sent: only the host sees the codes. */
export function viewFor(s: TournamentState, viewer: PlayerId): TournamentState {
  // The host and co-hosts who approve entries see the invite codes.
  if (hasPower(s, viewer, 'approve')) return s;
  const { invites: _hidden, ...rest } = s;
  return { ...rest, requests: s.requests.map(({ code: _code, ...r }) => r) };
}

// ---------------------------------------------------------------------------
// Check-in

/** Check-in decides who gets a seat: it is on and the tables are not drawn yet. */
export const checkInActive = (s: TournamentState) => !!s.settings.checkIn && s.tables.length === 0 && (s.status === 'registering' || s.status === 'seating');

/** When the first group opens on its own, or null when the host opens it. */
export function checkInScheduledAt(s: TournamentState): number | null {
  const c = s.settings.checkIn;
  if (!c || s.settings.start.kind !== 'scheduled' || s.startAt === null) return null;
  return s.startAt - c.opensMinutesBefore * 60_000;
}

/** When group `i` (0-based) opens, once the first one has. */
export function groupOpensAt(s: TournamentState, i: number): number | null {
  const c = s.settings.checkIn;
  const opened = s.checkIn?.openedAt ?? checkInScheduledAt(s);
  if (!c || opened === null || opened === undefined) return null;
  return opened + c.groups.slice(0, i).reduce((sum, g) => sum + g.waitMinutes * 60_000, 0);
}

/** First entries on the registration list, in the order they registered. */
const listed = (s: TournamentState) => s.entries.filter((e) => e.status === 'registered');

/** The first group (0-based) that lets this entry check in, or -1. */
export function checkInGroupOf(s: TournamentState, e: Entry): number {
  const c = s.settings.checkIn;
  if (!c) return -1;
  const rank = listed(s).indexOf(e) + 1;
  if (rank === 0) return -1;
  return c.groups.findIndex((g) => g.firstN === null || rank <= g.firstN);
}

export function mayCheckIn(s: TournamentState, e: Entry): boolean {
  if (!checkInActive(s) || e.status !== 'registered' || e.checkedInAt !== undefined) return false;
  const group = checkInGroupOf(s, e);
  return group >= 0 && group < (s.checkIn?.groupsOpen ?? 0);
}

export const checkedInCount = (s: TournamentState) => s.entries.filter((e) => e.status === 'registered' && e.checkedInAt !== undefined).length;

/** Players who count toward starting: those checked in while check-in decides the field. */
export function readyEntries(s: TournamentState): Entry[] {
  const alive = s.entries.filter((e) => e.status === 'registered' || e.status === 'seated' || e.status === 'rebuy-offer');
  return checkInActive(s) ? alive.filter((e) => e.status !== 'registered' || e.checkedInAt !== undefined) : alive;
}
