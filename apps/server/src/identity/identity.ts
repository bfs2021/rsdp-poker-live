/**
 * Identity: a persistent guest player per browser secret, optional username
 * and password accounts that own one or more player ids, and sessions so an
 * account can sign in on other devices.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, lte, ne, or, sql, TransactionRollbackError } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { newId } from '../db/ids';
import { accounts, feedback, hiddenTables, playerAvatars, playerNotes, players, playerTokens, practiceResets, savedSetups, sessions, sharedHands } from '../db/schema';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password';
import { hashSecret, isWellFormedSecret, newSecret } from './secrets';

export type Player = typeof players.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Account = Pick<typeof accounts.$inferSelect, 'id' | 'username' | 'primaryPlayerId' | 'createdAt'>;

export type IdentityErrorCode =
  | 'invalid-token'
  | 'invalid-name'
  | 'invalid-username'
  | 'weak-password'
  | 'username-taken'
  | 'bad-credentials'
  | 'player-not-found'
  | 'account-not-found'
  | 'already-linked'
  | 'not-linked'
  | 'bad-reset-code'
  | 'google-taken';

/** Expected identity failures; the message is safe to show to the user. */
export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Lengths are counted like the forms' minLength and maxLength, an emoji as
 * two; zod's .min() and .max() would count it as one.
 */
const lengthIn = (min: number, max: number) => (s: string) => s.length >= min && s.length <= max;

const displayNameSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .refine(lengthIn(1, 24))
      .regex(/^\P{Cc}+$/u),
  );

const usernameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,23}$/);
const passwordSchema = z.string().refine(lengthIn(8, 200));

const accountColumns = {
  id: accounts.id,
  username: accounts.username,
  primaryPlayerId: accounts.primaryPlayerId,
  createdAt: accounts.createdAt,
};

// ---------------------------------------------------------------- players

/**
 * Maps a browser secret to its player, creating a guest player the first time
 * the secret is seen. Only the secret's hash is stored. Also bumps last_seen_at.
 */
