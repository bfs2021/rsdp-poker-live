import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { closeDb, queryRows, type Db } from "../src/db";
import { createTestDb, resetTestDb } from "../src/db/testing";
import {
  opsLine,
  opsRecorder,
  recapWindow,
  soundsLikeAProblem,
  type Recap,
} from "../src/recap";

const ADMIN = "test-admin-key-0123456789";
const REPORT = "test-report-key-0123456789";
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

async function serve(
  fn: (url: string, server: ReturnType<typeof createApp>) => Promise<void>,
) {
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

const get = (url: string, key?: string) =>
  fetch(url, { headers: key ? { "x-admin-key": key } : {} });

describe("game-night recap", { timeout: 30_000 }, () => {
  it("needs the admin key or the report key, and the report key opens nothing else", async () => {
    await serve(async (url) => {
      expect((await get(`${url}/api/admin/recap`)).status).toBe(401);
      expect(
        (await get(`${url}/api/admin/recap`, "wrong-key-0123456789")).status,
      ).toBe(401);
      expect((await get(`${url}/api/admin/recap`, ADMIN)).status).toBe(200);
      expect((await get(`${url}/api/admin/recap`, REPORT)).status).toBe(200);
      // The read-only key can't download the database or look up a table.
      expect((await get(`${url}/api/admin/backup`, REPORT)).status).toBe(401);
      expect((await get(`${url}/api/admin/tables/abcdef`, REPORT)).status).toBe(
        401,
      );
    });
  });

  it("counts errors, tells a clean restart from a crash, and keeps problem-sounding chat without names", async () => {
    const t0 = Date.parse("2026-11-04T23:00:00Z");
    const at = (min: number) => new Date(t0 + min * 60_000);
    await db.execute(sql`insert into players (id) values ('p1')`);
    await db.execute(
      sql`insert into tables (id, owner_player_id, settings, mode) values ('cash1', 'p1', '{}', 'cash'), ('tn1:t1', 'p1', '{}', 'tournament')`,
    );
    for (const [id, table, n, min] of [
      ["h1", "cash1", 1, 5],
      ["h2", "cash1", 2, 10],
      ["h3", "tn1:t1", 1, 20],
    ] as const)
      await db.execute(
        sql`insert into hands (id, table_id, number, game_id, started_at, header, events) values (${id}, ${table}, ${n}, 'nlhe', ${at(min)}, '{}', '[]')`,
      );
    // An hour earlier than the window: not counted.
    await db.execute(
      sql`insert into hands (id, table_id, number, game_id, started_at, header, events) values ('h0', 'cash1', 0, 'nlhe', ${at(-200)}, '{}', '[]')`,
    );
    await db.execute(sql`insert into table_log (table_id, kind, at, item) values
      ('cash1', 'chat', ${at(6)}, ${JSON.stringify({ playerId: "p1", name: "Somebody", text: "nice hand" })}),
      ('cash1', 'chat', ${at(7)}, ${JSON.stringify({ playerId: "p1", name: "Somebody", text: "my screen froze, see /t/abc123" })}),
      ('tn1:t1', 'chat', ${at(21)}, ${JSON.stringify({ playerId: "p1", name: "Somebody", text: "the timer is stuck" })})`);
    const state = {
      settings: {
        name: "Wednesday game",
        start: { kind: "scheduled", startAt: t0 },
      },
      entries: [{}, {}, {}],
      startAt: t0,
      startedAt: t0 + 3 * 60_000,
      finishedAt: null,
    };
    await db.execute(
      sql`insert into tournaments (id, host_player_id, status, state) values ('tn1', 'p1', 'running', ${JSON.stringify(state)})`,
    );
    // Due in the window but never started, and last saved days before.
    const stuck = {
      settings: {
        name: "Stuck one",
        start: { kind: "scheduled", startAt: t0 + 60 * 60_000 },
      },
      entries: [{}],
      startAt: t0 + 60 * 60_000,
      startedAt: null,
      finishedAt: null,
    };
    await db.execute(
      sql`insert into tournaments (id, host_player_id, status, state, updated_at) values ('tn2', 'p1', 'registering', ${JSON.stringify(stuck)}, ${at(-5000)})`,
    );
    await db.execute(sql`insert into ops_log (at, kind, message) values
      (${at(30)}, 'server', 'saving table failed: timeout'),
      (${at(31)}, 'server', 'saving table failed: timeout'),
      (${at(32)}, 'browser', 'browser error (uncaught) on /t/:id: x is undefined'),
      (${at(40)}, 'stop', 'server stopping')`);
    // A clean restart (stop line just before) and a crash (none).
    await db.execute(sql`insert into audit_log (seq, at, kind, data, prev, hash) values
      (1, ${t0 + 41 * 60_000}, 'boot', '{"commit":"abc1234"}', '', 'h1'),
      (2, ${t0 + 90 * 60_000}, 'boot', '{"commit":"abc1234"}', 'h1', 'h2')`);

    await serve(async (url) => {
      const res = await get(
        `${url}/api/admin/recap?from=${at(0).toISOString()}&to=${at(120).toISOString()}`,
        REPORT,
      );
      const recap = (await res.json()) as Recap;
      expect(recap.quiet).toBe(false);
      expect(recap.activity).toEqual({
        hands: 3,
        cashTables: 1,
        tournamentTables: 1,
        cashHands: 2,
        tournamentHands: 1,
      });
      expect(recap.restarts.map((r) => r.clean)).toEqual([true, false]);
      expect(recap.errors[0]).toMatchObject({
        kind: "server",
        message: "saving table failed: timeout",
        count: 2,
      });
      expect(recap.errors[1]).toMatchObject({ kind: "browser", count: 1 });
      expect(recap.tournaments).toEqual([
        expect.objectContaining({
          name: "Wednesday game",
          status: "running",
          start: "scheduled",
          entries: 3,
          lateByMinutes: 3,
          finishedAt: null,
          didNotStart: false,
        }),
        expect.objectContaining({
          name: "Stuck one",
          status: "registering",
          lateByMinutes: null,
          didNotStart: true,
        }),
      ]);
      expect(recap.chatLinesRead).toBe(3);
      expect(recap.chat.map((c) => [c.where, c.text])).toEqual([
        ["cash table", "my screen froze, see /t/:id"],
        ["tournament table", "the timer is stuck"],
      ]);
      expect(JSON.stringify(recap)).not.toContain("Somebody");
    });
  });

  it("calls a night with no hands quiet", async () => {
    await serve(async (url) => {
      const recap = (await (
        await get(`${url}/api/admin/recap?hours=12`, ADMIN)
      ).json()) as Recap;
      expect(recap.quiet).toBe(true);
      expect(recap.activity.hands).toBe(0);
    });
  });

  it("keeps the server error lines, and a clean stop line when it closes", async () => {
    await serve(async (_url, server) => {
      server.log(
        "saving table failed for /t/secret-link",
        new Error("connection reset"),
      );
    });
    const rows = await queryRows<{ kind: string; message: string }>(
      db,
      sql`select kind, message from ops_log order by n`,
    );
    expect(rows).toEqual([
      {
        kind: "server",
        message: "saving table failed for /t/:id: connection reset",
      },
      { kind: "stop", message: "server stopping" },
    ]);
  });

  it("marks a stop for an uncaught error as a crash, not a clean stop", async () => {
    const server = createApp({ accounts: db, adminKey: ADMIN, log: () => {} });
    await new Promise<void>((r) => server.http.listen(0, r));
    await server.close({ crash: new Error("boom") });
    const rows = await queryRows<{ kind: string; message: string }>(
      db,
      sql`select kind, message from ops_log order by n`,
    );
    expect(rows).toEqual([
      {
        kind: "server",
        message: "server stopping after an uncaught error: boom",
      },
    ]);
  });

  it("drops lines older than 30 days when the server starts", async () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    await db.execute(
      sql`insert into ops_log (at, kind, message) values (${new Date(now - 31 * 86_400_000)}, 'server', 'old'), (${new Date(now - 86_400_000)}, 'server', 'new')`,
    );
    await opsRecorder(db, () => now).stopping();
    const rows = await queryRows<{ message: string }>(
      db,
      sql`select message from ops_log order by n`,
    );
    expect(rows.map((r) => r.message)).toEqual(["new", "server stopping"]);
  });
});

describe("recap helpers", () => {
  it("reads the window", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(recapWindow({}, now)).toEqual({
      from: new Date("2026-11-04T12:00:00Z"),
      to: new Date(now),
    });
    expect(recapWindow({ hours: "6" }, now)).toEqual({
      from: new Date("2026-11-05T06:00:00Z"),
      to: new Date(now),
    });
    expect(recapWindow({ from: "2026-11-05T13:00:00Z" }, now)).toBe(
      "from must be before to.",
    );
    expect(recapWindow({ hours: "200" }, now)).toMatch(/at most/);
    expect(recapWindow({ to: "nonsense" }, now)).toMatch(/ISO/);
  });

  it("flags chat about the site, not poker talk", () => {
    expect(soundsLikeAProblem("it froze on me")).toBe(true);
    expect(soundsLikeAProblem("the app keeps reloading")).toBe(true);
    expect(soundsLikeAProblem("nice hand")).toBe(false);
    expect(soundsLikeAProblem("raise it up")).toBe(false);
  });

  it("keeps one short line", () => {
    expect(opsLine("a\nb", new Error("c"))).toBe("a | b: c");
    expect(opsLine("x".repeat(600))).toHaveLength(500);
  });
});
