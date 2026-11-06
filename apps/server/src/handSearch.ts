// Hand search: every hand I was dealt, across all my tables, filtered by who
// was there, the game, my cards, the pot size and how it went for me. Results
// come as I saw them (my cards and whatever was shown), ready for the replayer,
// and any of them can become a share link.

import express from 'express';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { BettingKind } from '@rsdp/engine/core';
import { BETTING_KINDS } from '@rsdp/engine/settings';
import { gameTitle, getVariant } from '@rsdp/engine/variants';
import type { SharedHandView } from '@rsdp/engine/wire';
import { schema, type Db } from './db';
import { playersForAccount, whoIs } from './identity';
import { clientAddress, limiter } from './admin';
import { pastHandFromRow, type SavedHeader } from './storage';
import { savedHandView } from './runtime/view';
import type { PastHand, RuntimeState } from './runtime/types';
import { newId } from './db/ids';
import type { SharedHandStore } from './shared';

const { hands, tableSnapshots } = schema;

/** Hands sent back per page. */
const PAGE = 20;
/** Saved hands looked through per request at most, so a rare filter can't read everything at once. */
const SCAN_MAX = 3_000;
const BATCH = 300;
/** Searches one address may run per minute. */
const SEARCHES_PER_MINUTE = 30;
const SHARES_PER_MINUTE = 20;

export interface HandFilter {
  /** Part of another player's name. */
  player?: string;
  gameId?: string;
  /** No limit, pot limit or limit; with no game, any game played that way. */
  betting?: BettingKind;
  /** My cards: ranks like "AA", "AK", "AKs", "72o", or exact cards like "AsKs". */
  cards?: string;
  /** Pots of at least this many big blinds. */
  minPotBb?: number;
  result?: 'won' | 'lost';
}

type CardTest = (cards: string[]) => boolean;

const RANK = (c: string) => c[0].toUpperCase();

/** Turns what was typed into a test on my cards; null when it can't be read. */
export function parseCards(input: string): CardTest | null {
  const text = input.replace(/\s+/g, '').replace(/10/g, 'T');
  if (!text) return () => true;
  // Exact cards: "As", "AsKs", "Td9d".
  if (/^([2-9TJQKA][cdhs])+$/i.test(text)) {
    const want = text.match(/../g)!.map((c) => c[0].toUpperCase() + c[1].toLowerCase());
    return (cards) => want.every((c) => cards.includes(c));
  }
  const m = /^([2-9TJQKA]+)([so])?$/i.exec(text);
  if (!m) return null;
  const ranks = m[1].toUpperCase().split('');
  const suited = m[2]?.toLowerCase();
  return (cards) => {
    // Each wanted rank takes a different card.
    const left = [...cards];
    const used: string[] = [];
    for (const r of ranks) {
      const i = left.findIndex((c) => RANK(c) === r);
      if (i < 0) return false;
      used.push(left.splice(i, 1)[0]);
    }
    if (!suited || used.length < 2) return true;
    const same = used.every((c) => c[1] === used[0][1]);
    return suited === 's' ? same : !same;
  };
}

/** Every card dealt to a seat (all of them for stud and draw games: up, down and drawn). */
function cardsOf(past: PastHand, seat: number): string[] {
  const out: string[] = [];
  for (const e of past.events) {
    if (e.t === 'deal' && e.seat === seat) out.push(...e.cards.map((c) => c.card));
    else if (e.t === 'draw' && e.seat === seat) out.push(...e.cards);
  }
  return out;
}

/** What a seat's stack did over the hand, side games included. */
function netOf(past: PastHand, seat: number): number | null {
  let end: Record<number, number> | null = null;
  for (const e of past.events) {
    if (e.t === 'hand-end') end = { ...e.stacks };
    else if (e.t === 'transfer' && end) {
      if (e.from !== 'house' && end[e.from] !== undefined) end[e.from] -= e.amount;
      if (e.to !== 'house' && end[e.to] !== undefined) end[e.to] += e.amount;
    }
  }
  const start = past.seats.find((x) => x.seat === seat)?.startStack;
  return end && start !== undefined && end[seat] !== undefined ? end[seat] - start : null;
}

/** Chips awarded from every pot of the hand. */
export function potOf(past: PastHand): number {
  let pot = 0;
  for (const e of past.events) if (e.t === 'award') pot += e.amount;
  return pot;
}

const isBetting = (v: unknown): v is BettingKind => (BETTING_KINDS as readonly unknown[]).includes(v);

/** The betting a hand was played with: hands saved before it was kept played their game's usual betting. */
export function bettingOf(gameId: string | undefined, betting: unknown): BettingKind | undefined {
  if (isBetting(betting)) return betting;
  try {
    return gameId ? getVariant(gameId).defaultBetting : undefined;
  } catch {
    return undefined;
  }
}

/** The big blind, or for games without blinds the big bet, so pots compare across stakes. */
const unit = (past: PastHand) => past.stakes.bigBlind || past.stakes.bigBet || past.stakes.smallBet || 1;

