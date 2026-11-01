/**
 * Cash game analytics: a player's results table by table (the profit graph)
 * and the group's leaderboards. Only real games count: tables where two or
 * more people played and no practice bot was ever dealt in, so nobody climbs
 * the board by beating bots. Amounts are in cents: cents-mode tables already
 * are, and a chip counts as one whole unit (100).
 */

import { inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import { queryRows } from './client';
import { botIdsOf } from '../runtime/types';
import { tableBots } from './history';
import { players, tableSnapshots } from './schema';

/** The parts of a runtime snapshot analytics reads. */
interface SnapState {
  seats?: ({ playerId: string; stack: number } | null)[];
  ledger?: Record<string, { buyIn: number; cashOut: number; bot?: boolean }>;
  bots?: Record<string, unknown>;
  handNames?: Record<string, string>;
  settings?: { table?: { name?: string }; stakes?: { centsMode?: boolean } };
}

/** tableNets without the table's bots (botIdsOf), which never go on the boards. */
function peopleNets(state: SnapState): Map<string, number> {
  const nets = tableNets(state);
  for (const id of botIdsOf(state)) nets.delete(id);
  return nets;
}

/** Chips at a table to cents. */
export const toCents = (amount: number, centsMode: boolean) => (centsMode ? amount : amount * 100);

/** Each player's chips won (above 0) or lost at a table: cash-outs and the stack still in play, less buy-ins. */
export function tableNets(state: SnapState | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, row] of Object.entries(state?.ledger ?? {})) out.set(id, (out.get(id) ?? 0) + row.cashOut - row.buyIn);
  for (const seat of state?.seats ?? []) if (seat) out.set(seat.playerId, (out.get(seat.playerId) ?? 0) + seat.stack);
  return out;
}

interface HandRow {
  table_id: string;
  started_at: Date | string;
  /** Who was dealt in, by seat. */
  seats: { seat: number; playerId: string }[];
  /** Chips each seat was awarded from the pots. */
  awards: { seat: number; amount: number }[] | null;
}

/** Light rows for every cash hand. Tournament tables are saved with mode 'tournament' and no tournament_id, so both are checked. */
async function cashHands(db: Db): Promise<HandRow[]> {
  return queryRows<HandRow & Record<string, unknown>>(
    db,
    sql`select h.table_id, h.started_at,
          (select coalesce(jsonb_agg(jsonb_build_object('seat', s -> 'seat', 'playerId', s -> 'playerId')), '[]'::jsonb)
             from jsonb_array_elements(h.header -> 'seats') s) as seats,
          (select jsonb_agg(jsonb_build_object('seat', e -> 'seat', 'amount', e -> 'amount'))
             from jsonb_array_elements(h.events) e where e ->> 't' = 'award') as awards
        from hands h join tables t on t.id = h.table_id
        where t.tournament_id is null and t.mode <> 'tournament'
        order by h.started_at`,
  );
}

/**
 * Tables that count: some hand had two or more people, and no hand had a bot.
 * Who is a bot comes from each table's snapshot (tableBots), never the 'bot-' prefix.
 */
async function realTables(db: Db, rows: HandRow[]): Promise<Set<string>> {
  const botsAt = await tableBots(db, [...new Set(rows.map((r) => r.table_id))]);
  const people = new Set<string>();
  const bots = new Set<string>();
  for (const r of rows) {
    if (r.seats.some((s) => botsAt.get(r.table_id)?.has(s.playerId))) bots.add(r.table_id);
    else if (r.seats.length >= 2) people.add(r.table_id);
  }
  return new Set([...people].filter((id) => !bots.has(id)));
}

async function snapshots(db: Db, tableIds: string[]): Promise<Map<string, SnapState>> {
  if (tableIds.length === 0) return new Map();
  const rows = await db.select({ tableId: tableSnapshots.tableId, state: tableSnapshots.state }).from(tableSnapshots).where(inArray(tableSnapshots.tableId, tableIds));
  return new Map(rows.map((r) => [r.tableId, r.state as SnapState]));
}

// ---------------------------------------------------------------- the profit graph

export interface ProfitSession {
  tableId: string;
  name: string;
  /** When the player's last hand there started. */
  at: Date;
  hands: number;
  /** Cents won (above 0) or lost. */
  net: number;
}