export async function resolveToken(db: Db, secret: string, opts: { now?: Date } = {}): Promise<Player> {
  if (!isWellFormedSecret(secret)) throw new IdentityError('invalid-token', 'missing or malformed token');
  const now = opts.now ?? new Date();
  const tokenHash = hashSecret(secret);

  const seen = await touchByToken(db, tokenHash, now);
  if (seen) return seen;

  try {
    return await db.transaction(async (tx) => {
      const [player] = await tx
        .insert(players)
        .values({ id: newId(), createdAt: now, lastSeenAt: now })
        .returning();
      const claimed = await tx
        .insert(playerTokens)
        .values({ tokenHash, playerId: player.id, createdAt: now })
        .onConflictDoNothing()
        .returning();
      // Another connection registered the same secret first: drop our guest and use theirs.
      if (claimed.length === 0) tx.rollback();
      return player;
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
    const winner = await touchByToken(db, tokenHash, now);
    if (!winner) throw err;
    return winner;
  }
}

async function touchByToken(db: Db, tokenHash: string, now: Date): Promise<Player | null> {
  const owner = db.select({ id: playerTokens.playerId }).from(playerTokens).where(eq(playerTokens.tokenHash, tokenHash));
  const [player] = await db.update(players).set({ lastSeenAt: now }).where(inArray(players.id, owner)).returning();
  return player ?? null;
}

export async function getPlayer(db: Db, playerId: string): Promise<Player | null> {
  const [player] = await db.select().from(players).where(eq(players.id, playerId));
  return player ?? null;
}

/** Trims and collapses whitespace; 1 to 24 characters, no control characters. */
export async function setDisplayName(db: Db, playerId: string, name: string): Promise<Player> {
  const parsed = displayNameSchema.safeParse(name);
  if (!parsed.success) throw new IdentityError('invalid-name', 'names are 1 to 24 characters');
  const [player] = await db.update(players).set({ displayName: parsed.data }).where(eq(players.id, playerId)).returning();
  if (!player) throw new IdentityError('player-not-found', 'no such player');
  return player;
}

// ---------------------------------------------------------------- accounts

/**
 * Creates an account owned by an existing guest player, which becomes the
 * account's primary player id. Usernames are unique ignoring case.
 */
export async function createAccount(
  db: Db,
  username: string,
  password: string,
  playerId: string,
  opts: { now?: Date } = {},
): Promise<Account> {
  if (!usernameSchema.safeParse(username).success) {
    throw new IdentityError('invalid-username', 'usernames are 3 to 24 letters, digits, dots, dashes or underscores');
  }
  if (!passwordSchema.safeParse(password).success) {
    throw new IdentityError('weak-password', 'passwords are 8 to 200 characters');
  }
  const passwordHash = await hashPassword(password);
  const now = opts.now ?? new Date();

  return db.transaction(async (tx) => {
    const [player] = await tx.select().from(players).where(eq(players.id, playerId)).for('update');
    if (!player) throw new IdentityError('player-not-found', 'no such player');
    if (player.accountId) throw new IdentityError('already-linked', 'this player already belongs to an account');
    const [account] = await tx
      .insert(accounts)
      .values({ id: newId(), username, passwordHash, primaryPlayerId: playerId, createdAt: now })
      .onConflictDoNothing()
      .returning(accountColumns);
    if (!account) throw new IdentityError('username-taken', 'that username is taken');
    await tx.update(players).set({ accountId: account.id }).where(eq(players.id, playerId));
    return account;
  });
}

export async function getAccount(db: Db, accountId: string): Promise<Account | null> {
  const [account] = await db.select(accountColumns).from(accounts).where(eq(accounts.id, accountId));
  return account ?? null;
}

export async function findAccountByUsername(db: Db, username: string): Promise<Account | null> {
  const [account] = await db
    .select(accountColumns)
    .from(accounts)
    .where(sql`lower(${accounts.username}) = lower(${username})`);
  return account ?? null;
}

/**
 * Adds a guest player id to an account, e.g. when someone signs in on a new
 * device. Linking a player the account already owns is a no-op.
 */
export async function linkPlayerToAccount(db: Db, accountId: string, playerId: string): Promise<Player> {
  return db.transaction(async (tx) => {
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId));
    if (!account) throw new IdentityError('account-not-found', 'no such account');
    const [player] = await tx.select().from(players).where(eq(players.id, playerId)).for('update');
    if (!player) throw new IdentityError('player-not-found', 'no such player');
    if (player.accountId === accountId) return player;
    if (player.accountId) throw new IdentityError('already-linked', 'this player already belongs to another account');
    const [linked] = await tx.update(players).set({ accountId }).where(eq(players.id, playerId)).returning();
    return linked;
  });
}

/** Makes one of the account's linked players the one it plays as. */
export async function setPrimaryPlayer(db: Db, accountId: string, playerId: string): Promise<Account> {
  const [player] = await db.select({ accountId: players.accountId }).from(players).where(eq(players.id, playerId));
  if (!player) throw new IdentityError('player-not-found', 'no such player');
  if (player.accountId !== accountId) throw new IdentityError('not-linked', 'link the player to this account first');
  const [account] = await db
    .update(accounts)
    .set({ primaryPlayerId: playerId })
    .where(eq(accounts.id, accountId))
    .returning(accountColumns);
  if (!account) throw new IdentityError('account-not-found', 'no such account');
  return account;
}

/** Every player id the account owns, oldest first. */
export async function playersForAccount(db: Db, accountId: string): Promise<Player[]> {
  return db.select().from(players).where(eq(players.accountId, accountId)).orderBy(players.createdAt, players.id);
}

// ---------------------------------------------------------------- sessions

export interface LoginResult {
  /** The raw session secret. Hand it to the client once; only its hash is stored. */
  token: string;
  session: Session;
  account: Account;
}

