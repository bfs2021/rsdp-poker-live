import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io as connect } from 'socket.io-client';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { dbIdentity } from '../src/storage';
import { FakeClock } from './fake-clock';
import { socketClient, type Client } from './socket-client';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const PHONE = 'guest-secret-phone-aaaaaaaaaaaa';
const LAPTOP = 'guest-secret-laptop-bbbbbbbbbbb';

let db: Db;
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
/** What the fake Google puts in the next ID token, and the token requests it saw. */
let nextClaims: Record<string, unknown> = {};
let seen: URLSearchParams[] = [];

const jwt = (claims: object) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

beforeAll(async () => {
  // A new table's settings are checked against the games, which the server registers at startup.
  registerAllVariants(variants);
  db = await createTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  clock = new FakeClock();
  clock.t = Date.now();
  seen = [];
  server = createApp({
    clock,
    identity: dbIdentity(db),
    accounts: db,
    adminKey: 'test-admin-key-0123456789',
    google: {
      clientId: CLIENT_ID,
      clientSecret: 'shh',
      publicUrl: 'https://poker.example',
      exchange: async (form) => {
        seen.push(form);
        return { id_token: jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(clock.t / 1000) + 3600, auth_time: Math.floor(clock.t / 1000), ...nextClaims }) };
      },
    },
    log: () => {},
  });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await server.close();
});

afterAll(async () => {
  await closeDb(db);
});

function headers(guest: string, session?: string) {
  const h: Record<string, string> = { 'content-type': 'application/json', 'x-guest-token': guest };
  if (session) h['x-session-token'] = session;
  return h;
}

interface Flow {
  status: number;
  error?: string;
  code?: string;
  fragment?: Record<string, string>;
  finished?: Record<string, unknown>;
  ticket?: string;
  cookie?: string;
}

/** Begins at our server as `guest` and returns Google's address and this browser's cookie. */
async function begin(guest: string, opts: { mode?: 'signin' | 'link' | 'confirm'; session?: string; bringOver?: boolean; password?: string } = {}) {
  const res = await fetch(`${url}/api/auth/google/begin`, { method: 'POST', headers: headers(guest, opts.session), body: JSON.stringify({ mode: opts.mode ?? 'signin', bringOver: opts.bringOver ?? true, password: opts.password }) });
  const body = (await res.json()) as { url?: string; error?: string };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { res, body, cookie };
}

