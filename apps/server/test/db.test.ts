import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, MIGRATIONS_DIR, queryRows, type Db } from '../src/db/client';
import { createTestDb } from '../src/db/testing';
import { createTable, loadSnapshot, saveSnapshot } from '../src/db/tables';

let db: Db | undefined;
afterEach(async () => {
  if (db) await closeDb(db);
  db = undefined;
});

describe('createDb', () => {
  it('applies every migration to a fresh in-memory database', async () => {
    db = await createTestDb();
    const rows = await queryRows<{ table_name: string }>(
      db,
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'accounts',
      'audit_log',
      'chip_movements',
      'feedback',
      'hands',
      'hidden_tables',
      'jobs',
      'player_avatars',
      'player_notes',
      'player_tokens',
      'players',
      'practice_resets',
      'saved_setups',
      'seat_sessions',
      'sessions',
      'settings_changes',
      'shared_hands',
      'suggestions',
      'table_log',
      'table_snapshots',
      'tables',
      'tournament_log',
      'tournaments',
    ]);
  });

  it('gives each test database its own data', async () => {
    db = await createTestDb();
    const other = await createTestDb();
    try {
      await db.execute(sql`insert into players (id) values ('only-here')`);
      expect(await queryRows(db, sql`select id from players`)).toHaveLength(1);
      expect(await queryRows(other, sql`select id from players`)).toHaveLength(0);
    } finally {
      await closeDb(other);
    }
  });

  it('ignores DATABASE_URL and PGLITE_DIR when asked to', async () => {
    const saved = { url: process.env.DATABASE_URL, dir: process.env.PGLITE_DIR };
    process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/nothing';
    process.env.PGLITE_DIR = '/nonexistent/should-not-be-used';
    try {
      db = await createDb({ ignoreEnv: true });
      expect(await queryRows(db, sql`select 1 as one`)).toEqual([{ one: 1 }]);
    } finally {
      if (saved.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved.url;
      if (saved.dir === undefined) delete process.env.PGLITE_DIR;
      else process.env.PGLITE_DIR = saved.dir;
    }
  });

  it('keeps PGlite data in a directory across restarts and migrates only once', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rsdp-pglite-'));
    try {
      const first = await createDb({ pgliteDir: dir, ignoreEnv: true });
      await first.execute(sql`insert into players (id, display_name) values ('kept', 'Kept')`);
      await closeDb(first);

      db = await createDb({ pgliteDir: dir, ignoreEnv: true });
      expect(await queryRows(db, sql`select id, display_name from players`)).toEqual([{ id: 'kept', display_name: 'Kept' }]);
      const migrations = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      expect(migrations[0].n).toBe(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length);
      await closeDb(db);
      db = undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('vacuuming PGlite', () => {
    // A table's snapshot, rewritten on every change; random text so compression can't hide its size.
    const snapshot = (n: number) => ({ version: n, state: { n, log: Array.from({ length: 300 }, () => Math.random().toString(36).repeat(3)) } });
    const snapshotBytes = async (d: Db) =>
      Number((await queryRows<{ size: string }>(d, sql`select pg_total_relation_size('table_snapshots') as size`))[0].size);
    const saveOften = async (d: Db, times: number, pause = 0) => {
      await d.execute(sql`insert into players (id) values ('host') on conflict do nothing`);
      const table = await createTable(d, { id: 'vacuum-t', ownerPlayerId: 'host', settings: {} });
      for (let n = 1; n <= times; n++) {
        await saveSnapshot(d, table.id, snapshot(n));
        if (pause) await new Promise((r) => setTimeout(r, pause));
      }
      return table.id;
    };
    const checkpointAt = async (d: Db) =>
      (await queryRows<{ redo: string }>(d, sql`select redo_lsn::text as redo from pg_control_checkpoint()`))[0].redo;
    const HOUR = 3_600_000;

    it('gives back the space old snapshots took when it opens', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'rsdp-pglite-'));
      try {
        const first = await createDb({ pgliteDir: dir, ignoreEnv: true, vacuumEveryMs: HOUR });
        const id = await saveOften(first, 150);
        const bloated = await snapshotBytes(first);
        await closeDb(first);

        db = await createDb({ pgliteDir: dir, ignoreEnv: true, vacuumEveryMs: HOUR });
        expect(await snapshotBytes(db)).toBeLessThan(bloated / 10);
        expect((await loadSnapshot<{ n: number }>(db, id))?.state.n).toBe(150);
        await closeDb(db);
        db = undefined;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('vacuums as it goes, so saving a snapshot over and over does not keep growing the database', async () => {
      const never = await createDb({ ignoreEnv: true, vacuumEveryMs: HOUR });
      try {
        const neverFrom = await checkpointAt(never);
        await saveOften(never, 120, 5);
        db = await createDb({ ignoreEnv: true, vacuumEveryMs: 20 });
        const from = await checkpointAt(db);
        await saveOften(db, 120, 5);
        expect(await snapshotBytes(db)).toBeLessThan((await snapshotBytes(never)) / 3);
        // PGlite only checkpoints when told to, and until it does the write-ahead log keeps every save.
        expect(await checkpointAt(never)).toBe(neverFrom);
        expect(await checkpointAt(db)).not.toBe(from);
      } finally {
        await closeDb(never);
      }
    }, 30_000);
  });
});