/** Checks the password and opens a session. Wrong usernames and wrong passwords fail the same way. */
export async function login(
  db: Db,
  username: string,
  password: string,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<LoginResult> {
  const [row] =
    typeof username === 'string' && username.length <= 64
      ? await db.select().from(accounts).where(sql`lower(${accounts.username}) = lower(${username})`)
      : [];
  const ok = typeof password === 'string' && password.length <= 200;
  const matches = await verifyPassword(ok ? password : '', row?.passwordHash ?? (await dummyPasswordHash()));
  if (!row || !ok || !matches) throw new IdentityError('bad-credentials', 'wrong username or password');

  const account: Account = {
    id: row.id,
    username: row.username,
    primaryPlayerId: row.primaryPlayerId,
    createdAt: row.createdAt,
  };
  return openSession(db, account, opts);
}

/** Opens a session for an account whose owner has already proved who they are (password or Google). */
export async function openSession(db: Db, account: Account, opts: { now?: Date; ttlMs?: number } = {}): Promise<LoginResult> {
  const now = opts.now ?? new Date();
  const token = newSecret();
  await db.delete(sessions).where(and(eq(sessions.accountId, account.id), lte(sessions.expiresAt, now)));
  const [session] = await db
    .insert(sessions)
    .values({
      id: newId(),
      accountId: account.id,
      tokenHash: hashSecret(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + (opts.ttlMs ?? SESSION_TTL_MS)),
    })
    .returning();
  return { token, session, account };
}

/** The live session for a token, or null when it is unknown or expired. */
export async function resolveSession(
  db: Db,
  token: string,
  opts: { now?: Date } = {},
): Promise<{ session: Session; account: Account } | null> {
  if (!isWellFormedSecret(token)) return null;
  const now = opts.now ?? new Date();
  const [row] = await db
    .select({ session: sessions, account: accountColumns })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(eq(sessions.tokenHash, hashSecret(token)));
  if (!row || row.session.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

/** Ends a session. Returns false when the token matched nothing. */
export async function logout(db: Db, token: string): Promise<boolean> {
  if (!isWellFormedSecret(token)) return false;
  const deleted = await db.delete(sessions).where(eq(sessions.tokenHash, hashSecret(token))).returning({ id: sessions.id });
  return deleted.length > 0;
}

/** Ends every session of an account except `keepToken`'s (all of them when it is omitted). */
export async function logoutOthers(db: Db, accountId: string, keepToken?: string): Promise<void> {
  const keep = keepToken && isWellFormedSecret(keepToken) ? hashSecret(keepToken) : '';
  await db.delete(sessions).where(and(eq(sessions.accountId, accountId), ne(sessions.tokenHash, keep)));
}

/** Forgets a browser secret, so that browser starts over as a new guest. */
export async function forgetToken(db: Db, secret: string): Promise<void> {
  if (!isWellFormedSecret(secret)) return;
  await db.delete(playerTokens).where(eq(playerTokens.tokenHash, hashSecret(secret)));
}

/**
 * Forgets the browser secrets of every player the account owns, except
 * `keepSecret`, so no browser stays signed in through the guest that made
 * the account (or a guest it adopted) after a password change or reset.
 */
export async function forgetDevices(db: Db, accountId: string, keepSecret?: string): Promise<void> {
  const keep = keepSecret && isWellFormedSecret(keepSecret) ? hashSecret(keepSecret) : '';
  const owned = db.select({ id: players.id }).from(players).where(eq(players.accountId, accountId));
  await db.delete(playerTokens).where(and(inArray(playerTokens.playerId, owned), ne(playerTokens.tokenHash, keep)));
}

// ---------------------------------------------------------------- passwords and resets

/** True when `password` is the account's password. Takes as long as a login. */
export async function checkPassword(db: Db, accountId: string, password: unknown): Promise<boolean> {
  const [row] = await db.select({ hash: accounts.passwordHash }).from(accounts).where(eq(accounts.id, accountId));
  const ok = typeof password === 'string' && password.length <= 200;
  const matches = await verifyPassword(ok ? password : '', row?.hash ?? (await dummyPasswordHash()));
  return !!row && ok && matches;
}

/** Sets a new password and clears any open reset code. Sessions are left alone; see logoutOthers. */
export async function setPassword(db: Db, accountId: string, password: string): Promise<void> {
  if (!passwordSchema.safeParse(password).success) {
    throw new IdentityError('weak-password', 'passwords are 8 to 200 characters');
  }
  const passwordHash = await hashPassword(password);
  const updated = await db
    .update(accounts)
    .set({ passwordHash, hasPassword: true, resetCodeHash: null, resetCodeExpiresAt: null })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id });
  if (updated.length === 0) throw new IdentityError('account-not-found', 'no such account');
}

export const RESET_CODE_TTL_MS = 24 * 60 * 60 * 1000;
/** No 0/O or 1/I/L, so a code read out over the phone or typed from WhatsApp comes through. */
const RESET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Upper case, without spaces or dashes, so "abcd-efgh" and "ABCD EFGH" are the same code. */
const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]+/g, '');

