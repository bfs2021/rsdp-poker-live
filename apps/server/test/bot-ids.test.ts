// Who counts as a practice bot in saved results: the table's bots and the ledger rows bots keep for good, as
// TableRuntime.botBadge tells them, never the 'bot-' prefix. A person's id is random and can start with 'bot-' too
// (#274, after #268 did the same for hand search).

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { closeDb, createTable, leaderboard, leaderData, practiceSessions, practiceTableUse, profitSessions, realGameTables, saveHand, saveSnapshot, schema, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { realGameHand } from '../src/runtime/table';
import { botIdsOf } from '../src/runtime/types';
import { dbIdentity, dbStore } from '../src/storage';

const KEY = 'test-admin-key-0123456789';
let db: Db;

// A person whose id happens to start with 'bot-', and a real practice bot (flagged in the ledger, as bots always are).
const PERSON = 'bot-Xy9_k2PqLm3nRt5vW';
const BOT = 'bot-1a2b3c4d';

/** A finished cash table: its snapshot (with an old snapshot's missing realGame) and one hand dealt to `dealt`. */
async function table(id: string, dealt: string[], ledger: Record<string, { won: number; bot?: true }>, bots: Record<string, unknown> = {}) {
  await createTable(db, { id, ownerPlayerId: 'ann', settings: { table: { name: id } }, mode: 'cash' });
  await saveSnapshot(db, id, {
    version: 1,
    state: {
      id,
      hostId: 'ann',
      createdAt: Date.parse('2026-10-30T20:00:00Z'),
      handNumber: 1,
      hand: null,
      history: [],
      settings: { table: { name: id, mode: 'cash' }, stakes: { centsMode: true } },
      seats: [null, null],
      bots,
      ledger: Object.fromEntries(
        Object.entries(ledger).map(([pid, r]) => [pid, { playerId: pid, name: pid, buyIn: 10000, cashOut: 10000 + r.won, ...(r.bot ? { bot: true } : {}) }]),
      ),
      handNames: Object.fromEntries(dealt.map((pid) => [pid, pid === 'ann' ? 'Ann' : pid === PERSON ? 'Xy' : 'Robo'])),
    },
  });
  await saveHand(db, {
    id: `${id}-1`,
    tableId: id,
    number: 1,
    gameId: 'nlhe',
    startedAt: new Date('2026-10-30T20:00:00Z'),
    endedAt: new Date('2026-10-30T20:05:00Z'),
    header: { input: { game: { id: 'nlhe' }, betting: 'no-limit', stakes: { smallBlind: 50, bigBlind: 100 }, button: 0 }, seats: dealt.map((playerId, seat) => ({ seat, playerId, startStack: 10000 })) },
    events: [],
  });
}

beforeAll(async () => {
  db = await createTestDb();
  await db.insert(schema.players).values([
    { id: 'ann', displayName: 'Ann' },
    { id: PERSON, displayName: 'Xy' },
  ]);
  // Ann against a person whose id starts with 'bot-': a real game.
  await table('real', ['ann', PERSON], { ann: { won: 3000 }, [PERSON]: { won: -3000 } });
  // Ann against a bot still at the table, and against one that has left (only its flagged ledger row is left).
  await table('practice', ['ann', BOT], { ann: { won: 500 }, [BOT]: { won: -500, bot: true } }, { [BOT]: { ownerId: 'ann', ownerName: 'Ann', buyIn: 10000 } });
  await table('bot-left', ['ann', BOT], { ann: { won: 700 }, [BOT]: { won: -700, bot: true } });
});

afterAll(async () => {
  await closeDb(db);
});

describe("a person whose id starts with 'bot-'", () => {
  it('is a person to the saved table, and a real bot is still a bot', () => {
    const bots = botIdsOf({ bots: { [BOT]: {} }, ledger: { [PERSON]: {}, 'bot-gone': { bot: true } } });
    expect([...bots].sort()).toEqual([BOT, 'bot-gone']);
    const isBot = (id: string) => bots.has(id);
    expect(realGameHand([{ playerId: 'ann' }, { playerId: PERSON }], isBot)).toBe(true);
    expect(realGameHand([{ playerId: 'ann' }, { playerId: BOT }], isBot)).toBe(false);
  });

  it('plays real games: in profiles, practice graphs and deleting practice tables', async () => {
    expect([...(await realGameTables(db, ['real', 'practice', 'bot-left']))]).toEqual(['real']);
    expect(await practiceTableUse(db, 'real', ['ann'])).toMatchObject({ practice: false, mine: true, others: true });
    expect(await practiceTableUse(db, 'real', [PERSON])).toMatchObject({ practice: false, mine: true, others: true });
    expect(await practiceTableUse(db, 'practice', ['ann'])).toMatchObject({ practice: true, mine: true, others: false });
    expect(await practiceTableUse(db, 'bot-left', ['ann'])).toMatchObject({ practice: true, mine: true, others: false });

    expect((await profitSessions(db, [PERSON])).map((s) => [s.tableId, s.net])).toEqual([['real', -3000]]);
    expect((await profitSessions(db, ['ann'])).map((s) => s.tableId)).toEqual(['real']);
    expect((await practiceSessions(db, ['ann'])).map((s) => s.tableId).sort()).toEqual(['bot-left', 'practice']);
    expect(await practiceSessions(db, [PERSON])).toEqual([]);
  });

  it('is on the leaderboard, and bots never are', async () => {
    const rows = await leaderboard(db, await leaderData(db));
    expect(rows.map((r) => [r.name, r.profit, r.sessions])).toEqual([
      ['Ann', 3000, 1],
      ['Xy', -3000, 1],
    ]);
  });

  it('counts as a person when the server works out an old table’s real game, and on the admin page', async () => {
    const server = createApp({ identity: dbIdentity(db), store: dbStore(db), accounts: db, adminKey: KEY, log: () => {}, idleUnloadMs: 0 });
    await new Promise<void>((resolve) => server.http.listen(0, resolve));
    try {
      const url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
      const look = async (id: string) => (await (await fetch(`${url}/api/admin/tables/${id}`, { headers: { 'x-admin-key': KEY } })).json()) as { realGame: boolean; players: string[] };
      expect(await look('real')).toMatchObject({ realGame: true, players: ['Ann', 'Xy'] });
      expect(await look('practice')).toMatchObject({ realGame: false, players: ['Ann'] });
      expect(await look('bot-left')).toMatchObject({ realGame: false, players: ['Ann'] });
    } finally {
      await server.close();
    }
  });
});
