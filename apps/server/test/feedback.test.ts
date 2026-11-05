import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, queryRows, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { deleteAccount } from '../src/identity/identity';
import { cleanFeedback, dbFeedback, FEEDBACK_KEEP_MS } from '../src/feedback';
import { dbIdentity, dbStore } from '../src/storage';
import { FakeClock } from './fake-clock';
import { socketClient, type Client } from './socket-client';

const KEY = 'test-admin-key-0123456789';
let db: Db;
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let url = '';
let clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  clock = new FakeClock();
  clock.t = Date.parse('2026-11-05T20:00:00Z');
  clients = [];
  server = createApp({
    clock,
    identity: dbIdentity(db),
    store: dbStore(db),
    feedback: dbFeedback(db, () => clock.now()),
    adminKey: KEY,
    build: { commit: '0123456789abcdef0123', image: null, machine: null },
    log: (m, e) => console.error(m, e),
  });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
});

afterAll(async () => {
  await closeDb(db);
});

type Row = { id: number; name: string; kind: string; text: string; tableId: string; tableName: string; mode: string; game: string; handNumber: number; seated: boolean; screen: string; commit: string; done: boolean; createdAt: string; playerId: string };

const admin = (method: string, path = '', body?: object, key = KEY) =>
  fetch(`${url}/api/feedback${path}`, { method, headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: body && JSON.stringify(body) });
const list = async (q = '') => ((await (await admin('GET', q)).json()) as { feedback: Row[] }).feedback;

async function atTable(token = 'feedback-host-0123456789') {
  const host = client(token);
  await host.call('session:name', { name: 'Mike' });
  const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Friday game' } } });
  await host.call('table:join', { tableId });
  return { host, tableId };
}

describe('feedback from the table', () => {
  it('saves what was said with the table, hand, build and screen, for the admin only', async () => {
    const { host, tableId } = await atTable();
    await host.call('feedback:send', { kind: 'problem', text: '  The timer\u0007 jumped\n\n\n\nafter the river  ', screen: 'phone' });

    expect(await list()).toMatchObject([
      { name: 'Mike', kind: 'problem', text: 'The timer jumped\n\nafter the river', tableId, tableName: 'Friday game', mode: 'cash', handNumber: 0, seated: false, screen: 'phone', commit: '0123456789ab', done: false, createdAt: '2026-11-05T20:00:00.000Z' },
    ]);
    // Nobody else can read it.
    expect((await fetch(`${url}/api/feedback`)).status).toBe(401);
    expect((await admin('GET', '', undefined, 'wrong-key-0123456789')).status).toBe(401);
  });

  it('needs a table, a kind and some words, not too many', async () => {
    const lost = client('feedback-lost-0123456789');
    await expect(lost.call('feedback:send', { kind: 'idea', text: 'hello' })).rejects.toThrow('join a table first');
    const { host } = await atTable();
    await expect(host.call('feedback:send', { kind: 'rant', text: 'hello' })).rejects.toThrow('pick what kind');
    await expect(host.call('feedback:send', { kind: 'idea', text: '   ' })).rejects.toThrow('write something');
    await expect(host.call('feedback:send', { kind: 'idea', text: 'x'.repeat(1001) })).rejects.toThrow('under 1000');
    await host.call('feedback:send', { kind: 'idea', text: 'x'.repeat(1000), screen: 'a fridge' });
    expect((await list()).map((f) => f.screen)).toEqual(['']);
  });

  it('limits how much one player can send', async () => {
    const { host } = await atTable();
    for (let i = 0; i < 5; i++) await host.call('feedback:send', { kind: 'other', text: `note ${i}` });
    await expect(host.call('feedback:send', { kind: 'other', text: 'one more' })).rejects.toThrow('a lot of feedback');
    clock.advance(10 * 60_000 + 1);
    await host.call('feedback:send', { kind: 'other', text: 'later' });
    expect(await list()).toHaveLength(6);
  });

  it('lists newest first, or only since a time, and lets the admin mark and delete', async () => {
    const { host } = await atTable();
    await host.call('feedback:send', { kind: 'idea', text: 'first' });
    clock.advance(60 * 60_000);
    await host.call('feedback:send', { kind: 'idea', text: 'second' });
    expect((await list()).map((f) => f.text)).toEqual(['second', 'first']);
    expect((await list('?since=2026-11-05T20:30:00Z')).map((f) => f.text)).toEqual(['second']);
    expect((await admin('GET', '?since=yesterday')).status).toBe(400);

    const [second, first] = await list();
    expect((await admin('PATCH', `/${first.id}`, { done: true })).status).toBe(200);
    expect((await admin('PATCH', `/${first.id}`, { done: 'yes' })).status).toBe(400);
    expect((await admin('PATCH', '/999', { done: true })).status).toBe(404);
    expect((await admin('DELETE', `/${second.id}`)).status).toBe(200);
    expect((await admin('DELETE', `/${second.id}`)).status).toBe(404);
    expect(await list()).toMatchObject([{ text: 'first', done: true }]);
    expect((await fetch(`${url}/api/feedback/${first.id}`, { method: 'DELETE' })).status).toBe(401);
  });

  it('limits one address, however many new guests it makes', async () => {
    for (let i = 0; i < 2; i++) {
      const { host } = await atTable(`feedback-guest-${i}-0123456789`);
      for (let j = 0; j < 5; j++) await host.call('feedback:send', { kind: 'other', text: `note ${i}.${j}` });
    }
    const { host } = await atTable('feedback-guest-2-0123456789');
    await expect(host.call('feedback:send', { kind: 'other', text: 'one more' })).rejects.toThrow('a lot of feedback');
  });

  it('stops showing feedback after a year, even with nothing new sent', async () => {
    const { host } = await atTable();
    await host.call('feedback:send', { kind: 'idea', text: 'old' });
    clock.advance(FEEDBACK_KEEP_MS + 1);
    expect(await list()).toEqual([]);
    expect(await queryRows(db, sql`select id from feedback`)).toEqual([]);
  });

  it('forgets feedback after a year', async () => {
    const { host } = await atTable();
    await host.call('feedback:send', { kind: 'idea', text: 'old' });
    clock.advance(FEEDBACK_KEEP_MS + 1);
    await host.call('feedback:send', { kind: 'idea', text: 'new' });
    expect((await list()).map((f) => f.text)).toEqual(['new']);
  });

  it('goes when the sender deletes their account', async () => {
    const { host } = await atTable();
    await host.call('feedback:send', { kind: 'idea', text: 'mine' });
    const [{ playerId }] = await list();
    await db.execute(sql`insert into accounts (id, username, password_hash, primary_player_id) values ('a1', 'mike', 'scrypt$x', ${playerId})`);
    await db.execute(sql`update players set account_id = 'a1' where id = ${playerId}`);
    await deleteAccount(db, 'a1');
    expect(await queryRows(db, sql`select id from feedback`)).toEqual([]);
  });
});

describe('cleanFeedback', () => {
  it('keeps line breaks, drops control characters and squeezes space', () => {
    expect(cleanFeedback('a \t b\r\n c')).toBe('a b\nc');
    expect(cleanFeedback(42)).toBeNull();
    expect(cleanFeedback('')).toBeNull();
  });
});