/**
 * Makes a one-time password reset code for an account (the admin's path; no
 * email is sent). It replaces any earlier code and works for 24 hours.
 * Returns the code as XXXX-XXXX-XXXX for the admin to pass on.
 */
export async function issueResetCode(db: Db, username: string, opts: { now?: Date } = {}): Promise<{ code: string; expiresAt: Date; username: string }> {
  const account = await findAccountByUsername(db, username);
  if (!account) throw new IdentityError('account-not-found', 'no account has that username');
  const bytes = randomBytes(12);
  const raw = Array.from(bytes, (b) => RESET_ALPHABET[b % RESET_ALPHABET.length]).join('');
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + RESET_CODE_TTL_MS);
  await db.update(accounts).set({ resetCodeHash: hashSecret(raw), resetCodeExpiresAt: expiresAt }).where(eq(accounts.id, account.id));
  return { code: raw.match(/.{4}/g)!.join('-'), expiresAt, username: account.username };
}

/**
 * Sets a new password with a reset code, which then stops working, and ends
 * every session of the account. Wrong usernames and wrong codes fail alike.
 */
export async function resetPassword(
  db: Db,
  username: string,
  code: string,
  password: string,
  opts: { now?: Date } = {},
): Promise<Account> {
  if (!passwordSchema.safeParse(password).success) {
    throw new IdentityError('weak-password', 'passwords are 8 to 200 characters');
  }
  const bad = new IdentityError('bad-reset-code', 'that reset code is wrong or has expired');
  if (typeof username !== 'string' || username.length > 64 || typeof code !== 'string' || code.length > 64) throw bad;
  const now = opts.now ?? new Date();
  const [row] = await db.select().from(accounts).where(sql`lower(${accounts.username}) = lower(${username})`);
  const given = Buffer.from(hashSecret(normalizeCode(code)));
  const stored = Buffer.from(row?.resetCodeHash ?? hashSecret('none'));
  const matches = timingSafeEqual(given, stored);
  if (!row || !row.resetCodeHash || !matches || !row.resetCodeExpiresAt || row.resetCodeExpiresAt.getTime() <= now.getTime()) throw bad;
  await setPassword(db, row.id, password);
  await logoutOthers(db, row.id);
  // A reset hands the account back to whoever has the code: a Google account linked by someone else stops working too.
  await db.update(accounts).set({ googleSub: null }).where(eq(accounts.id, row.id));
  return { id: row.id, username: row.username, primaryPlayerId: row.primaryPlayerId, createdAt: row.createdAt };
}

// ---------------------------------------------------------------- sign-in on another device

/**
 * Brings what a guest made on this device over to the account's player when
 * they sign in: their notes (where the account has none on that player yet)
 * and their picture (when the account has none). The guest id is linked to
 * the account, so its tables and tournaments count in the account's history.
 * A guest that already belongs to another account is left alone.
 * Returns false when nothing was linked.
 */
