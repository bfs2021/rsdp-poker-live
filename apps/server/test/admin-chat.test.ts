// The operator can read any table's chat with the admin key (#300, D27), open or closed, cash or tournament.
// The read-only report key can't, and every read goes in the public record.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { subjectRef, type AuditEntry } from '@rsdp/engine';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, tableAddress } from '@rsdp/tournament';
import { createApp } from '../src/app';
import { tableName } from '../src/tournament/manager';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { dbLobbyStore } from '../src/tournament/lobby';
import { dbTournamentStore } from '../src/tournament/store';
import { socketClient, type Client } from './socket-client';

beforeAll(() => registerAllVariants(variants));

const KEY = 'admin-key-for-tests-0123';
const REPORT = 'report-key-for-tests-0123';
let db: Db | undefined;
let server: ReturnType<typeof createApp> | undefined;
let url = '';
const clients: Client[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  if (db) await closeDb(db);
  server = db = undefined;
});

async function start(d: Db) {
  server = createApp({
    identity: dbIdentity(d),
    store: dbStore(d),
    tournaments: dbTournamentStore(d),
    lobby: dbLobbyStore(d),
    accounts: d,
    adminKey: KEY,
    reportKey: REPORT,
    log: () => {},
  });
  await new Promise<void>((resolve) => server!.http.listen(0, resolve));
  url = `http://localhost:${(server!.http.address() as AddressInfo).port}`;
  return (token: string) => socketClient(url, token, clients);
}

type ChatRead = { kind: 'table' | 'tournament'; name: string; tables: { table: number; name: string; chat: { at: number; name: string; text: string }[] }[] };
const readChat = (id: string, key = KEY) => fetch(`${url}/api/admin/chat/${encodeURIComponent(id)}`, { headers: { 'x-admin-key': key } });
const adminEntries = async () =>
  ((await (await fetch(`${url}/api/audit/entries?after=0&kind=admin`)).json()) as { entries: AuditEntry[] }).entries.map((e) => e.data);

describe('the operator reading table chat', () => {
  it('reads a cash table after it closes, only with the admin key, and records each read', async () => {
    db = await createTestDb();
    let client = await start(db);
    const ana = client('achat-ana-secret-0000000');
    const ben = client('achat-ben-secret-0000000');
    const { tableId } = await ana.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Thursday' } } });
    await ana.call('table:join', { tableId });
    await ben.call('table:join', { tableId });
    await ana.call('chat:send', { text: 'nice hand' });
    await ben.call('chat:send', { text: 'ty' });
    await pause(300);

    // No key, a wrong key, and the read-only report key all get nothing, and nothing is recorded.
    expect((await fetch(`${url}/api/admin/chat/${tableId}`)).status).toBe(401);
    expect((await readChat(tableId, 'not-the-right-key-000')).status).toBe(401);
    expect((await readChat(tableId, REPORT)).status).toBe(401);
    expect((await readChat('no-such-table-000')).status).toBe(404);
    expect(await adminEntries()).toEqual([]);

    // A fresh server: the table is closed, and its chat comes from the database.
    await server!.close();
    client = await start(db);
    const res = await readChat(tableId);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as ChatRead;
    expect(body.kind).toBe('table');
    expect(body.name).toBe('Thursday');
    expect(body.tables[0].chat.map((c) => c.text)).toEqual(['nice hand', 'ty']);
    // Only the words, names and times: no player ids.
    expect(Object.keys(body.tables[0].chat[0]).sort()).toEqual(['at', 'name', 'text']);
    // The public record names the read, but only by a fingerprint of the table, never its link.
    expect(await adminEntries()).toEqual([{ action: 'read-table-chat', target: subjectRef('table', tableId) }]);
  }, 30_000);

  it('reads every table of a tournament, while it is still running', async () => {
    db = await createTestDb();
    const client = await start(db);
    const host = client('achat-host-secret-000000');
    const ana = client('achat-ana2-secret-000000');
    const ben = client('achat-ben2-secret-000000');
    for (const [c, name] of [[host, 'Host'], [ana, 'Ana'], [ben, 'Ben']] as const) await c.call('session:name', { name });
    const { id } = await host.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Feedback night', startingStack: 1000 }) });
    for (const c of [ana, ben]) await c.call('tournament:command', { id, command: { type: 'register' } });
    await host.call('tournament:command', { id, command: { type: 'startNow' } });
    const tableId = tableAddress(server!.tournaments.view(id)!.state.tables[0].id);
    await ana.call('table:join', { tableId });
    await ana.call('chat:send', { text: 'blinds felt fast' });
    await pause(300);

    const body = (await (await readChat(id)).json()) as ChatRead;
    expect(body.kind).toBe('tournament');
    expect(body.name).toBe('Feedback night');
    expect(body.tables.map((t) => [t.table, t.name])).toEqual([[1, tableName('Feedback night', 1)]]);
    expect(body.tables[0].chat.map((c) => `${c.name}: ${c.text}`)).toEqual(['Ana: blinds felt fast']);
    expect(await adminEntries()).toEqual([{ action: 'read-tournament-chat', target: subjectRef('tournament', id) }]);
  }, 30_000);
});
