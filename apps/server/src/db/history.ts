/** A player's own record across tables and tournaments, for the profile page. */

import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { queryRows } from './client';
import { hands, hiddenTables, practiceResets, tables, tableSnapshots, tournaments } from './schema';

export interface TableHistoryRow {
  tableId: string;
  name: string;
  hands: number;
  lastPlayedAt: Date;
  /** Chips won (above 0) or lost across the player's ids at this table, from its ledger; null when unknown. */
  net: number | null;
  centsMode: boolean;
  /** Practice, not a real game: a bot was dealt in, or nobody else ever played. Left out of results. */
  practice: boolean;
}

export interface TournamentHistoryRow {
  id: string;
  name: string;
  status: string;
  /** When it finished, or failing that started, or was made. */
  at: Date;
  entrants: number;
  /** Best finishing place among the player's entries; null while still playing or not placed. */
  place: number | null;
  prize: number;
  hosted: boolean;
}

/** The parts of a runtime snapshot the history reads. */
interface LedgerState {
  seats?: ({ playerId: string; stack: number } | null)[];
  ledger?: Record<string, { buyIn: number; cashOut: number }>;
  bots?: Record<string, unknown>;
  settings?: { stakes?: { centsMode?: boolean } };
}

/**
 * Cash tables where any of `playerIds` was dealt a hand, most recent first.
 * Tables any of them hid are left out, or with `hidden`, are the only ones listed.
 */
export async function tableHistory(db: Db, playerIds: string[], limit = 25, opts: { hidden?: boolean } = {}): Promise<TableHistoryRow[]> {
  if (playerIds.length === 0) return [];
  const dealt = or(...playerIds.map((id) => sql`${hands.header} -> 'seats' @> ${JSON.stringify([{ playerId: id }])}::jsonb`));
  const hiddenByMe = sql`exists (select 1 from ${hiddenTables} where ${hiddenTables.tableId} = ${hands.tableId} and ${inArray(hiddenTables.playerId, playerIds)})`;
  const rows = await db
    .select({
      tableId: hands.tableId,
      hands: sql<number>`count(*)::int`,
      lastPlayedAt: sql<Date>`max(${hands.startedAt})`,
      name: sql<string>`coalesce(${tables.settings} -> 'table' ->> 'name', '')`,
    })
    .from(hands)
    .innerJoin(tables, sql`${tables.id} = ${hands.tableId}`)
    .where(and(isNull(tables.tournamentId), ne(tables.mode, 'tournament'), dealt, opts.hidden ? hiddenByMe : sql`not ${hiddenByMe}`))
    .groupBy(hands.tableId, tables.settings)
    .orderBy(desc(sql`max(${hands.startedAt})`))
    .limit(limit);
  if (rows.length === 0) return [];

  const snaps = await db
    .select({ tableId: tableSnapshots.tableId, state: tableSnapshots.state })
    .from(tableSnapshots)
    .where(inArray(tableSnapshots.tableId, rows.map((r) => r.tableId)));
  const byTable = new Map(snaps.map((s) => [s.tableId, s.state as LedgerState | undefined]));
  const mine = new Set(playerIds);
  const real = await realGameTables(db, rows.map((r) => r.tableId));

  return rows.map((r) => {
    const state = byTable.get(r.tableId);
    let net: number | null = null;
    if (state?.ledger) {
      net = 0;
      for (const [id, row] of Object.entries(state.ledger)) if (mine.has(id)) net += row.cashOut - row.buyIn;
      for (const seat of state.seats ?? []) if (seat && mine.has(seat.playerId)) net += seat.stack;
    }
    return {
      tableId: r.tableId,
      name: r.name,
      hands: Number(r.hands),
      lastPlayedAt: new Date(r.lastPlayedAt),
      net,
      centsMode: !!state?.settings?.stakes?.centsMode,
      practice: !real.has(r.tableId),
    };
  });
}

/**
 * Every practice bot each of these tables has had, by table, read from its
 * snapshot as botIdsOf does: its bots, and the ledger rows flagged as bots.
 * Never the 'bot-' prefix: a person's id can start with it too.
 */
export async function tableBots(db: Db, tableIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (tableIds.length === 0) return out;
  const rows = await queryRows<{ table_id: string; player_id: string }>(
    db,
    sql`select t.table_id, b.player_id from ${tableSnapshots} t, lateral (
          select jsonb_object_keys(case when jsonb_typeof(t.state -> 'bots') = 'object' then t.state -> 'bots' else '{}'::jsonb end) as player_id
          union
          select key from jsonb_each(case when jsonb_typeof(t.state -> 'ledger') = 'object' then t.state -> 'ledger' else '{}'::jsonb end)
            where jsonb_typeof(value) = 'object' and value ->> 'bot' = 'true'
        ) b
        where ${inArray(sql`t.table_id`, tableIds)}`,
  );
  for (const r of rows) {
    const ids = out.get(r.table_id) ?? new Set<string>();
    ids.add(r.player_id);
    out.set(r.table_id, ids);
  }
  return out;
}