/** My result at every real cash game I played, oldest first. Tables I hid are left out. */
export async function profitSessions(db: Db, playerIds: string[]): Promise<ProfitSession[]> {
  if (playerIds.length === 0) return [];
  const mine = new Set(playerIds);
  const dealt = sql.join(
    playerIds.map((id) => sql`h.header -> 'seats' @> ${JSON.stringify([{ playerId: id }])}::jsonb`),
    sql` or `,
  );
  // Every hand of each table I was dealt into, so a table's other players count when deciding if it was a real game.
  const myTables = await queryRows<{ table_id: string }>(
    db,
    sql`select distinct h.table_id from hands h join tables t on t.id = h.table_id
        where t.tournament_id is null and t.mode <> 'tournament' and (${dealt})
          and not exists (select 1 from hidden_tables x where x.table_id = h.table_id and x.player_id in (${sql.join(playerIds.map((id) => sql`${id}`), sql`, `)}))`,
  );
  if (myTables.length === 0) return [];
  const ids = myTables.map((r) => r.table_id);
  const rows = await queryRows<HandRow & Record<string, unknown>>(
    db,
    sql`select h.table_id, h.started_at,
          (select coalesce(jsonb_agg(jsonb_build_object('seat', s -> 'seat', 'playerId', s -> 'playerId')), '[]'::jsonb)
             from jsonb_array_elements(h.header -> 'seats') s) as seats,
          null as awards
        from hands h where h.table_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
  );
  const real = await realTables(db, rows);
  const mineAt = new Map<string, { at: number; hands: number }>();
  for (const r of rows) {
    if (!real.has(r.table_id) || !r.seats.some((s) => mine.has(s.playerId))) continue;
    const t = new Date(r.started_at).getTime();
    const cur = mineAt.get(r.table_id) ?? { at: 0, hands: 0 };
    mineAt.set(r.table_id, { at: Math.max(cur.at, t), hands: cur.hands + 1 });
  }
  const snaps = await snapshots(db, [...mineAt.keys()]);
  const out: ProfitSession[] = [];
  for (const [tableId, { at, hands }] of mineAt) {
    const state = snaps.get(tableId);
    if (!state?.ledger) continue;
    const nets = tableNets(state);
    let net = 0;
    for (const id of mine) net += nets.get(id) ?? 0;
    out.push({ tableId, name: state.settings?.table?.name ?? '', at: new Date(at), hands, net: toCents(net, !!state.settings?.stakes?.centsMode) });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ---------------------------------------------------------------- the practice graph

interface PracticeHandRow {
  table_id: string;
  started_at: Date | string;
  seats: { seat: number; playerId: string; startStack: number }[];
  /** Every seat's stack at the end of the hand, and any chips moved after it (a late show claiming a 7-2 bounty). */
  end: Record<string, number> | null;
  after: { from: number | 'house'; to: number | 'house'; amount: number }[] | null;
}

/** What one seat's stack did over a hand: like the replayer's handNet (apps/web/src/replay.ts). */
function seatNet(row: PracticeHandRow, seat: { seat: number; startStack: number }): number {
  if (!row.end || row.end[seat.seat] === undefined) return 0;
  let stack = Number(row.end[seat.seat]);
  for (const t of row.after ?? []) {
    if (t.from === seat.seat) stack -= t.amount;
    if (t.to === seat.seat) stack += t.amount;
  }
  return stack - seat.startStack;
}

/**
 * My results at practice tables (bots, or on my own), oldest first, for the
 * practice graph. It adds up each hand I was dealt since `since` (a reset),
 * so a table played across a reset only counts its later hands. Tables I hid
 * are left out, and so is every real game.
 */
export async function practiceSessions(db: Db, playerIds: string[], since: Date | null = null): Promise<ProfitSession[]> {
  if (playerIds.length === 0) return [];
  const mine = new Set(playerIds);
  const ids = sql.join(playerIds.map((id) => sql`${id}`), sql`, `);
  const dealt = sql.join(
    playerIds.map((id) => sql`h.header -> 'seats' @> ${JSON.stringify([{ playerId: id }])}::jsonb`),
    sql` or `,
  );
  const myTables = await queryRows<{ table_id: string }>(
    db,
    sql`select distinct h.table_id from hands h join tables t on t.id = h.table_id
        where t.tournament_id is null and t.mode <> 'tournament' and (${dealt})
          ${since ? sql`and h.started_at > ${since}` : sql``}
          and not exists (select 1 from hidden_tables x where x.table_id = h.table_id and x.player_id in (${ids}))`,
  );
  if (myTables.length === 0) return [];
  const real = await realGameTablesOf(db, myTables.map((r) => r.table_id));
  const practice = myTables.map((r) => r.table_id).filter((id) => !real.has(id));
  if (practice.length === 0) return [];
  const rows = await queryRows<PracticeHandRow & Record<string, unknown>>(
    db,
    sql`select h.table_id, h.started_at,
          (select coalesce(jsonb_agg(jsonb_build_object('seat', s -> 'seat', 'playerId', s -> 'playerId', 'startStack', s -> 'startStack')), '[]'::jsonb)
             from jsonb_array_elements(h.header -> 'seats') s) as seats,
          (select e -> 'stacks' from jsonb_array_elements(h.events) with ordinality as x(e, n) where e ->> 't' = 'hand-end' order by n desc limit 1) as end,
          (select jsonb_agg(jsonb_build_object('from', e -> 'from', 'to', e -> 'to', 'amount', e -> 'amount') order by n)
             from jsonb_array_elements(h.events) with ordinality as x(e, n)
             where e ->> 't' = 'transfer' and n > (select max(m) from jsonb_array_elements(h.events) with ordinality as y(f, m) where f ->> 't' = 'hand-end')) as after
        from hands h
        where h.table_id in (${sql.join(practice.map((id) => sql`${id}`), sql`, `)}) and (${dealt})
          ${since ? sql`and h.started_at > ${since}` : sql``}`,
  );
  const byTable = new Map<string, { at: number; hands: number; net: number }>();
  for (const r of rows) {
    const cur = byTable.get(r.table_id) ?? { at: 0, hands: 0, net: 0 };
    cur.at = Math.max(cur.at, new Date(r.started_at).getTime());
    cur.hands++;
    for (const seat of r.seats) if (mine.has(seat.playerId)) cur.net += seatNet(r, seat);
    byTable.set(r.table_id, cur);
  }
  const snaps = await snapshots(db, [...byTable.keys()]);
  const out: ProfitSession[] = [];
  for (const [tableId, { at, hands, net }] of byTable) {
    const state = snaps.get(tableId);
    out.push({ tableId, name: state?.settings?.table?.name ?? '', at: new Date(at), hands, net: toCents(net, !!state?.settings?.stakes?.centsMode) });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** realTables over every hand of these tables, so hands from before a reset still decide whether a table was a real game. */
async function realGameTablesOf(db: Db, tableIds: string[]): Promise<Set<string>> {
  const rows = await queryRows<HandRow & Record<string, unknown>>(
    db,
    sql`select h.table_id, h.started_at,
          (select coalesce(jsonb_agg(jsonb_build_object('seat', s -> 'seat', 'playerId', s -> 'playerId')), '[]'::jsonb)
             from jsonb_array_elements(h.header -> 'seats') s) as seats,
          null as awards
        from hands h where h.table_id in (${sql.join(tableIds.map((id) => sql`${id}`), sql`, `)})`,
  );
  return realTables(db, rows);
}

// ---------------------------------------------------------------- leaderboards

export interface LeaderRow {
  /** The account, or the guest player when there is no account. */
  key: string;
  name: string;
  /** Cents won (above 0) or lost at real games last played in the period. */
  profit: number;
  /** Real games played in the period. */
  sessions: number;
  hands: number;
  /** The most cents won in one hand. */
  biggestPot: number;
  /** Each real game's result in the period, oldest first (the leaderboard's graph). */
  games: { at: number; net: number }[];
}

/** What the leaderboards need from a real game's snapshot. */
interface LeaderTable {
  /** Each person's chips won (above 0) or lost there; the table's bots are left out. */
  nets: Map<string, number>;
  centsMode: boolean;
  /** The name each player used there. */
  names: Record<string, string>;
}

/**
 * What the leaderboards are worked out from: every real game's hands, read
 * once, and the games and accounts the boards have needed so far, each read once.
 */
export interface LeaderData {
  /** Only real games' hands: practice and bot tables never count, so they aren't kept. */
  hands: HandRow[];
  real: Set<string>;
  /** When each real game's last hand started. */
  lastHand: Map<string, number>;
  /** By table; null when the table has no snapshot. */
  tables: Map<string, LeaderTable | null>;
  /** By player; null when there is no such player. */
  owners: Map<string, { accountId: string | null; displayName: string } | null>;
}

/**
 * Reads every cash hand, the read that grows with the group's history. Every
 * period, from any time zone, can then be worked out from this one read
 * (leaderboard), which reads the rest as it needs it.
 */
export async function leaderData(db: Db): Promise<LeaderData> {
  const all = await cashHands(db);
  // Whether a table is real depends on all its hands, not only the period's.
  const real = await realTables(db, all);
  const hands = all.filter((r) => real.has(r.table_id));
  const lastHand = new Map<string, number>();
  for (const r of hands) if (real.has(r.table_id)) lastHand.set(r.table_id, Math.max(lastHand.get(r.table_id) ?? 0, new Date(r.started_at).getTime()));
  return { hands, real, lastHand, tables: new Map(), owners: new Map() };
}

/**
 * Everyone's results at real cash games since `since` (all time without it).
 * A table's result counts in the period its last hand was played in. The
 * hands come from `data`; games and accounts no earlier board needed are read
 * now, and kept in `data` for the next board.
 */
export async function leaderboard(db: Db, data: LeaderData, since?: Date): Promise<LeaderRow[]> {
  const { hands: all, real, lastHand } = data;
  const from = since?.getTime() ?? -Infinity;
  const inPeriod = [...lastHand].filter(([, at]) => at >= from).map(([id]) => id);
  const handTables = new Set(all.filter((r) => real.has(r.table_id) && new Date(r.started_at).getTime() >= from).map((r) => r.table_id));
  const periodTables = [...new Set([...inPeriod, ...handTables])];
  const unread = periodTables.filter((id) => !data.tables.has(id));
  const read = await snapshots(db, unread);
  // Only what the boards use is kept, not the whole snapshot.
  for (const id of unread) {
    const state = read.get(id);
    data.tables.set(id, state ? { nets: peopleNets(state), centsMode: !!state.settings?.stakes?.centsMode, names: { ...state.handNames } } : null);
  }
  const snaps = new Map<string, LeaderTable>();
  for (const id of periodTables) {
    const t = data.tables.get(id);
    if (t) snaps.set(id, t);
  }
  const cents = (tableId: string, amount: number) => toCents(amount, !!snaps.get(tableId)?.centsMode);

  const rows = new Map<string, { profit: number; sessions: Set<string>; hands: number; biggestPot: number; games: Map<string, { at: number; net: number }> }>();
  const row = (playerId: string) => {
    let r = rows.get(playerId);
    if (!r) rows.set(playerId, (r = { profit: 0, sessions: new Set(), hands: 0, biggestPot: 0, games: new Map() }));
    return r;
  };
  for (const tableId of inPeriod) {
    for (const [playerId, net] of snaps.get(tableId)?.nets ?? []) {
      const r = row(playerId);
      r.profit += cents(tableId, net);
      r.sessions.add(tableId);
      r.games.set(tableId, { at: lastHand.get(tableId)!, net: cents(tableId, net) });
    }
  }
  for (const h of all) {
    if (!real.has(h.table_id) || new Date(h.started_at).getTime() < from) continue;
    const won = new Map<number, number>();
    for (const a of h.awards ?? []) won.set(a.seat, (won.get(a.seat) ?? 0) + a.amount);
    for (const s of h.seats) {
      const r = row(s.playerId);
      r.hands++;
      r.sessions.add(h.table_id);
      r.biggestPot = Math.max(r.biggestPot, cents(h.table_id, won.get(s.seat) ?? 0));
    }
  }
  if (rows.size === 0) return [];

  const unknown = [...rows.keys()].filter((id) => !data.owners.has(id));
  if (unknown.length) {
    const found = await db
      .select({ id: players.id, accountId: players.accountId, displayName: players.displayName })
      .from(players)
      .where(inArray(players.id, unknown));
    for (const id of unknown) data.owners.set(id, null);
    for (const p of found) data.owners.set(p.id, p);
  }
  // The name each player last used at a table, newest table first.
  const names = new Map<string, string>();
  const byRecent = [...snaps.keys()].sort((a, b) => (lastHand.get(b) ?? 0) - (lastHand.get(a) ?? 0));
  for (const tableId of byRecent) for (const [id, name] of Object.entries(snaps.get(tableId)?.names ?? {})) if (name && !names.has(id)) names.set(id, name);

  // One row per account: a friend's phone and laptop are one person.
  const merged = new Map<string, Omit<LeaderRow, 'games'> & { sessionIds: Set<string>; byTable: Map<string, { at: number; net: number }> }>();
  for (const [playerId, r] of rows) {
    const p = data.owners.get(playerId);
    const key = p?.accountId ?? playerId;
    const m = merged.get(key) ?? { key, name: '', profit: 0, sessions: 0, hands: 0, biggestPot: 0, sessionIds: new Set<string>(), byTable: new Map() };
    m.name ||= p?.displayName || names.get(playerId) || '';
    m.profit += r.profit;
    m.hands += r.hands;
    m.biggestPot = Math.max(m.biggestPot, r.biggestPot);
    for (const id of r.sessions) m.sessionIds.add(id);
    // Two of one account's devices at one table are one game.
    for (const [id, g] of r.games) m.byTable.set(id, { at: g.at, net: (m.byTable.get(id)?.net ?? 0) + g.net });
    merged.set(key, m);
  }
  return [...merged.values()]
    .map(({ sessionIds, byTable, ...m }) => ({
      ...m,
      name: m.name || 'Guest',
      sessions: sessionIds.size,
      games: [...byTable.values()].sort((a, b) => a.at - b.at),
    }))
    .sort((a, b) => b.profit - a.profit || b.hands - a.hands);
}