export function matches(past: PastHand, mySeat: number, names: (playerId: string) => string, f: HandFilter & { cardTest?: CardTest | null }): boolean {
  const start = past.events[0]?.t === 'hand-start' ? past.events[0] : null;
  if (f.gameId && start && start.gameId !== f.gameId) return false;
  // As the games list reads it: from the saved header, which is what past.betting holds.
  if (f.betting && bettingOf(start?.gameId ?? f.gameId, past.betting) !== f.betting) return false;
  if (f.player) {
    const want = f.player.toLowerCase();
    if (!past.seats.some((x) => x.seat !== mySeat && names(x.playerId).toLowerCase().includes(want))) return false;
  }
  if (f.minPotBb && potOf(past) < f.minPotBb * unit(past)) return false;
  if (f.result) {
    const net = netOf(past, mySeat);
    if (net === null || (f.result === 'won' ? net <= 0 : net >= 0)) return false;
  }
  if (f.cardTest && !f.cardTest(cardsOf(past, mySeat))) return false;
  return true;
}

interface Row {
  id: string;
  tableId: string;
  number: number;
  startedAt: Date;
  endedAt: Date | null;
  header: SavedHeader;
  events: PastHand['events'];
}

/** Table names, money format, size, felt and seat names, from each table's saved state. */
type Snap = Partial<RuntimeState> & { settings?: RuntimeState['settings'] };

