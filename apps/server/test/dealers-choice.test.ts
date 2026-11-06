import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, parseSettings, type ChoiceGame, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { RESUME_MIN_MS, TableRuntime } from '../src/runtime/table';
import { BOT_PICK_MS } from '../src/runtime/choice';
import { behind, delayedPart, tableView } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

const PEOPLE = ['host', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const MENU: ChoiceGame[] = [
  { gameId: 'nlhe', betting: 'no-limit' },
  { gameId: 'razz', betting: 'fixed-limit' },
  { gameId: 'badugi', betting: 'fixed-limit' },
  { gameId: 'plo4', betting: 'pot-limit' },
];

function table(patch: (s: TableSettings) => void = () => {}, rng = seeded()) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.table.maxSeats = 9;
  settings.seating.requireApproval = false;
  settings.stakes = { ...settings.stakes, smallBlind: 1, bigBlind: 2, ante: 1, anteType: 'per-player', bringIn: 1, smallBet: 2, bigBet: 4 };
  settings.game.dealersChoice = { enabled: true, games: MENU, hands: 0, pickSeconds: 20 };
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings: parseSettings(settings) }, { clock, rng });
  for (const p of PEOPLE) rt.connect(p);
  return { rt, clock };
}

function seat(rt: TableRuntime, n: number, stack = 1000) {
  const ids = PEOPLE.slice(0, n);
  ids.forEach((id, i) => rt.requestSeat(id, { seat: i, name: id.toUpperCase(), stack }));
  return ids;
}

const hand = (rt: TableRuntime) => rt.state.hand!;
const live = (rt: TableRuntime) => !!rt.state.hand && rt.state.hand.phase !== 'complete';
const toActId = (rt: TableRuntime) => rt.state.seats[hand(rt).toAct!]!.playerId;
const chooser = (rt: TableRuntime) => rt.choice.chooser()!;
const menuIndex = (rt: TableRuntime, gameId: string) => rt.settings.game.dealersChoice!.games.findIndex((g) => g.gameId === gameId);
const pick = (rt: TableRuntime, gameId: string) => rt.chooseGame(chooser(rt).playerId, { index: menuIndex(rt, gameId) });

