import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app';
import { closeDb, queryRows, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { opsLine, opsRecorder, recapWindow, type Recap } from '../src/recap';

const ADMIN = 'test-admin-key-0123456789';
const REPORT = 'test-report-key-0123456789';
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await resetTestDb(db);
});

async function serve(fn: (url: string, server: ReturnType<typeof createApp>) => Promise<void>) {
  const server = createApp({
    accounts: db,
    adminKey: ADMIN,
    reportKey: REPORT,
    log: () => {},
  });
  await new Promise<void>((r) => server.http.listen(0, r));
  const url = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
  try {
    await fn(url, server);
  } finally {
    await server.close();
  }
}

const get = (url: string, key?: string) => fetch(url, { headers: key ? { 'x-admin-key': key } : {} });

describe('game-night recap', { timeout: 30_000 }, () => {
  it('needs the admin key or the report key, and the report key opens nothing else', async () => {
    await serve(async (url) => {
      expect((await get(`${url}/api/admin/recap`)).status).toBe(401);
      expect((await get(`${url}/api/admin/recap`, 'wrong-key-0123456789')).status).toBe(401);
      expect((await get(`${url}/api/admin/recap`, ADMIN)).status).toBe(200);
      expect((await get(`${url}/api/admin/recap`, REPORT)).status).toBe(200);
      // The read-only key can't download the database or look up a table.
      expect((await get(`${url}/api/admin/backup`, REPORT)).status).toBe(401);
      expect((await get(`${url}/api/admin/tables/abcdef`, REPORT)).status).toBe(401);
    });
  });

  it('counts wrong keys against one limit across the admin routes and the recap', async () => {
    await serve(async (url) => {
      for (let i = 0; i < 5; i++) await get(`${url}/api/admin/backup`, `wrong-key-${i}-0123456789`);
      for (let i = 0; i < 5; i++) await get(`${url}/api/admin/recap`, `wrong-key-${i}-0123456789`);
      expect((await get(`${url}/api/admin/backup`, 'wrong-key-x-0123456789')).status).toBe(429);
      expect((await get(`${url}/api/admin/recap`, 'wrong-key-y-0123456789')).status).toBe(429);
    });
  });

  it('counts errors, tells a clean restart from a crash, finds late tournaments, and reads no chat', async () => {
    const t0 = Date.parse('2026-11-04T23:00:00Z');
    const at = (min: number) => new Date(t0 + min * 60_000);
    await db.execute(sql`insert into players (id) values ('p1')`);
    await db.execute(sql`insert into tables (id, owner_player_id, settings, mode) values ('cash1', 'p1', '{}', 'cash'), ('tn1:t1', 'p1', '{}', 'tournament')`);
    for (const [id, table, n, min] of [
      ['h1', 'cash1', 1, 5],
      ['h2', 'cash1', 2, 10],
      ['h3', 'tn1:t1', 1, 20],
    ] as const)
      await db.execute(
        sql`insert into hands (id, table_id, number, game_id, started_at, header, events) values (${id}, ${table}, ${n}, 'nlhe', ${at(min)}, '{}', '[]')`,
      );
    // An hour earlier than the window: not counted.
    await db.execute(
      sql`insert into hands (id, table_id, number, game_id, started_at, header, events) values ('h0', 'cash1', 0, 'nlhe', ${at(-200)}, '{}', '[]')`,
    );
    await db.execute(sql`insert into table_log (table_id, kind, at, item) values
      ('cash1', 'chat', ${at(6)}, ${JSON.stringify({ playerId: 'p1', name: 'Somebody', text: 'nice hand' })}),
      ('cash1', 'chat', ${at(7)}, ${JSON.stringify({ playerId: 'p1', name: 'Somebody', text: 'my screen froze, see /t/abc123' })}),
      ('tn1:t1', 'chat', ${at(21)}, ${JSON.stringify({ playerId: 'p1', name: 'Somebody', text: 'the timer is stuck' })})`);
    const state = {
      settings: {
        name: 'Wednesday game',
        start: { kind: 'scheduled', startAt: t0 },
      },
      entries: [{}, {}, {}],
      startAt: t0,
      startedAt: t0 + 3 * 60_000,
      finishedAt: null,
    };
    await db.execute(sql`insert into tournaments (id, host_player_id, status, state) values ('tn1', 'p1', 'running', ${JSON.stringify(state)})`);
    // Due in the window but never started, and last saved days before.
    const stuck = {
      settings: {
        name: 'Stuck one',
        start: { kind: 'scheduled', startAt: t0 + 60 * 60_000 },
      },
      entries: [{}],
      startAt: t0 + 60 * 60_000,
      startedAt: null,
      finishedAt: null,
    };
    await db.execute(
      sql`insert into tournaments (id, host_player_id, status, state, updated_at) values ('tn2', 'p1', 'registering', ${JSON.stringify(stuck)}, ${at(-5000)})`,
    );
    await db.execute(sql`insert into feedback (created_at, player_id, name, kind, text, table_id, mode) values
      (${at(8)}, 'p1', 'Somebody', 'problem', 'cards froze', 'cash1', 'cash'), (${at(-300)}, 'p1', 'Somebody', 'idea', 'old', 'cash1', 'cash')`);
    await db.execute(sql`insert into ops_log (at, kind, message) values
      (${at(30)}, 'server', 'saving table failed: timeout'),
      (${at(31)}, 'server', 'saving table failed: timeout'),
      (${at(32)}, 'browser', 'browser error (uncaught) on /t/:id: x is undefined'),
      (${at(40)}, 'stop', 'server stopping')`);
    // A clean restart (stop line just before), then a crash 5 minutes later (that stop was the earlier start's), then
    // a crash long after.
    await db.execute(sql`insert into audit_log (seq, at, kind, data, prev, hash) values
      (1, ${t0 + 41 * 60_000}, 'boot', '{"commit":"abc1234"}', '', 'h1'),
      (2, ${t0 + 46 * 60_000}, 'boot', '{"commit":"abc1234"}', 'h1', 'h2'),
      (3, ${t0 + 90 * 60_000}, 'boot', '{"commit":"abc1234"}', 'h2', 'h3')`);

    await serve(async (url) => {
      const res = await get(`${url}/api/admin/recap?from=${at(0).toISOString()}&to=${at(120).toISOString()}`, REPORT);
      const recap = (await res.json()) as Recap;
      expect(recap.quiet).toBe(false);
      expect(recap.activity).toEqual({
        hands: 3,
        cashTables: 1,
        tournamentTables: 1,
        cashHands: 2,
        tournamentHands: 1,
      });
      expect(recap.feedback).toEqual({ problem: 1, idea: 0, other: 0 });
      expect(recap.restarts.map((r) => r.clean)).toEqual([true, false, false]);
      expect(recap.errors[0]).toMatchObject({
        kind: 'server',
        message: 'saving table failed: timeout',
        count: 2,
      });
      expect(recap.errors[1]).toMatchObject({ kind: 'browser', count: 1 });
      expect(recap.tournaments).toEqual([
        expect.objectContaining({
          name: 'Wednesday game',
          status: 'running',
          start: 'scheduled',
          entries: 3,
          lateByMinutes: 3,
          finishedAt: null,
          didNotStart: false,
        }),
        expect.objectContaining({
          name: 'Stuck one',
          status: 'registering',
          lateByMinutes: null,
          didNotStart: true,
        }),
      ]);
      // No chat at all (issue #300), and no names.
      expect(JSON.stringify(recap)).not.toMatch(/froze|timer is stuck|nice hand/);
      expect(JSON.stringify(recap)).not.toContain('cards froze');
      expect(JSON.stringify(recap)).not.toContain('Somebody');
    });
  });

  it('calls a night with no hands quiet', async () => {
    await serve(async (url) => {
      const recap = (await (await get(`${url}/api/admin/recap?hours=12`, ADMIN)).json()) as Recap;
      expect(recap.quiet).toBe(true);
      expect(recap.activity.hands).toBe(0);
    });
  });

  it('keeps the server error lines, and a clean stop line when it closes', async () => {
    await serve(async (_url, server) => {
      server.log('saving table failed for /t/secret-link', new Error('connection reset'));
    });
    const rows = await queryRows<{ kind: string; message: string }>(db, sql`select kind, message from ops_log order by n`);
    expect(rows).toEqual([
      {
        kind: 'server',
        message: 'saving table failed for /t/:id: connection reset',
      },
      { kind: 'stop', message: 'server stopping' },
    ]);
  });

  it('marks a stop for an uncaught error as a crash, not a clean stop', async () => {
    const server = createApp({ accounts: db, adminKey: ADMIN, log: () => {} });
    await new Promise<void>((r) => server.http.listen(0, r));
    await server.close({ crash: new Error('boom') });
    const rows = await queryRows<{ kind: string; message: string }>(db, sql`select kind, message from ops_log order by n`);
    expect(rows).toEqual([
      {
        kind: 'server',
        message: 'server stopping after an uncaught error: boom',
      },
    ]);
  });

  it('drops lines older than 30 days when the server starts', async () => {
    const now = Date.parse('2026-11-05T12:00:00Z');
    await db.execute(
      sql`insert into ops_log (at, kind, message) values (${new Date(now - 31 * 86_400_000)}, 'server', 'old'), (${new Date(now - 86_400_000)}, 'server', 'new')`,
    );
    await opsRecorder(db, () => now).stopping();
    const rows = await queryRows<{ message: string }>(db, sql`select message from ops_log order by n`);
    expect(rows.map((r) => r.message)).toEqual(['new', 'server stopping']);
  });
});

