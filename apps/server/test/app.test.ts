import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { ClientToServer, CoachTip, HandRecordView, ServerToClient } from '@rsdp/engine/wire';
import { createApp, tipLimits } from '../src/app';
import { socketClient } from './socket-client';

type Client = Socket<ServerToClient, ClientToServer>;

let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];

beforeAll(async () => {
  registerAllVariants(variants);
  server = createApp({ log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
});

const client = (token: string) => socketClient(url, token, clients);

describe('socket server', () => {
  it('shrugs off malformed messages instead of crashing (one bad client must not restart every table)', async () => {
    const c = client('malformed-0123456789');
    const { tableId } = await c.call<{ tableId: string }>('table:create', {});
    await c.call('table:join', { tableId });
    (c.socket.emit as (e: string, ...a: unknown[]) => void)('seat:sitOut');
    (c.socket.emit as (e: string, ...a: unknown[]) => void)('hand:draw');
    (c.socket.emit as (e: string, ...a: unknown[]) => void)('seat:prefs', null, null);
    // Still connected and answering.
    await c.call('seat:request', { seat: 0, name: 'Still here', stack: 100 });
    expect((await c.until((v) => !!v.seats[0])).seats[0]?.name).toBe('Still here');
  });

  it('makes every cash table in dollars and cents, and keeps it that way', async () => {
    const host = client('cents-host-0123456789');
    // From the start form: .25/.50, sent as cents.
    const { tableId } = await host.call<{ tableId: string }>('table:create', {
      settings: { stakes: { smallBlind: 25, bigBlind: 50, centsMode: true }, seating: { requireApproval: false, maxBuyIn: 10_000 } },
    });
    await host.call('table:join', { tableId });
    const v = await host.until((x) => x.id === tableId);
    expect(v.settings.stakes).toMatchObject({ smallBlind: 25, bigBlind: 50, centsMode: true });
    await expect(host.call('host:settings', { patch: { stakes: { centsMode: false } } })).rejects.toThrow(/dollars and cents/);
    await expect(host.call('seat:request', { seat: 0, name: 'Host', stack: 20_000 })).rejects.toThrow(/maximum buy-in is 100$/);
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 5_025 });
    expect((await host.until((x) => !!x.seats[0])).log.at(-1)?.text).toMatch(/with 50\.25$/);
    // An older page or preset in chips counts a chip as a dollar.
    const old = await host.call<{ tableId: string }>('table:create', { settings: { stakes: { smallBlind: 1, bigBlind: 2 }, seating: { minBuyIn: 40 } } });
    await host.call('table:join', { tableId: old.tableId });
    const ov = await host.until((x) => x.id === old.tableId);
    expect(ov.settings.stakes).toMatchObject({ smallBlind: 100, bigBlind: 200, centsMode: true });
    expect(ov.settings.seating.minBuyIn).toBe(4_000);
  });

  it('refuses a new table with more seats than one of its games deals, as a settings change would', async () => {
    const host = client('create-seats-host-0123456789');
    // A preset (or a hand-edited preset file) rotating No-Limit Hold'em and Badugi, which deals at most 6.
    const step = (gameId: string, betting: string) => ({ gameId, betting, length: 1, unit: 'orbits' });
    const rotation = { enabled: true, steps: [step('nlhe', 'no-limit'), step('badugi', 'fixed-limit')] };
    const before = server.tables.size;
    await expect(host.call('table:create', { settings: { table: { maxSeats: 10 }, game: { rotation } } })).rejects.toThrow(/^Badugi seats at most 6$/);
    expect(server.tables.size).toBe(before);
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { maxSeats: 6 }, game: { rotation } } });
    await host.call('table:join', { tableId });
    expect((await host.until((v) => v.id === tableId)).seats).toHaveLength(6);
  });

  it('exports every finished hand, hiding cards the viewer never saw', async () => {
    const host = client('export-host-0123456789');
    const guest = client('export-guest-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { seating: { requireApproval: false } } });
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
    await host.call('host:start');
    const v = await host.until((x) => !!x.hand);
    // Whoever acts first folds, which ends the hand.
    const first = v.hand!.toAct === v.me.seat ? host : guest;
    await first.until((x) => x.legal !== null);
    await first.call('hand:act', { type: 'fold' });
    await host.until((x) => x.history.length === 1);
    const { hands } = await guest.call<{ hands: import('@rsdp/engine/wire').HandRecordView[] }>('table:export');
    expect(hands).toHaveLength(1);
    expect(hands[0].seats.map((s) => s.name).sort()).toEqual(['Guest', 'Host']);
    const deals = hands[0].events.filter((e) => e.t === 'deal') as Extract<(typeof hands)[0]['events'][number], { t: 'deal' }>[];
    const hostSeat = v.me.seat!;
    expect(deals.find((d) => d.seat === hostSeat)!.cards.every((c) => c.card === '??')).toBe(true);
    expect(deals.find((d) => d.seat !== hostSeat)!.cards.every((c) => c.card !== '??')).toBe(true);
  });

  it('starts a practice table against bots, and lets a seated player add and remove their own and change their level', async () => {
    const host = client('practice-host-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { seating: { requireApproval: false } }, practice: { name: 'John', bots: 2, level: 'hard' } });
    await host.call('table:join', { tableId });
    const v = await host.until((x) => !!x.hand);
    expect(v.seats.filter(Boolean).map((s) => s!.name)).toEqual(['John', 'Ace', 'Chip']);
    expect(v.seats[1]!.bot).toEqual({ ownerId: v.me.playerId, ownerName: 'John', look: 0, level: 'hard' });

    const ann = client('practice-ann-0123456789');
    await ann.call('table:join', { tableId });
    await expect(ann.call('bot:add', {})).rejects.toThrow(/take a seat/);
    await ann.call('seat:request', { seat: 5, name: 'Ann', stack: 100 });
    const { playerId } = await ann.call<{ playerId: string }>('bot:add', { level: 'easy' });
    const seated = await ann.until((x) => x.seats.some((s) => s?.playerId === playerId));
    expect(seated.seats.find((s) => s?.playerId === playerId)).toMatchObject({ name: 'Lucky', bot: { level: 'easy' } });
    await expect(ann.call('bot:level', { playerId: v.seats[1]!.playerId, level: 'easy' })).rejects.toThrow(/owner or the host/);
    await expect(ann.call('bot:level', { playerId, level: 'expert' })).rejects.toThrow(/no such level/);
    await ann.call('bot:level', { playerId, level: 'hard' });
    await ann.until((x) => x.seats.find((s) => s?.playerId === playerId)?.bot?.level === 'hard');
    await expect(host.call('bot:remove', { playerId: v.seats[1]!.playerId })).resolves.toBeTruthy();
    await ann.call('bot:remove', { playerId });
    await ann.until((x) => !x.seats.some((s) => s?.playerId === playerId && !s.leaving));
  });

  it('answers a coach tip to the one person at a table of bots, and the same turn again for nothing', async () => {
    const host = client('tip-host-0123456789');
    const settings = { seating: { requireApproval: false }, timing: { decisionSeconds: 0 } };
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings, practice: { name: 'John', bots: 2 } });
    await host.call('table:join', { tableId });
    const v = await host.until((x) => !!x.tips && x.legal !== null);
    const input = { handNumber: v.hand!.handNumber, at: v.hand!.events.length };
    const { tip } = await host.call<{ tip: CoachTip }>('hand:tip', input);
    expect(tip).toMatchObject({ ...input, kind: 'bet' });
    expect(tip.share).toBeGreaterThan(0);
    // Nonsense is turned away like a turn that has gone.
    await expect(host.call('hand:tip', { handNumber: 'x', at: 0 })).rejects.toThrow(/that turn is over/);
    // The same turn asked again, from this tab or another, is the tip already worked out, and doesn't count towards the
    // limit (tipLimits, below).
    const tab = client('tip-host-0123456789');
    await tab.call('table:join', { tableId });
    for (let i = 0; i < 14; i++) expect((await (i % 2 ? tab : host).call<{ tip: CoachTip }>('hand:tip', input)).tip).toEqual(tip);

    // Once the hand is over, the hands tab and a download carry why the bots played; the full log doesn't ask for them.
    await host.call('hand:act', { type: 'fold' });
    await host.until((x) => x.history.length > 0);
    const history = await host.call<{ hand: HandRecordView }>('table:history', { handNumber: input.handNumber });
    expect(history.hand.botNotes!.length).toBeGreaterThan(0);
    const exported = await host.call<{ hands: HandRecordView[] }>('table:export');
    expect(exported.hands[0].botNotes!.length).toBeGreaterThan(0);
    const full = await host.call<{ hands: HandRecordView[] }>('table:fullLog');
    expect(full.hands[0].botNotes).toBeUndefined();
    // The bots play on real time here: a hand that runs to showdown takes a few seconds of it.
  }, 45_000);

  it('lists people watching the table by name, but not seated players', async () => {
    const host = client('watch-host-0123456789');
    const fan = client('watch-fan-0123456789');
    await fan.call('session:name', { name: 'Railbird' });
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: {} });
    await host.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await fan.call('table:join', { tableId });
    const v = await host.until((x) => x.watchers.length === 1);
    expect(v.watchers[0].name).toBe('Railbird');
    fan.socket.emit('table:leave');
    await host.until((x) => x.watchers.length === 0);
  });

  it('shows spectators every card, a delay behind the table', async () => {
    const host = client('delay-host-0123456789');
    const guest = client('delay-guest-0123456789');
    const fan = client('delay-fan-0123456789');
    const settings = { seating: { requireApproval: false }, spectators: { seeAllCards: true, delaySeconds: 2 }, timing: { decisionSeconds: 0 } };
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings });
    for (const c of [host, guest, fan]) await c.call('table:join', { tableId });
    // Sitting at a table where spectators see every card takes agreeing to it.
    await expect(host.call('seat:request', { seat: 0, name: 'Host', stack: 100 })).rejects.toThrow(/agree/);
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100, consent: true });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100, consent: true });
    await host.call('host:start');
    const started = Date.now();
    await host.until((x) => !!x.hand);
    // The players have a hand; the spectator doesn't yet.
    expect(fan.view().hand).toBeNull();
    expect(fan.view().spectator).toEqual({ delaySeconds: 2, seeAll: true, blocked: false });
    const later = await fan.until((x) => !!x.hand);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(later.seats.filter(Boolean).every((s) => s!.cards.length === 2 && s!.cards.every((c) => c.card !== '??'))).toBe(true);
    // Hand history can't get ahead of the delay.
    // Whoever is to act folds, which ends the hand.
    const first = await Promise.race([host, guest].map((c) => c.until((x) => x.legal !== null).then(() => c)));
    await first.call('hand:act', { type: 'fold' });
    await host.until((x) => x.history.length === 1);
    await expect(fan.call('table:history', { handNumber: 1 })).rejects.toThrow(/that hand isn’t available/);
    // Chat stays live for everyone.
    await guest.call('chat:send', { text: 'gl' });
    await fan.until((x) => x.chat.some((m) => m.text === 'gl'));
  }, 30_000);

  it('stops showing spectators every card the moment the host turns it off, delay or not', async () => {
    const host = client('off-host-0123456789');
    const guest = client('off-guest-0123456789');
    const fan = client('off-fan-0123456789');
    const settings = { seating: { requireApproval: false }, spectators: { seeAllCards: true, delaySeconds: 1 }, timing: { decisionSeconds: 0 } };
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings });
    for (const c of [host, guest, fan]) await c.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100, consent: true });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100, consent: true });
    await host.call('host:start');
    const hidden = (v: ReturnType<typeof fan.view>) => v.seats.every((x) => !x || x.cards.every((c) => c.card === '??'));
    await fan.until((x) => !!x.hand && !hidden(x));
    await host.call('host:settings', { patch: { spectators: { seeAllCards: false } } });
    const off = await fan.until((x) => x.cardsWatched === null);
    expect(hidden(off)).toBe(true);
    // The snapshots taken while it was on are never played out after the delay.
    const views: ReturnType<typeof fan.view>[] = [];
    fan.socket.on('table:state', (v) => views.push(v));
    await new Promise((r) => setTimeout(r, 1500));
    expect(views.every(hidden)).toBe(true);
  }, 30_000);

  it('acks a chat message the table refuses', async () => {
    const host = client('chat-host-0123456789');
    const fan = client('chat-fan-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { chat: { guestChat: false } } });
    await host.call('table:join', { tableId });
    await fan.call('table:join', { tableId });
    await expect(fan.call('chat:send', { text: 'hi' })).rejects.toThrow(/only players/);
  });

  it('slows down a burst of chat from one player, so it cannot wipe the table chat', async () => {
    const host = client('chat-burst-host-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', {});
    await host.call('table:join', { tableId });
    for (let i = 0; i < 8; i++) await host.call('chat:send', { text: `line ${i}` });
    await expect(host.call('chat:send', { text: 'one too many' })).rejects.toThrow(/slow down/);
    const chat = server.tables.get(tableId)!.state.chat.map((m) => m.text);
    expect(chat.filter((t) => t.startsWith('line '))).toHaveLength(8);
    expect(chat).not.toContain('one too many');
  });

  it('rejects connections without a browser secret', async () => {
    const c: Client = connect(url, { auth: {}, transports: ['websocket'], forceNew: true });
    clients.push(c);
    const err = await new Promise<Error>((resolve) => c.on('connect_error', resolve));
    expect(err.message).toMatch(/token/);
  });

  it('plays a hand between two browsers with hole cards kept private', async () => {
    const host = client('host-secret-0123456789');
    const guest = client('guest-secret-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Test night' } } });
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    expect(guest.view().name).toBe('Test night');

    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 3, name: 'Guest', stack: 100 });
    const pending = await host.until((v) => v.requests.length === 1);
    expect(guest.view().requests).toHaveLength(1);
    await host.call('host:approve', { requestId: pending.requests[0].id });
    await expect(guest.call('host:start')).rejects.toThrow(/host/);
    await host.call('host:start');

    const hv = await host.until((v) => !!v.hand);
    const gv = await guest.until((v) => !!v.hand);
    const hostSeat = hv.seats[0]!;
    const guestSeatFromHost = hv.seats[3]!;
    expect(hostSeat.cards.every((c) => c.card !== '??')).toBe(true);
    expect(guestSeatFromHost.cards.every((c) => c.card === '??')).toBe(true);
    expect(gv.seats[3]!.cards.every((c) => c.card !== '??')).toBe(true);

    // Whoever is to act folds; the other wins the blinds.
    const actor = hv.legal ? host : guest;
    await actor.call('hand:act', { type: 'fold' });
    const done = await host.until((v) => v.hand?.phase === 'complete');
    expect(done.seats[0]!.stack + done.seats[3]!.stack).toBe(200);
    await expect(actor.call('hand:act', { type: 'nonsense' })).rejects.toThrow();
  });

  it('a table survives a restart from its saved state', async () => {
    const host = client('host-secret-restart-0123');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: {} });
    const rt = server.tables.get(tableId)!;
    server.tables.delete(tableId);
    rt.dispose();
    // Not in memory any more: joining loads it back from the store after the debounced save.
    await new Promise((r) => setTimeout(r, 700));
    await host.call('table:join', { tableId });
    expect(host.view().id).toBe(tableId);
  });
});