export function handSearchRoutes(
  app: express.Express,
  db: Db | null,
  opts: { shared: SharedHandStore; now: () => number; log: (message: string, err?: unknown) => void; liveFair?: (tableId: string) => RuntimeState['fair'] | null | undefined },
) {
  const { shared, now, log } = opts;
  const searches = limiter(SEARCHES_PER_MINUTE, 60_000, now);
  const shares = limiter(SHARES_PER_MINUTE, 60_000, now);
  const json = express.json({ limit: '2kb' });

  const liveFairOf = (snap: Snap | undefined, tableId: string): Snap | undefined => {
    const fair = opts.liveFair?.(tableId);
    return fair === undefined ? snap : { ...snap, fair: fair ?? undefined };
  };

  async function me(req: express.Request, db: Db) {
    const who = await whoIs(db, req.get('x-guest-token') ?? '', req.get('x-session-token'), { now: new Date(now()) });
    const ids = who.account ? (await playersForAccount(db, who.account.id)).map((p) => p.id) : [who.player.id];
    if (!ids.includes(who.player.id)) ids.push(who.player.id);
    return { who, ids };
  }

  const dealtTo = (ids: string[]) => or(...ids.map((id) => sql`${hands.header} -> 'seats' @> ${JSON.stringify([{ playerId: id }])}::jsonb`));

  async function snapsOf(tableIds: string[]) {
    if (tableIds.length === 0) return new Map<string, Snap>();
    const rows = await db!.select({ tableId: tableSnapshots.tableId, state: tableSnapshots.state }).from(tableSnapshots).where(inArray(tableSnapshots.tableId, tableIds));
    return new Map(rows.map((r) => [r.tableId, r.state as Snap]));
  }

  const nameIn = (snap: Snap | undefined) => (id: string) =>
    snap?.seats?.find((x) => x?.playerId === id)?.name ?? snap?.ledger?.[id]?.name ?? snap?.handNames?.[id] ?? 'Guest';

  const fail = (res: express.Response, e: unknown) => {
    log('hand search failed', e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  };

  app.get('/api/hands/search', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!db) return void res.status(503).json({ error: 'Hand search is not available on this server.' });
    if (!searches(clientAddress(req))) return void res.status(429).json({ error: 'Too many searches. Wait a minute and try again.' });
    const q = req.query;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 40) : '');
    const filter: HandFilter = {
      player: str(q.player) || undefined,
      gameId: str(q.game) || undefined,
      betting: isBetting(str(q.betting)) ? (str(q.betting) as BettingKind) : undefined,
      cards: str(q.cards) || undefined,
      minPotBb: Number(q.minPot) > 0 ? Number(q.minPot) : undefined,
      result: q.result === 'won' || q.result === 'lost' ? q.result : undefined,
    };
    const cardTest = filter.cards ? parseCards(filter.cards) : null;
    if (filter.cards && !cardTest) return void res.status(400).json({ error: 'Type cards like AA, AKs, 72o or AsKs.' });
    // The page continues after this hand (time, then id).
    const before = /^\d+:[\w-]+$/.test(str(q.before)) ? str(q.before).split(':') : null;

    (async () => {
      const { ids } = await me(req, db);
      const found: { row: Row; past: PastHand; seat: number }[] = [];
      let cursor = before ? { at: new Date(Number(before[0])), id: before[1] } : null;
      let scanned = 0;
      let done = false;
      const snaps = new Map<string, Snap>();
      while (!done && found.length < PAGE && scanned < SCAN_MAX) {
        const rows = (await db
          .select()
          .from(hands)
          .where(and(dealtTo(ids), cursor ? or(lt(hands.startedAt, cursor.at), and(eq(hands.startedAt, cursor.at), lt(hands.id, cursor.id))) : undefined))
          .orderBy(desc(hands.startedAt), desc(hands.id))
          .limit(BATCH)) as Row[];
        const fresh = [...new Set(rows.map((r) => r.tableId))].filter((id) => !snaps.has(id));
        for (const [id, s] of await snapsOf(fresh)) snaps.set(id, s);
        let read = 0;
        for (const row of rows) {
          read++;
          scanned++;
          cursor = { at: row.startedAt, id: row.id };
          const past = pastHandFromRow(row);
          const seat = past.seats.find((x) => ids.includes(x.playerId))?.seat;
          if (seat !== undefined && matches(past, seat, nameIn(snaps.get(row.tableId)), { ...filter, cardTest })) found.push({ row, past, seat });
          if (found.length >= PAGE) break;
        }
        // The oldest hand has been read.
        done = rows.length < BATCH && read === rows.length;
      }
      const results = found.map(({ row, past }) => {
        const snap = snaps.get(row.tableId);
        const mine = past.seats.find((x) => ids.includes(x.playerId))!.playerId;
        return {
          handId: row.id,
          tableId: row.tableId,
          tableName: snap?.settings?.table.name ?? '',
          centsMode: !!snap?.settings?.stakes.centsMode,
          seatCount: snap?.seats?.length ?? 9,
          felt: snap?.settings?.table.felt ?? null,
          myId: mine,
          pot: potOf(past),
          // Reveals follow the running table when it is loaded: its save can lag behind a game started again.
          hand: savedHandView(liveFairOf(snap, row.tableId), past, mine, { now: now() }),
        };
      });
      // The next page carries on after the last hand read (a search that stopped at SCAN_MAX too).
      const next = !done && cursor ? `${cursor.at.getTime()}:${cursor.id}` : null;
      res.json({ hands: results, next, scanned });
    })().catch((e) => fail(res, e));
  });

  // The games I've played, for the search form's list: one entry per game and betting (Limit and No-Limit Hold'em apart).
  app.get('/api/hands/games', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!db) return void res.status(503).json({ error: 'Hand search is not available on this server.' });
    if (!searches(clientAddress(req))) return void res.status(429).json({ error: 'Too many searches. Wait a minute and try again.' });
    (async () => {
      const { ids } = await me(req, db);
      const rows = await db
        .select({ gameId: hands.gameId, betting: sql<string>`${hands.header} -> 'input' ->> 'betting'`, n: sql<number>`count(*)::int` })
        .from(hands)
        .where(dealtTo(ids))
        .groupBy(hands.gameId, sql`${hands.header} -> 'input' ->> 'betting'`);
      const byGame = new Map<string, { id: string; betting?: BettingKind; name: string; hands: number }>();
      for (const r of rows) {
        // Older hands without a betting saved join their game's usual one.
        const betting = bettingOf(r.gameId, r.betting);
        const key = `${r.gameId} ${betting ?? ''}`;
        const g = byGame.get(key) ?? { id: r.gameId, betting, name: gameTitle(r.gameId, betting), hands: 0 };
        g.hands += Number(r.n);
        byGame.set(key, g);
      }
      res.json({ games: [...byGame.values()].sort((a, b) => b.hands - a.hands) });
    })().catch((e) => fail(res, e));
  });

  // A share link for one of my hands, like the table's Share button.
  app.post('/api/hands/share', json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!db) return void res.status(503).json({ error: 'Sharing is not available on this server.' });
    if (!shares(clientAddress(req))) return void res.status(429).json({ error: 'That is a lot of links; try again in a minute.' });
    const handId = typeof req.body?.handId === 'string' ? req.body.handId : '';
    if (!/^[\w-]{10,40}$/.test(handId)) return void res.status(404).json({ error: 'No such hand.' });
    (async () => {
      const { who, ids } = await me(req, db);
      const [row] = (await db.select().from(hands).where(eq(hands.id, handId))) as Row[];
      const past = row && pastHandFromRow(row);
      const mine = past?.seats.find((x) => ids.includes(x.playerId))?.playerId;
      // Only a hand I played: anything else answers the same as a missing one.
      if (!row || !mine) return void res.status(404).json({ error: 'No such hand.' });
      const snap = (await snapsOf([row.tableId])).get(row.tableId);
      const id = newId();
      const createdAt = now();
      const hideMine = req.body?.hideMine === true;
      const snapshot: SharedHandView = {
        id,
        tableName: snap?.settings?.table.name ?? '',
        centsMode: !!snap?.settings?.stakes.centsMode,
        seatCount: snap?.seats?.length ?? 9,
        felt: snap?.settings?.table.felt ?? null,
        sharedBy: who.player.displayName || nameIn(snap)(mine),
        // Which cards are mine, so the replay shows them; a link that hides them doesn't say.
        ...(hideMine ? {} : { sharerSeat: past.seats.find((x) => x.playerId === mine)!.seat }),
        createdAt,
        hand: savedHandView(snap, past, mine, { hideMine }),
      };
      await shared.create({ id, tableId: row.tableId, handNumber: row.number, createdBy: who.player.id, snapshot });
      res.json({ id });
    })().catch((e) => fail(res, e));
  });
}
