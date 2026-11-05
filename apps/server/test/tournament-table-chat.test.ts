// Chat at a tournament's tables can be downloaded once the tournament is over (#290): its tables can't be opened
// again after they close, so the lobby hands the host, co-hosts and players every table's chat and log.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, tableAddress, type TournamentTableChat } from '@rsdp/tournament';
import { createApp } from '../src/app';
import { tableName } from '../src/tournament/manager';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { dbLobbyStore } from '../src/tournament/lobby';
import { dbTournamentStore } from '../src/tournament/store';
import { socketClient, type Client } from './socket-client';

beforeAll(() => registerAllVariants(variants));

let db: Db | undefined;
let server: ReturnType<typeof createApp> | undefined;
const clients: Client[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  if (db) await closeDb(db);
  server = db = undefined;
});

async function listen() {
  await new Promise<void>((resolve) => server!.http.listen(0, resolve));
  const url = `http://localhost:${(server!.http.address() as AddressInfo).port}`;
  return (token: string) => socketClient(url, token, clients);
}

const deps = (d: Db) => ({ identity: dbIdentity(d), store: dbStore(d), tournaments: dbTournamentStore(d), lobby: dbLobbyStore(d) });

describe('table chat of a finished tournament', () => {
  it('is kept, and only its host and players can download it, once it is over', async () => {
    db = await createTestDb();
    server = createApp({ ...deps(db), log: (m, e) => console.error(m, e) });
    const client = await listen();
    const host = client('tchat-host-secret-000000');
    const ana = client('tchat-ana-secret-0000000');
    const ben = client('tchat-ben-secret-0000000');
    const fan = client('tchat-fan-secret-0000000');
    for (const [c, name] of [[host, 'Host'], [ana, 'Ana'], [ben, 'Ben'], [fan, 'Fan']] as const) await c.call('session:name', { name });
    const { id } = await host.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Feedback night', startingStack: 1000 }) });
    for (const c of [ana, ben]) await c.call('tournament:command', { id, command: { type: 'register' } });
    await host.call('tournament:command', { id, command: { type: 'startNow' } });
    const state = () => server!.tournaments.view(id)!.state;
    const tableId = tableAddress(state().tables[0].id);

    // Before it is over, the table is open to read as usual.
    await expect(host.call('tournament:tableChat', { id })).rejects.toThrow('once the tournament is over');

    await ana.call('table:join', { tableId });
    await ben.call('table:join', { tableId });
    await ana.call('chat:send', { text: 'the new bet slider is great' });
    await ben.call('chat:send', { text: 'blinds felt fast' });

    // The host pauses, the hand being played finishes, and the host ends it.
    await host.call('tournament:command', { id, command: { type: 'pause' } });
    for (let i = 0; i < 200 && state().tables.some((t) => t.inHand); i++) {
      const mover = [ana, ben].find((c) => c.view()?.hand?.phase !== 'complete' && (c.view()?.legal || c.view()?.canDraw));
      if (!mover) {
        await pause(20);
        continue;
      }
      const v = mover.view();
      if (v.canDraw) await mover.call('hand:draw', { discard: [] }).catch(() => {});
      else await mover.call('hand:act', { type: v.legal!.canCheck ? 'check' : 'call' }).catch(() => {});
    }
    await host.call('tournament:command', { id, command: { type: 'end' } });
    expect(state().status).toBe('finished');
    // Lines are saved a moment after they are said.
    await pause(200);

    // Someone who only watched, or never came, gets nothing.
    await expect(fan.call('tournament:tableChat', { id })).rejects.toThrow('only the host and players');
    await expect(fan.call('tournament:tableChat', { id: 'nope' })).rejects.toThrow('tournament not found');

    const { tables } = await host.call<{ tables: TournamentTableChat[] }>('tournament:tableChat', { id });
    expect(tables.map((t) => t.table)).toEqual([1]);
    expect(tables[0].name).toBe(tableName('Feedback night', 1));
    expect(tables[0].chat.map((c) => `${c.name}: ${c.text}`)).toEqual(['Ana: the new bet slider is great', 'Ben: blinds felt fast']);
    expect(tables[0].chat.every((c) => typeof c.at === 'number')).toBe(true);
    // A second download straight away waits a few seconds, as the table's own does.
    await expect(host.call('tournament:tableChat', { id })).rejects.toThrow('one download every few seconds');

    // A player can download it too, from a fresh server that reads it all from the database.
    await server.close();
    server = createApp(deps(db));
    const again = await listen();
    const anaLater = again('tchat-ana-secret-0000000');
    const later = await anaLater.call<{ tables: TournamentTableChat[] }>('tournament:tableChat', { id });
    expect(later.tables[0].chat.map((c) => c.text)).toEqual(['the new bet slider is great', 'blinds felt fast']);
  }, 30_000);
});
