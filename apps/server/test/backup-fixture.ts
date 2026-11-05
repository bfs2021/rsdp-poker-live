import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { queryRows, type Db } from '../src/db';
import { backupLines, writeBackup } from '../src/db/backup';

/** Past what a JavaScript number holds exactly: a restore must not round it. */
export const BIG = '9007199254740993';

/** A row in every table, with the awkward bits: players and accounts pointing at each other, jsonb, timestamps, counters. */
export async function fill(target: Db) {
  const q = (s: string) => target.execute(sql.raw(s));
  await q(`insert into players (id, display_name) values ('p1', 'Mike'), ('p2', 'Zoë "the rock" O''Neil')`);
  await q(`insert into accounts (id, username, password_hash, primary_player_id, google_sub) values ('a1', 'mike', 'scrypt$x', 'p1', 'g-123')`);
  await q(`update players set account_id = 'a1' where id = 'p1'`);
  await q(`insert into player_tokens (token_hash, player_id) values ('th1', 'p1'), ('th2', 'p2')`);
  await q(`insert into sessions (id, account_id, token_hash, expires_at) values ('s1', 'a1', 'sh1', '2030-01-01T00:00:00.123456Z')`);
  await q(`insert into tables (id, owner_player_id, settings, mode) values ('t1', 'p1', '{"table":{"name":"Friday 🃏"},"blinds":[1,2]}', 'cash')`);
  await q(`insert into table_snapshots (table_id, version, state) values ('t1', 3, '{"hand":{"deck":["As","Kd"]},"nested":{"a":[null,true,1.5]}}')`);
  await q(`insert into settings_changes (id, table_id, actor_player_id, changes, effective_hand) values ('sc1', 't1', 'p1', '[{"path":"blinds","to":[2,4]}]', 4)`);
  await q(`insert into seat_sessions (id, table_id, player_id, seat) values ('ss1', 't1', 'p2', 3)`);
  await q(`insert into chip_movements (id, table_id, seat_session_id, player_id, kind, amount, stack_before, stack_after) values ('m1', 't1', 'ss1', 'p2', 'buy-in', 200, 0, 200)`);
  await q(`insert into hands (id, table_id, number, game_id, started_at, header, events) values ('h1', 't1', 1, 'nlh', now(), '{"seats":[]}', '[{"type":"deal"}]')`);
  await q(`insert into table_log (table_id, kind, at, item) values ('t1', 'log', now(), '{"text":"Mike joined"}'), ('t1', 'chat', now(), '{"playerId":"p1","name":"Mike","text":"gl 🃏"}')`);
  await q(`insert into hidden_tables (player_id, table_id) values ('p2', 't1')`);
  await q(`insert into practice_resets (player_id, reset_at) values ('p1', '2026-10-27T00:00:00.654321Z')`);
  await q(`insert into jobs (id, kind, run_at, payload) values ('j1', 'start', now(), '{"x":1}')`);
  await q(`insert into player_avatars (player_id, kind, value) values ('p1', 'upload', 'data:image/png;base64,iVBORw0KGgo=')`);
  await q(`insert into player_notes (owner_player_id, target_player_id, text, color) values ('p1', 'p2', 'bluffs\nthe river', 'red')`);
  await q(`insert into saved_setups (player_id, kind, name, json) values ('p1', 'table', 'Home game', '{"a":1}')`);
  await q(`insert into shared_hands (id, table_id, hand_number, created_by, snapshot) values ('sh-0123456789', 't1', 1, 'p1', '{"x":1}')`);
  await q(`insert into suggestions (name, title) values ('Mike', 'Bomb pots'), ('Zoë', 'Stud')`);
  await q(`insert into tournaments (id, host_player_id, status, state) values ('tn1', 'p1', 'running', '{"level":3}')`);
  await q(`insert into tournament_log (tournament_id, item_id, at, item) values ('tn1', 'i1', now(), '{"k":"bust"}'), ('tn1', 'i2', now(), '{"k":"win"}')`);
  await q(`insert into audit_log (seq, at, kind, data, prev, hash) values (1, ${BIG}, 'boot', '{"commit":"abc"}', '0', 'h')`);
  await q(`insert into ops_log (at, kind, message) values (now(), 'server', 'saving table failed: timeout')`);
}

/** Every row of every table, as Postgres prints it, so two databases can be compared whole. */
export async function everything(target: Db) {
  const tables = await queryRows<{ t: string }>(target, sql`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
  const out: Record<string, string[]> = {};
  for (const { t } of tables) {
    const rows = await queryRows<{ j: string }>(target, sql.raw(`select row_to_json(x)::text as j from "${t}" x`));
    out[t] = rows.map((r) => r.j).sort();
  }
  return out;
}

export async function backupOf(source: Db) {
  const lines: string[] = [];
  const summary = await writeBackup(source, (l) => void lines.push(l));
  return { text: lines.join(''), summary };
}

export const linesOf = (text: string) => backupLines(Readable.from(gzipSync(text)));