function checkDown(rt: TableRuntime) {
  for (let i = 0; i < 200 && live(rt); i++) {
    const h = hand(rt);
    if (h.phase === 'drawing') {
      rt.draw(toActId(rt), []);
      continue;
    }
    if (h.toAct === null) break;
    const legal = engine.legalActions(h, h.toAct)!;
    rt.act(toActId(rt), legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
  }
}

/** Plays hands out until the table waits for a pick (or `max` hands); returns the games dealt. */
function playUntilPick(rt: TableRuntime, clock: FakeClock, max = 30) {
  const games: string[] = [];
  for (let i = 0; i < max; i++) {
    if (!live(rt)) {
      if (rt.state.choice?.deadline != null) break;
      clock.advance(10_000);
      if (!live(rt)) break;
    }
    games.push(hand(rt).input.game.id);
    checkDown(rt);
    clock.advance(10_000);
  }
  return games;
}

describe("Dealer's choice", () => {
  it('waits for the first pick, gives the chooser the first button, and plays each pick for one orbit', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    // Nothing is dealt until the first chooser picks.
    expect(rt.state.hand).toBeNull();
    expect(rt.state.choice!.deadline).toBe(clock.now() + 20_000);
    const first = chooser(rt);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ chip: first.seat, open: true, deadline: clock.now() + 20_000, current: null });
    pick(rt, 'plo4');
    expect(hand(rt).input.game.id).toBe('plo4');
    expect(hand(rt).input.button).toBe(first.seat);
    expect(rt.state.log.some((l) => l.text === `${first.name} picked Pot-Limit Omaha`)).toBe(true);
    // The chip moves one seat to the left.
    const second = chooser(rt);
    expect(second.seat).toBe((first.seat + 1) % 3);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ chip: second.seat, handsLeft: 2, open: false, current: { gameId: 'plo4', by: first.name, how: 'picked' } });
    const games = playUntilPick(rt, clock);
    expect(games).toEqual(['plo4', 'plo4', 'plo4']);
    expect(chooser(rt).seat).toBe(second.seat);
    pick(rt, 'razz');
    expect(hand(rt).input.game.id).toBe('razz');
    expect(chooser(rt).seat).toBe((second.seat + 1) % 3);
  });

  it('lets the next chooser pick during the last hand of the orbit, so the table never waits', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'nlhe');
    checkDown(rt);
    clock.advance(10_000);
    checkDown(rt);
    clock.advance(10_000);
    // Third and last hand of the orbit: picking is open, with no clock.
    expect(live(rt)).toBe(true);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ open: true, deadline: null, handsLeft: 0 });
    // Not before then, and only the chooser.
    const other = rt.state.seats.find((x) => x && x.playerId !== chooser(rt).playerId)!;
    expect(() => rt.chooseGame(other.playerId, { index: 1 })).toThrow(/isn't your pick/);
    pick(rt, 'razz');
    expect(tableView(rt, 'a', clock.now()).choice!.next).toMatchObject({ gameId: 'razz' });
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('razz');
    expect(hand(rt).input.handNumber).toBe(4);
  });

  it('refuses a pick out of turn or before the last hand', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'nlhe');
    expect(() => pick(rt, 'razz')).toThrow(/isn't time/);
    checkDown(rt);
    clock.advance(10_000);
    expect(() => rt.chooseGame(chooser(rt).playerId, { index: 99 })).toThrow(/isn't time/);
  });

  it('carries the current game on when the chooser runs out of time, and moves the chip on', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'razz');
    playUntilPick(rt, clock);
    const late = chooser(rt);
    clock.advance(20_000);
    expect(hand(rt).input.game.id).toBe('razz');
    expect(rt.state.log.some((l) => l.text === `${late.name} didn't pick in time, so Razz carries on`)).toBe(true);
    expect(chooser(rt).seat).toBe((late.seat + 1) % 3);
    expect(rt.state.choice!.current).toMatchObject({ how: 'kept', by: late.name });
  });

  it('deals the first game on the menu that fits when the very first pick is missed', () => {
    const { rt, clock } = table((s) => {
      s.game.dealersChoice!.games = [MENU[2], MENU[1], MENU[0]];
    });
    seat(rt, 7);
    rt.start('host');
    // Badugi seats 6 and Razz 8: with 7 sitting down, Razz.
    clock.advance(20_000);
    expect(hand(rt).input.game.id).toBe('razz');
  });

  it("greys out games that don't fit the players sitting down", () => {
    const { rt, clock } = table();
    seat(rt, 7);
    rt.start('host');
    expect(() => pick(rt, 'badugi')).toThrow(/Badugi seats at most 6 players, and 7 are sitting down/);
    expect(tableView(rt, 'a', clock.now()).choice!.count).toBe(7);
    pick(rt, 'razz');
    expect(hand(rt).input.game.id).toBe('razz');
  });

  it('closes the other seats while a smaller game is picked or played, and opens them for a bigger one', () => {
    const { rt, clock } = table();
    seat(rt, 6);
    rt.start('host');
    pick(rt, 'badugi');
    expect(hand(rt).input.game.id).toBe('badugi');
    expect(tableView(rt, 'g', clock.now()).choice!.cap).toBe(6);
    expect(() => rt.requestSeat('g', { seat: 7, name: 'G', stack: 1000 })).toThrow(/Badugi seats at most 6 players, so the other seats are closed/);
    expect(() => rt.addBot('host')).toThrow(/closed/);
    playUntilPick(rt, clock);
    // Still Badugi's seats while the next game is being picked.
    expect(() => rt.requestSeat('g', { seat: 7, name: 'G', stack: 1000 })).toThrow(/closed/);
    pick(rt, 'nlhe');
    expect(hand(rt).input.game.id).toBe('nlhe');
    rt.requestSeat('g', { seat: 7, name: 'G', stack: 1000 });
    expect(rt.state.seats[7]?.playerId).toBe('g');
  });

  it('counts a seat held for someone as taken when checking a game fits', () => {
    const { rt, clock } = table();
    seat(rt, 6);
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.requestSeat('g', { seat: 7, name: 'G', stack: 1000 });
    expect(rt.state.requests).toHaveLength(1);
    rt.start('host');
    expect(tableView(rt, 'host', clock.now()).choice!.count).toBe(7);
    expect(() => pick(rt, 'badugi')).toThrow(/7 are sitting down/);
  });

  it('skips a chooser who sits out, and gives the next player a fresh clock', () => {
    const { rt, clock } = table();
    seat(rt, 4);
    rt.start('host');
    const first = chooser(rt);
    clock.advance(15_000);
    rt.sitOut(first.playerId, true);
    const next = chooser(rt);
    expect(next.seat).not.toBe(first.seat);
    expect(rt.state.choice!.deadline).toBe(clock.now() + 20_000);
    pick(rt, 'nlhe');
    expect(hand(rt).input.game.id).toBe('nlhe');
  });

  it('a bot holding the chip picks at random from the games that fit, a moment after picking opens', () => {
    const { rt, clock } = table();
    seat(rt, 1);
    rt.addBot('host', { seat: 1 });
    rt.addBot('host', { seat: 2 });
    rt.start('host');
    const botPicks = new Map<number, string>();
    let timed = false;
    for (let i = 0; i < 30; i++) {
      if (!live(rt)) {
        if (rt.isBot(chooser(rt).playerId)) clock.advance(BOT_PICK_MS);
        else pick(rt, 'nlhe');
      }
      const c = rt.state.choice!;
      if (c.current?.how === 'bot') botPicks.set(rt.state.handNumber - c.hands, c.current.gameId);
      // The last hand of a pick, with a bot to choose next: it picks once BOT_PICK_MS has passed.
      if (!timed && rt.choice.pickOpen() && rt.isBot(chooser(rt).playerId) && c.botAt !== null) {
        const due = c.botAt;
        clock.advance(due - clock.now() - 1);
        expect(rt.state.choice!.next).toBeNull();
        clock.advance(1);
        expect(rt.state.choice!.next).toMatchObject({ how: 'bot' });
        timed = true;
      }
      checkDown(rt);
      // Up to the next deal, in small steps, so the check above sees a bot's pick before it is made.
      for (let t = 0; t < 100 && !live(rt) && rt.state.choice!.deadline === null; t++) clock.advance(100);
    }
    expect(timed).toBe(true);
    expect(botPicks.size).toBeGreaterThanOrEqual(3);
    for (const g of botPicks.values()) expect(MENU.some((m) => m.gameId === g)).toBe(true);
    // Random, not always the same game.
    expect(new Set(botPicks.values()).size).toBeGreaterThan(1);
  });

  it('stops the pick clock while paused and gives at least 5 seconds after', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    clock.advance(18_000);
    rt.pause('host', true);
    clock.advance(60_000);
    expect(rt.state.hand).toBeNull();
    expect(tableView(rt, 'a', clock.now()).choice!.deadline).toBe(clock.now() + RESUME_MIN_MS);
    rt.pause('host', false);
    expect(rt.state.choice!.deadline).toBe(clock.now() + RESUME_MIN_MS);
    clock.advance(RESUME_MIN_MS - 100);
    expect(rt.state.hand).toBeNull();
    pick(rt, 'razz');
    expect(hand(rt).input.game.id).toBe('razz');
  });

  it('gives the chooser a fresh clock after a restart', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    clock.advance(19_000);
    const saved = JSON.parse(JSON.stringify(rt.state));
    rt.dispose();
    clock.advance(60_000);
    const back = new TableRuntime(saved, { clock, rng: seeded() });
    back.resume();
    for (const p of PEOPLE) back.connect(p);
    expect(back.state.hand).toBeNull();
    expect(back.state.choice!.deadline).toBe(clock.now() + 20_000);
    back.chooseGame(back.choice.chooser()!.playerId, { index: 0 });
    expect(back.state.hand!.input.game.id).toBe('nlhe');
  });

  it('shortens the orbit when players leave', () => {
    const { rt, clock } = table();
    seat(rt, 5);
    rt.start('host');
    pick(rt, 'nlhe');
    checkDown(rt);
    // Three of five leave after the first hand: with two dealt in, the orbit ends after its second hand.
    for (const id of ['b', 'c', 'd']) rt.stand(id);
    clock.advance(10_000);
    expect(playUntilPick(rt, clock)).toEqual(['nlhe']);
    expect(rt.state.choice!.hands).toBe(2);
    expect(rt.state.choice!.deadline).not.toBeNull();
  });

  it('can last a set number of hands instead of an orbit', () => {
    const { rt, clock } = table((s) => (s.game.dealersChoice!.hands = 2));
    seat(rt, 4);
    rt.start('host');
    pick(rt, 'plo4');
    expect(playUntilPick(rt, clock)).toEqual(['plo4', 'plo4']);
  });

  it('with a stud game on the menu, only the stud games ante', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'nlhe');
    expect(hand(rt).input.stakes.ante).toBe(0);
    playUntilPick(rt, clock);
    pick(rt, 'razz');
    expect(hand(rt).input.stakes.ante).toBe(1);
  });

  it('keeps the current game going on purpose', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'nlhe');
    playUntilPick(rt, clock);
    expect(tableView(rt, 'a', clock.now()).choice!.canKeep).toBe(true);
    const keeper = chooser(rt);
    pick(rt, 'nlhe');
    expect(rt.state.log.some((l) => l.text === `${keeper.name} kept No-Limit Hold'em going`)).toBe(true);
  });

  it('forgets the chip when the host turns it off', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'razz');
    rt.updateSettings('host', { game: { dealersChoice: { enabled: false } } });
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('nlhe');
    expect(rt.state.choice).toBeUndefined();
    expect(tableView(rt, 'a', clock.now()).choice).toBeNull();
  });

  it('checks the menu against the table', () => {
    const { rt, clock } = table();
    seat(rt, 7);
    expect(() => rt.updateSettings('host', { game: { dealersChoice: { games: [MENU[1], MENU[2]] } } })).toThrow(/the biggest game on the menu, Razz, seats at most 8: lower the table to 8 seats/);
    expect(() => rt.updateSettings('host', { table: { maxSeats: 7 }, game: { dealersChoice: { games: [MENU[2], { gameId: 'td27', betting: 'fixed-limit' }] } } })).toThrow(/No game on the menu seats 7/);
    expect(() => rt.updateSettings('host', { game: { dealersChoice: { games: [MENU[0], MENU[0]] } } })).toThrow(/on the menu twice/);
    expect(() => rt.updateSettings('host', { game: { dealersChoice: { games: [MENU[0]] } } })).toThrow(/at least two games/);
    expect(() =>
      rt.updateSettings('host', { game: { rotation: { enabled: true, steps: [{ gameId: 'nlhe', betting: 'no-limit', length: 1, unit: 'hands' }] } } }),
    ).toThrow(/turn off rotating games/);
  });

  it('is for cash tables only', () => {
    const s = defaultSettings('tournament');
    s.game.dealersChoice = { enabled: true, games: MENU, hands: 0, pickSeconds: 20 };
    expect(() => parseSettings(s)).toThrow(/cash games only/);
  });

  it('settings saved before Dealer’s choice existed still load, with it off', () => {
    const s = defaultSettings('cash') as TableSettings & { game: { dealersChoice?: unknown } };
    delete s.game.dealersChoice;
    expect(parseSettings(s).game.dealersChoice).toBeUndefined();
    const clock = new FakeClock();
    const rt = TableRuntime.create({ id: 't2', hostId: 'host', settings: s }, { clock, rng: seeded() });
    expect(tableView(rt, 'host', clock.now()).choice).toBeNull();
  });

  it('runs on the delay for spectators', () => {
    const { rt, clock } = table((s) => (s.spectators.delaySeconds = 30));
    seat(rt, 3);
    rt.start('host');
    const before = delayedPart(tableView(rt, 'zed', clock.now()));
    clock.advance(5_000);
    pick(rt, 'razz');
    const now = tableView(rt, 'zed', clock.now());
    expect(now.choice!.current).toMatchObject({ gameId: 'razz' });
    const shown = behind(now, before, 5_000);
    expect(shown.choice!.current).toBeNull();
    expect(shown.choice!.deadline).toBe(before.choice!.deadline! + 5_000);
  });
});