/** Google sending a browser (with `cookie`, or none) back to our callback; returns the fragment. */
async function callback(google: URL, cookie: string, claims: { sub: string; name?: string; given?: string; tamper?: object }) {
  nextClaims = { sub: claims.sub, nonce: google.searchParams.get('nonce'), name: claims.name, given_name: claims.given, ...claims.tamper };
  const back = await fetch(`${url}/auth/google/callback?code=abc&state=${google.searchParams.get('state')}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  expect(back.status).toBe(303);
  const location = back.headers.get('location')!;
  expect(location.startsWith('/auth/done#')).toBe(true);
  return Object.fromEntries(new URLSearchParams(location.split('#')[1]));
}

async function finish(ticket: string, guest: string, cookie: string, session?: string) {
  const res = await fetch(`${url}/api/auth/google/finish`, { method: 'POST', headers: { ...headers(guest, session), ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ ticket }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The whole round trip in one browser: begin, Google, callback, finish. */
async function googleSignIn(guest: string, opts: { sub: string; name?: string; given?: string; mode?: 'signin' | 'link' | 'confirm'; session?: string; bringOver?: boolean; password?: string; tamper?: object }): Promise<Flow> {
  const { res, body, cookie } = await begin(guest, opts);
  if (!res.ok) return { status: res.status, error: body.error };
  const google = new URL(body.url!);
  expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(google.searchParams.get('redirect_uri')).toBe('https://poker.example/auth/google/callback');
  expect(google.searchParams.get('code_challenge_method')).toBe('S256');
  const fragment = await callback(google, cookie, opts);
  if (!fragment.ticket) return { status: 303, fragment };
  const done = await finish(fragment.ticket, guest, cookie, opts.session);
  return { status: done.status, fragment, finished: done.body, code: done.body.code as string | undefined };
}

function sessionOf(guest: string, session?: string) {
  const c = connect(url, { auth: { token: guest, session }, transports: ['websocket'], forceNew: true });
  clients.push(c);
  return new Promise<{ playerId: string; displayName: string; account: { username: string } | null }>((resolve) => c.once('session', resolve));
}

describe('sign in with Google', () => {
  it('says whether it is on', async () => {
    expect(await (await fetch(`${url}/api/auth/config`)).json()).toEqual({ google: true });
    const bare = createApp({ clock });
    await new Promise<void>((r) => bare.http.listen(0, r));
    const port = (bare.http.address() as AddressInfo).port;
    expect(await (await fetch(`http://localhost:${port}/api/auth/config`)).json()).toEqual({ google: false });
    expect((await fetch(`http://localhost:${port}/api/auth/google/begin`, { method: 'POST', headers: headers(PHONE), body: '{}' })).status).toBe(404);
    await bare.close();
  });

  it('makes an account the first time, keeping the guest and naming it after Google', async () => {
    const before = await sessionOf(PHONE);
    const r = await googleSignIn(PHONE, { sub: 'g-1', name: 'Mike Price', given: 'Mike' });
    expect(r.finished).toMatchObject({ welcome: true, session: expect.any(String) });
    // The code was swapped with the PKCE verifier and our redirect address.
    expect(seen[0].get('code_verifier')).toBeTruthy();
    expect(seen[0].get('redirect_uri')).toBe('https://poker.example/auth/google/callback');
    const after = await sessionOf(PHONE, (r.finished!.session as string));
    expect(after).toMatchObject({ playerId: before.playerId, displayName: 'Mike', account: { username: 'MikePrice' } });
    const me = (await (await fetch(`${url}/api/account/me`, { headers: headers(PHONE, (r.finished!.session as string)) })).json()) as { account: object };
    expect(me.account).toMatchObject({ google: true, hasPassword: false });
  });

  it('signs the same Google account in on another device as the same player', async () => {
    const first = await googleSignIn(PHONE, { sub: 'g-1', name: 'Mike' });
    const phone = await sessionOf(PHONE, (first.finished!.session as string));
    const second = await googleSignIn(LAPTOP, { sub: 'g-1', name: 'Mike' });
    expect(second.finished!.welcome).toBe(false);
    expect((await sessionOf(LAPTOP, (second.finished!.session as string))).playerId).toBe(phone.playerId);
  });

  it('won’t sign in to an existing account while this device’s guest has a seat, but a new account keeps the seat', async () => {
    await googleSignIn(PHONE, { sub: 'g-1', name: 'Mike' });
    const laptop = socketClient(url, LAPTOP, clients);
    const guest = await new Promise<{ playerId: string }>((r) => laptop.socket.once('session', r));
    const { tableId } = await laptop.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Kitchen' }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } });
    await laptop.call('table:join', { tableId });
    await laptop.call('seat:request', { seat: 0, name: 'Guest', stack: 100 });

    const refused = await googleSignIn(LAPTOP, { sub: 'g-1', name: 'Mike' });
    expect(refused).toMatchObject({ status: 409, code: 'seated' });
    expect(refused.finished!.error).toMatch(/Kitchen/);
    expect(refused.finished!.href).toBe(`/t/${tableId}`);
    expect(refused.finished!.session).toBeUndefined();

    // A Google account made here plays as this guest, so the seat comes along.
    const made = await googleSignIn(LAPTOP, { sub: 'g-2', name: 'Bo' });
    expect(made.finished).toMatchObject({ welcome: true, session: expect.any(String) });
    expect((await sessionOf(LAPTOP, made.finished!.session as string)).playerId).toBe(guest.playerId);
  });

  it('turns away a token for another app, an expired one, or a replayed state', async () => {
    expect((await googleSignIn(PHONE, { sub: 'g-1', tamper: { aud: 'someone-else' } })).fragment!.error).toBe('failed');
    expect((await googleSignIn(PHONE, { sub: 'g-1', tamper: { nonce: 'wrong' } })).fragment!.error).toBe('failed');
    expect((await googleSignIn(PHONE, { sub: 'g-1', tamper: { exp: 1 } })).fragment!.error).toBe('failed');
    const replay = await fetch(`${url}/auth/google/callback?code=abc&state=made-up`, { redirect: 'manual' });
    expect(replay.headers.get('location')).toMatch(/error=/);
  });

  it('links Google to a password account, after which either works; refuses a Google account already used', async () => {
    const up = await fetch(`${url}/api/account/signup`, { method: 'POST', headers: headers(PHONE), body: JSON.stringify({ username: 'Mike', password: 'correct horse' }) });
    const session = ((await up.json()) as { session: string }).session;
    // Linking needs the password, so a stolen session can't add its own Google.
    expect((await googleSignIn(PHONE, { sub: 'g-9', mode: 'link', session })).status).toBe(401);
    expect((await googleSignIn(PHONE, { sub: 'g-9', mode: 'link', session, password: 'correct horse' })).finished).toEqual({ ok: true, linked: true });
    const viaGoogle = await googleSignIn(LAPTOP, { sub: 'g-9' });
    expect((await sessionOf(LAPTOP, viaGoogle.finished!.session as string)).account).toEqual({ username: 'Mike' });

    await googleSignIn('guest-secret-tablet-cccccccccccc', { sub: 'g-other', name: 'Bo' });
    expect((await googleSignIn(PHONE, { sub: 'g-other', mode: 'link', session, password: 'correct horse' })).code).toBe('taken');
  });

  it('lets a Google-only account set a password after confirming with Google, and only then unlink Google', async () => {
    const r = await googleSignIn(PHONE, { sub: 'g-1', name: 'Mike' });
    const session = r.finished!.session as string;
    const h = headers(PHONE, session);
    expect((await fetch(`${url}/api/account/google/unlink`, { method: 'POST', headers: h })).status).toBe(400);
    const setIt = () => fetch(`${url}/api/account/password`, { method: 'POST', headers: h, body: JSON.stringify({ password: 'my new password' }) });
    // A stolen session alone can't take the account over by setting a password.
    expect((await setIt()).status).toBe(403);
    // Confirming with a different Google account doesn't count.
    expect((await googleSignIn(PHONE, { sub: 'g-2', mode: 'confirm', session })).code).toBe('not-yours');
    // Google must really have asked again: an old sign-in doesn't count.
    expect((await googleSignIn(PHONE, { sub: 'g-1', mode: 'confirm', session, tamper: { auth_time: Math.floor(clock.t / 1000) - 3600 } })).code).toBe('stale');
    expect((await googleSignIn(PHONE, { sub: 'g-1', mode: 'confirm', session })).finished).toEqual({ ok: true, confirmed: true });
    expect((await setIt()).status).toBe(200);
    // One confirm, one change.
    expect((await fetch(`${url}/api/account/password`, { method: 'POST', headers: h, body: JSON.stringify({ current: 'my new password', password: 'third password' }) })).status).toBe(200);
    const unlink = (password?: string) => fetch(`${url}/api/account/google/unlink`, { method: 'POST', headers: h, body: JSON.stringify({ password }) });
    expect((await unlink()).status).toBe(401);
    expect((await unlink('third password')).status).toBe(200);
    const signIn = await fetch(`${url}/api/account/signin`, { method: 'POST', headers: headers(LAPTOP), body: JSON.stringify({ username: 'Mike', password: 'third password' }) });
    expect(signIn.status).toBe(200);
  });

  it('deletes a Google-only account when the username is typed to confirm', async () => {
    const r = await googleSignIn(PHONE, { sub: 'g-1', name: 'Mike' });
    const session = r.finished!.session as string;
    const h = headers(PHONE, session);
    expect((await fetch(`${url}/api/account/delete`, { method: 'POST', headers: h, body: JSON.stringify({ username: 'mike' }) })).status).toBe(403);
    await googleSignIn(PHONE, { sub: 'g-1', mode: 'confirm', session });
    expect((await fetch(`${url}/api/account/delete`, { method: 'POST', headers: h, body: JSON.stringify({ username: 'nope' }) })).status).toBe(401);
    expect((await fetch(`${url}/api/account/delete`, { method: 'POST', headers: h, body: JSON.stringify({ username: 'mike' }) })).status).toBe(200);
    // Signing in with that Google account again makes a brand new account.
    expect((await googleSignIn(LAPTOP, { sub: 'g-1', name: 'Mike' })).finished!.welcome).toBe(true);
  });

  it('a Google link started by someone else cannot be finished in another browser', async () => {
    // The attacker starts a sign-in as their guest and sends Google's address to a victim.
    const attacker = await begin(PHONE);
    const google = new URL(attacker.body.url!);
    // The victim's browser comes back without the attacker's cookie.
    expect(await callback(google, '', { sub: 'victim', name: 'Victim' })).toEqual({ error: 'other-browser' });
    // Nothing was made, and the attacker's guest is still a plain guest.
    expect((await sessionOf(PHONE)).account).toBeNull();
  });

  it('a finished ticket only works in the browser and for the guest that started it', async () => {
    const a = await begin(PHONE);
    const fragment = await callback(new URL(a.body.url!), a.cookie, { sub: 'g-1', name: 'Mike' });
    // Sent to another browser: no cookie, a different guest.
    expect((await finish(fragment.ticket, LAPTOP, '')).body.code).toBe('other-browser');
    // And it was used up by that try.
    expect((await finish(fragment.ticket, PHONE, a.cookie)).body.code).toBe('expired');

    const b = await begin(PHONE);
    const second = await callback(new URL(b.body.url!), b.cookie, { sub: 'g-1', name: 'Mike' });
    // Same cookie copied, but a different guest.
    expect((await finish(second.ticket, LAPTOP, b.cookie)).body.code).toBe('other-browser');
  });

  it('linking checks the account is still signed in on that browser', async () => {
    const up = await fetch(`${url}/api/account/signup`, { method: 'POST', headers: headers(PHONE), body: JSON.stringify({ username: 'Mike', password: 'correct horse' }) });
    const session = ((await up.json()) as { session: string }).session;
    const a = await begin(PHONE, { mode: 'link', session, password: 'correct horse' });
    const fragment = await callback(new URL(a.body.url!), a.cookie, { sub: 'g-9' });
    await fetch(`${url}/api/account/signout`, { method: 'POST', headers: headers(PHONE, session) });
    expect((await finish(fragment.ticket, PHONE, a.cookie)).status).toBe(403);
  });

  it('an admin password reset also unlinks Google, so the account is back in the owner’s hands', async () => {
    const up = await fetch(`${url}/api/account/signup`, { method: 'POST', headers: headers(PHONE), body: JSON.stringify({ username: 'Mike', password: 'correct horse' }) });
    const session = ((await up.json()) as { session: string }).session;
    await googleSignIn(PHONE, { sub: 'g-9', mode: 'link', session, password: 'correct horse' });
    const issued = await fetch(`${url}/api/admin/accounts/reset-code`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'test-admin-key-0123456789' }, body: JSON.stringify({ username: 'Mike' }) });
    const { code } = (await issued.json()) as { code: string };
    expect((await fetch(`${url}/api/account/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Mike', code, password: 'brand new pw' }) })).status).toBe(200);
    // That Google account now makes a new account rather than opening Mike's.
    expect((await googleSignIn(LAPTOP, { sub: 'g-9', name: 'Someone' })).finished!.welcome).toBe(true);
  });
});