describe('coach tip limits', () => {
  it('lets one player work out ten tips in 20 s, across their tabs, and the server 300 ms of them a second', () => {
    let now = 0;
    const limits = tipLimits(() => now);
    for (let i = 0; i < 10; i++) limits.admit('ann')(1);
    expect(() => limits.admit('ann')).toThrow(/between tips/);
    // Someone else has their own ten.
    limits.admit('bo')(1);
    now += 20_000;
    limits.admit('ann')(1);

    // Tips that took 300 ms between them in the last second keep everyone waiting a moment, whoever asked.
    now += 20_000;
    limits.admit('cy')(150);
    limits.admit('dee')(150);
    expect(() => limits.admit('eve')).toThrow(/coach is busy/);
    now += 1_000;
    limits.admit('eve')(10);
  });
});

describe('operator cleanup', () => {
  it('answers only a shell on the server, never a request through the proxy', async () => {
    expect((await fetch(`${url}/api/admin/tournaments`)).status).toBe(200);
    expect((await fetch(`${url}/api/admin/tournaments`, { headers: { 'Fly-Client-IP': '203.0.113.9' } })).status).toBe(404);
    expect((await fetch(`${url}/api/admin/tournaments`, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status).toBe(404);
    const missing = await fetch(`${url}/api/admin/tournaments/0123456789abcdef/archive`, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.9' } });
    expect(missing.status).toBe(404);
    expect((await fetch(`${url}/api/admin/tournaments/0123456789abcdef/archive`, { method: 'POST' })).status).toBe(400);
  });
});