describe('recap helpers', () => {
  it('reads the window', () => {
    const now = Date.parse('2026-11-05T12:00:00Z');
    expect(recapWindow({}, now)).toEqual({
      from: new Date('2026-11-04T12:00:00Z'),
      to: new Date(now),
    });
    expect(recapWindow({ hours: '6' }, now)).toEqual({
      from: new Date('2026-11-05T06:00:00Z'),
      to: new Date(now),
    });
    expect(recapWindow({ from: '2026-11-05T13:00:00Z' }, now)).toBe('from must be before to.');
    expect(recapWindow({ hours: '200' }, now)).toMatch(/at most/);
    expect(recapWindow({ to: 'nonsense' }, now)).toMatch(/ISO/);
    expect(recapWindow({ to: '1' }, now)).toMatch(/ISO/);
    expect(recapWindow({ from: ['2026-11-05T01:00:00Z', 'x'] }, now)).toMatch(/ISO/);
    expect(recapWindow({ hours: '' }, now)).toEqual({ from: new Date('2026-11-04T12:00:00Z'), to: new Date(now) });
    expect(recapWindow({ hours: '0' }, now)).toMatch(/above 0/);
    // With from given, hours is ignored.
    expect(recapWindow({ from: '2026-11-05T01:00:00Z', hours: 'x' }, now)).toEqual({ from: new Date('2026-11-05T01:00:00Z'), to: new Date(now) });
  });

  it('takes table, tournament and hand ids out of server lines', () => {
    expect(opsLine('saving table Ab3_x9KqLm failed')).toBe('saving table :id failed');
    expect(opsLine('tournament V1StGXR8_Z5jdHi6B-myT: seating at table V1StGXR8_Z5jdHi6B-myT:t2 failed')).toBe('tournament :id: seating at table :id failed');
    // Ordinary words and numbers stay.
    expect(opsLine('database health check: answering again after 12000 ms')).toBe('database health check: answering again after 12000 ms');
  });

  it('keeps one short line', () => {
    expect(opsLine('a\nb', new Error('c'))).toBe('a | b: c');
    expect(opsLine('x'.repeat(600))).toHaveLength(500);
  });
});
