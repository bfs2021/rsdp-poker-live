import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';

/**
 * A fresh in-memory PGlite database with every migration applied. Startup
 * takes about a second, so share one per test file and call resetTestDb
 * between tests. Close it with closeDb.
 */
export function createTestDb(): Promise<Db> {
  return createDb({ ignoreEnv: true });
}

/** Empties every table (TRUNCATE bypasses the ledger's append-only trigger, which guards rows, not tables). */
export async function resetTestDb(db: Db): Promise<void> {
  const names = [
    'audit_log',
    'ops_log',
    'suggestions',
    'feedback',
    'player_notes',
    'saved_setups',
    'jobs',
    'tournaments',
    'hidden_tables',
    'practice_resets',
    'hands',
    'table_log',
    'chip_movements',
    'seat_sessions',
    'settings_changes',
    'table_snapshots',
    'tables',
    'sessions',
    'player_tokens',
    'accounts',
    'players',
  ];
  await db.execute(sql.raw(`truncate table ${names.join(', ')} restart identity cascade`));
}