export async function adoptGuest(db: Db, accountId: string, guestId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [account] = await tx.select(accountColumns).from(accounts).where(eq(accounts.id, accountId));
    if (!account) throw new IdentityError('account-not-found', 'no such account');
    const [guest] = await tx.select().from(players).where(eq(players.id, guestId)).for('update');
    if (!guest || guest.id === account.primaryPlayerId) return false;
    if (guest.accountId && guest.accountId !== accountId) return false;
    if (!guest.accountId) await tx.update(players).set({ accountId }).where(eq(players.id, guestId));
    const primary = account.primaryPlayerId;
    await tx.execute(sql`
      insert into ${playerNotes} (owner_player_id, target_player_id, text, color, updated_at)
      select ${primary}, target_player_id, text, color, updated_at from ${playerNotes}
      where owner_player_id = ${guestId} and target_player_id <> ${primary}
      on conflict do nothing`);
    await tx.execute(sql`
      insert into ${playerAvatars} (player_id, kind, value, updated_at)
      select ${primary}, kind, value, updated_at from ${playerAvatars} where player_id = ${guestId}
      on conflict do nothing`);
    return true;
  });
}

// ---------------------------------------------------------------- deleting

/**
 * Deletes an account for good: its password, sessions and reset code, and on
 * every player it owned the name, picture, notes, saved setups, hidden tables, shared hand links, feedback and browser secrets. Hands
 * already played stay in other players' history and ledgers under the names
 * used at the time. Returns the player ids it owned.
 */
export async function deleteAccount(db: Db, accountId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const owned = await tx.select({ id: players.id }).from(players).where(eq(players.accountId, accountId));
    const ids = owned.map((p) => p.id);
    const deleted = await tx.delete(accounts).where(eq(accounts.id, accountId)).returning({ id: accounts.id });
    if (deleted.length === 0) throw new IdentityError('account-not-found', 'no such account');
    if (ids.length > 0) {
      await tx.update(players).set({ displayName: '', accountId: null }).where(inArray(players.id, ids));
      await tx.delete(playerTokens).where(inArray(playerTokens.playerId, ids));
      await tx.delete(playerNotes).where(inArray(playerNotes.ownerPlayerId, ids));
      await tx.delete(playerAvatars).where(inArray(playerAvatars.playerId, ids));
      await tx.delete(hiddenTables).where(inArray(hiddenTables.playerId, ids));
      await tx.delete(practiceResets).where(inArray(practiceResets.playerId, ids));
      await tx.delete(savedSetups).where(inArray(savedSetups.playerId, ids));
      await tx.delete(sharedHands).where(inArray(sharedHands.createdBy, ids));
      await tx.delete(feedback).where(inArray(feedback.playerId, ids));
    }
    return ids;
  });
}

// ---------------------------------------------------------------- who is this browser

export interface Identity {
  /** The browser's own guest player. */
  guest: Player;
  /** The player this browser plays as: the account's primary player when signed in, else the guest. */
  player: Player;
  account: Account | null;
  /** The session the browser signed in with, when it sent a live one. */
  session: Session | null;
}

/**
 * Works out who a browser is from its guest secret and, when signed in, its
 * session token. A guest that made the account (its primary player) counts as
 * signed in on that browser even without a session. An expired or unknown
 * session falls back to the guest.
 */
export async function whoIs(db: Db, guestSecret: string, sessionToken?: unknown, opts: { now?: Date } = {}): Promise<Identity> {
  const guest = await resolveToken(db, guestSecret, opts);
  const live = typeof sessionToken === 'string' ? await resolveSession(db, sessionToken, opts) : null;
  if (live) {
    const player = live.account.primaryPlayerId === guest.id ? guest : await getPlayer(db, live.account.primaryPlayerId);
    if (player) return { guest, player, account: live.account, session: live.session };
  }
  if (guest.accountId) {
    const account = await getAccount(db, guest.accountId);
    if (account?.primaryPlayerId === guest.id) return { guest, player: guest, account, session: null };
  }
  return { guest, player: guest, account: null, session: null };
}

// ---------------------------------------------------------------- Google