/**
 * Of these tables, the real games: some hand had two or more people, and no
 * hand ever had a practice bot (see tableBots). Everything else is practice
 * (play against bots, or someone trying a table alone) and stays out of results.
 */
export async function realGameTables(db: Db, tableIds: string[]): Promise<Set<string>> {
  if (tableIds.length === 0) return new Set();
  const rows = await queryRows<{ table_id: string; most: number; dealt: string[] }>(
    db,
    sql`select h.table_id, max(jsonb_array_length(h.header -> 'seats'))::int as most, jsonb_agg(distinct s -> 'playerId') as dealt
        from ${hands} h, jsonb_array_elements(h.header -> 'seats') s
        where ${inArray(sql`h.table_id`, tableIds)}
        group by h.table_id`,
  );
  const bots = await tableBots(db, tableIds);
  return new Set(rows.filter((r) => Number(r.most) >= 2 && !r.dealt.some((id) => bots.get(r.table_id)?.has(id))).map((r) => r.table_id));
}

/**
 * Hides a cash table from a player's profile, or shows it again. Showing it
 * again clears the mark from every id in `playerIds` (an account's devices).
 * Returns false when there is no such table.
 */
export async function setTableHidden(db: Db, playerId: string, playerIds: string[], tableId: string, hidden: boolean): Promise<boolean> {
  const [table] = await db.select({ id: tables.id }).from(tables).where(eq(tables.id, tableId));
  if (!table) return false;
  if (hidden) await db.insert(hiddenTables).values({ playerId, tableId }).onConflictDoNothing();
  else await db.delete(hiddenTables).where(and(eq(hiddenTables.tableId, tableId), inArray(hiddenTables.playerId, [...new Set([playerId, ...playerIds])])));
  return true;
}

/**
 * Who played at a cash table, for deleting a practice game from a profile:
 * whether it was practice (see realGameTables), whether any of `playerIds` was
 * dealt in there, whether any other person (not a bot) ever was, and whether
 * the table is theirs (they made it, outside any club). Null when there is no
 * such cash table.
 */
export async function practiceTableUse(
  db: Db,
  tableId: string,
  playerIds: string[],
): Promise<{ practice: boolean; mine: boolean; others: boolean; owner: boolean } | null> {
  const [table] = await db
    .select({ tournamentId: tables.tournamentId, mode: tables.mode, ownerPlayerId: tables.ownerPlayerId, clubId: tables.clubId })
    .from(tables)
    .where(eq(tables.id, tableId));
  if (!table || table.tournamentId || table.mode === 'tournament') return null;
  const dealt = await queryRows<{ player_id: string }>(
    db,
    sql`select distinct s ->> 'playerId' as player_id from ${hands} h, jsonb_array_elements(h.header -> 'seats') s where h.table_id = ${tableId}`,
  );
  const mine = new Set(playerIds);
  const bots = (await tableBots(db, [tableId])).get(tableId);
  const people = dealt.map((r) => r.player_id).filter((id) => !bots?.has(id));
  const real = await realGameTables(db, [tableId]);
  return {
    practice: !real.has(tableId),
    mine: people.some((id) => mine.has(id)),
    others: people.some((id) => !mine.has(id)),
    owner: !table.clubId && mine.has(table.ownerPlayerId),
  };
}

/** When the practice graph was last reset on any of `playerIds` (an account's devices), or null if never. */
export async function practiceResetAt(db: Db, playerIds: string[]): Promise<Date | null> {
  if (playerIds.length === 0) return null;
  const rows = await db.select({ at: practiceResets.resetAt }).from(practiceResets).where(inArray(practiceResets.playerId, playerIds));
  return rows.reduce<Date | null>((a, r) => (!a || r.at > a ? r.at : a), null);
}

/** Starts the practice graph again from `now`. */
export async function resetPracticeGraph(db: Db, playerId: string, now: Date = new Date()): Promise<void> {
  await db.insert(practiceResets).values({ playerId, resetAt: now }).onConflictDoUpdate({ target: practiceResets.playerId, set: { resetAt: now } });
}

/** Rows of `tournaments` that any of `playerIds` hosted or entered, newest first. */
export async function tournamentRows<S = unknown>(db: Db, playerIds: string[], limit = 25): Promise<{ id: string; hostPlayerId: string; state: S; updatedAt: Date }[]> {
  if (playerIds.length === 0) return [];
  const entered = playerIds.map((id) => sql`${tournaments.state} -> 'entries' @> ${JSON.stringify([{ playerId: id }])}::jsonb`);
  const rows = await db
    .select({ id: tournaments.id, hostPlayerId: tournaments.hostPlayerId, state: tournaments.state, updatedAt: tournaments.updatedAt })
    .from(tournaments)
    .where(or(inArray(tournaments.hostPlayerId, playerIds), ...entered))
    .orderBy(desc(tournaments.updatedAt))
    .limit(limit);
  return rows as { id: string; hostPlayerId: string; state: S; updatedAt: Date }[];
}