/** How an account signs in: with a password, with Google, or both. */
export async function signInMethods(db: Db, accountId: string): Promise<{ hasPassword: boolean; google: boolean }> {
  const [row] = await db.select({ hasPassword: accounts.hasPassword, googleSub: accounts.googleSub }).from(accounts).where(eq(accounts.id, accountId));
  if (!row) throw new IdentityError('account-not-found', 'no such account');
  return { hasPassword: row.hasPassword, google: !!row.googleSub };
}

export async function findAccountByGoogle(db: Db, sub: string): Promise<Account | null> {
  const [account] = await db.select(accountColumns).from(accounts).where(eq(accounts.googleSub, sub));
  return account ?? null;
}

/** A free username from a Google name: letters and digits kept, then 2, 3, ... until one is free. */
async function freeUsername(db: Db, wanted: string): Promise<string> {
  let base = wanted
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_.-]+/g, '')
    .replace(/^[.-]+/, '')
    .slice(0, 20);
  if (base.length < 3) base = `player${base}`;
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? base : `${base.slice(0, 20)}${i}`;
    if (!(await findAccountByUsername(db, name))) return name;
  }
  return `player${randomBytes(4).toString('hex')}`;
}

/**
 * Makes an account for someone signing in with Google for the first time.
 * It plays as the browser's guest when that guest belongs to no account
 * (so what they did on this device stays theirs), else as a new player.
 * It has no password until one is set.
 */
export async function createGoogleAccount(
  db: Db,
  input: { sub: string; name: string; guestId: string },
  opts: { now?: Date } = {},
): Promise<{ account: Account; usedGuest: boolean }> {
  const now = opts.now ?? new Date();
  const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const username = await freeUsername(db, input.name);
    const made = await db.transaction(async (tx) => {
      const [guest] = await tx.select().from(players).where(eq(players.id, input.guestId)).for('update');
      const usedGuest = !!guest && !guest.accountId;
      const playerId = usedGuest
        ? guest.id
        : (await tx.insert(players).values({ id: newId(), createdAt: now, lastSeenAt: now }).returning())[0].id;
      const [account] = await tx
        .insert(accounts)
        .values({ id: newId(), username, passwordHash, hasPassword: false, googleSub: input.sub, primaryPlayerId: playerId, createdAt: now })
        .onConflictDoNothing()
        .returning(accountColumns);
      // A username or Google account taken in the meantime: start over.
      if (!account) tx.rollback();
      await tx.update(players).set({ accountId: account.id }).where(eq(players.id, playerId));
      return { account, usedGuest };
    }).catch((e: unknown) => {
      if (e instanceof TransactionRollbackError) return null;
      throw e;
    });
    if (made) return made;
    const existing = await findAccountByGoogle(db, input.sub);
    if (existing) return { account: existing, usedGuest: false };
  }
  throw new IdentityError('username-taken', 'could not pick a username; try again');
}

/** Lets an account also sign in with this Google account. */
export async function linkGoogle(db: Db, accountId: string, sub: string): Promise<void> {
  const owner = await findAccountByGoogle(db, sub);
  if (owner && owner.id !== accountId) throw new IdentityError('google-taken', 'that Google account already belongs to another account');
  // Never swaps one linked Google account for another; unlink first.
  const done = await db
    .update(accounts)
    .set({ googleSub: sub })
    .where(and(eq(accounts.id, accountId), or(isNull(accounts.googleSub), eq(accounts.googleSub, sub))))
    .returning({ id: accounts.id });
  if (done.length === 0) throw new IdentityError('google-taken', 'this account already has another Google account linked');
}

/** Stops Google sign-in for an account; it then needs its password, so one must be set. */
export async function unlinkGoogle(db: Db, accountId: string): Promise<void> {
  const { hasPassword } = await signInMethods(db, accountId);
  if (!hasPassword) throw new IdentityError('weak-password', 'set a password first, or you could not sign in any more');
  await db.update(accounts).set({ googleSub: null }).where(eq(accounts.id, accountId));
}
