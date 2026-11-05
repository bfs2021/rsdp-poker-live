import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { TableRuntime } from '../src/runtime/table';
import { handRecordView, tableView } from '../src/runtime/view';
import type { TournamentHooks } from '../src/runtime/types';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

type HandResult = Parameters<TournamentHooks['handEnded']>[0];

/** A tournament table driven by hand-written hooks instead of the director. */
function tournamentTable(n: number, opts: { gameId?: string } = {}) {
  const clock = new FakeClock();
  const ended: HandResult[] = [];
  const errors: unknown[] = [];
  const director = {
    gameId: opts.gameId ?? 'nlhe',
    onHandEnded: (r: HandResult) => void ended.push(r),
  };
  const hooks: TournamentHooks = {
    busy: () => false,
    gate: () => 'deal',
    level: () => ({
      gameId: director.gameId,
      stakes: { smallBlind: 10, bigBlind: 20, ante: 0, anteType: 'per-player', bringIn: 0, smallBet: 0, bigBet: 0 },
    }),
    handStarted: () => {},
    handEnded: (r) => director.onHandEnded(r),
  };
  const rt = TableRuntime.create(
    { id: 't1', hostId: 'host', settings: defaultSettings('tournament') },
    { clock, rng: seeded(), tournament: hooks, log: (m, e) => errors.push([m, e]) },
  );
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  for (const id of ids) rt.connect(id);
  ids.forEach((id, seat) => rt.placePlayer({ seat, playerId: id, name: id.toUpperCase(), stack: 1000 }));
  // What the manager does once everyone is seated.
  rt.state.started = true;
  rt.poke();
  return { rt, clock, ended, errors, director, ids };
}

const live = (rt: TableRuntime) => !!rt.state.hand && rt.state.hand.phase !== 'complete';
const toActId = (rt: TableRuntime) => rt.state.seats[rt.state.hand!.toAct!]!.playerId;

/** Everyone shoves or calls until the hand is over. */
function shoveDown(rt: TableRuntime) {
  for (let i = 0; i < 50 && live(rt); i++) {
    const h = rt.state.hand!;
    const legal = engine.legalActions(h, h.toAct!)!;
    if (legal.canRaise) rt.act(toActId(rt), { type: legal.raiseKind, to: legal.maxTo });
    else rt.act(toActId(rt), legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

/** Everyone folds to the big blind, so all keep chips for the next hand. */
function foldDown(rt: TableRuntime) {
  for (let i = 0; i < 20 && live(rt); i++) rt.act(toActId(rt), { type: 'fold' });
}

describe('tournament tables', () => {
  /**
   * Seats 0, 1, 3 and 4 play (seat 2 emptied after the first hand), and hands are played until one ends with the
   * button on 0, the small blind on 1 and the big blind on 3. The next hand then has the button on 1, the small blind
   * on 3 and the big blind on 4, so seat 2 sits between the button and the small blind.
   */
  function gapBetweenTheBlinds() {
    const t = tournamentTable(5);
    const { rt, clock } = t;
    foldDown(rt);
    rt.unseatPlayer('p3');
    for (let i = 0; i < 20; i++) {
      clock.advance(60_000);
      foldDown(rt);
      const p = rt.state.positions!;
      if (p.button === 0 && p.smallBlind === 1 && p.bigBlind === 3) return t;
    }
    throw new Error('the blinds never reached 0, 1 and 3');
  }

  // #311: on 4 Nov a player who re-entered was seated between the button and the small blind and dealt straight
  // into the next hand without paying a blind. Re-entry, late registration and table moves all take the first
  // empty seat after the last button (seatToFill), which lands there whenever the last small blind sat right after it.
  it('a player seated between the button and the small blind waits for the button to pass', () => {
    const { rt, clock } = gapBetweenTheBlinds();
    rt.connect('p9');
    rt.placePlayer({ seat: 2, playerId: 'p9', name: 'P9', stack: 1000 });
    clock.advance(60_000);
    expect(live(rt)).toBe(true);
    expect(rt.state.positions).toEqual({ button: 1, smallBlind: 3, bigBlind: 4 });
    expect(rt.state.hand!.seats.map((x) => x.playerId)).not.toContain('p9');
    expect(rt.seatOf('p9')!.stack).toBe(1000);
    expect(tableView(rt, 'p9', 0).seats[2]!.waiting).toBe(true);
    // The button moves on past them, and from the next hand they play, still without posting anything extra.
    foldDown(rt);
    clock.advance(60_000);
    expect(rt.state.positions).toEqual({ button: 3, smallBlind: 4, bigBlind: 0 });
    const hand = rt.state.hand!;
    expect(hand.seats.map((x) => x.playerId)).toContain('p9');
    expect(rt.seatOf('p9')!.stack).toBe(1000);
  });

  it('a player seated outside the blinds is dealt in at once, without posting', () => {
    const { rt, clock } = gapBetweenTheBlinds();
    rt.connect('p9');
    // Seat 6 comes after the next big blind (seat 4): an ordinary seat.
    rt.placePlayer({ seat: 6, playerId: 'p9', name: 'P9', stack: 1000 });
    clock.advance(60_000);
    expect(rt.state.positions).toEqual({ button: 1, smallBlind: 3, bigBlind: 4 });
    expect(rt.state.hand!.seats.map((x) => x.playerId)).toContain('p9');
    expect(rt.seatOf('p9')!.stack).toBe(1000);
  });

  it('keeps the names of players who have left the table in the hand log and history', () => {
    const { rt, ids } = tournamentTable(3);
    foldDown(rt);
    const record = rt.state.history.at(-1)!;
    rt.unseatPlayer('p2');
    expect(rt.seatOf('p2')).toBeNull();
    expect(tableView(rt, 'p1', 0).hand!.names).toEqual({ 0: 'P1', 1: 'P2', 2: 'P3' });
    expect(handRecordView(rt, record, 'p1').seats.map((x) => x.name)).toEqual(ids.map((id) => id.toUpperCase()));
  });

  it('reports add-ons bought during a hand in the end stacks, and nobody they cover is knocked out', () => {
    const { rt, ended, ids } = tournamentTable(2);
    expect(live(rt)).toBe(true);
    // The add-on break starts while this hand is still being played.
    for (const id of ids) rt.tournamentChips(id, 500);
    expect(rt.seatOf('p1')!.pendingChips).toBe(500);
    shoveDown(rt);
    expect(ended).toHaveLength(1);
    const { endStacks, knockedOutBy } = ended[0];
    // Someone lost the all-in, but the add-on keeps them in.
    expect(Object.values(endStacks).sort((a, b) => a - b)).toEqual([500, 2500]);
    for (const id of ids) expect(endStacks[id]).toBe(rt.seatOf(id)!.stack);
    expect(knockedOutBy).toEqual({});
  });

  it('still knocks out a player with nothing queued', () => {
    const { rt, ended } = tournamentTable(2);
    shoveDown(rt);
    const { endStacks, knockedOutBy } = ended[0];
    const loser = Object.keys(endStacks).find((id) => endStacks[id] === 0)!;
    const winner = Object.keys(endStacks).find((id) => id !== loser)!;
    expect(endStacks[winner]).toBe(2000);
    expect(knockedOutBy).toEqual({ [loser]: [winner] });
  });

  it('players cannot stand up from a tournament table', () => {
    const { rt } = tournamentTable(3);
    const id = toActId(rt);
    expect(() => rt.stand(id)).toThrow(/leave through the tournament/);
    expect(() => rt.stand(id, { afterHand: true })).toThrow(/leave through the tournament/);
    expect(rt.seatOf(id)!.leaveAfterHand).toBe(false);
    expect(rt.state.hand!.seats.find((s) => s.playerId === id)!.folded).toBe(false);
    foldDown(rt);
    // Between hands too.
    expect(() => rt.stand(id)).toThrow(/leave through the tournament/);
    expect(rt.seatOf(id)).not.toBeNull();
  });

  it('a level it cannot deal holds the table without stopping it, and a later poke deals', () => {
    // Razz deals at most 8: this level can't deal 9 players.
    const { rt, director } = tournamentTable(9, { gameId: 'razz' });
    expect(rt.state.hand).toBeNull();
    expect(rt.state.started).toBe(true);
    const offered = rt.nextCommit();
    rt.poke();
    rt.poke();
    // A deal that fails never spends the commitment browsers were shown (they warn about one replaced without a hand).
    expect(rt.nextCommit()).toBe(offered);
    expect(rt.state.log.filter((l) => l.text.startsWith("Couldn't deal")).map((l) => l.text)).toEqual(["Couldn't deal: Razz deals at most 8 players"]);
    director.gameId = 'nlhe';
    rt.poke();
    expect(rt.state.handNumber).toBe(1);
    expect(rt.state.hand!.input.game.id).toBe('nlhe');
    expect(rt.state.hand!.input.fair!.commit).toBe(offered);
    expect(rt.nextCommit()).not.toBe(offered);
  });

  it('an unknown game from the level never throws out of the next-hand timer; the table holds until it can deal', () => {
    const { rt, clock, director, errors } = tournamentTable(3);
    foldDown(rt);
    director.gameId = 'bogus';
    expect(() => clock.advance(60_000)).not.toThrow();
    expect(() => rt.poke()).not.toThrow();
    expect(rt.state.handNumber).toBe(1);
    expect(rt.state.started).toBe(true);
    // Logged once for the server, with a plain reason for the table.
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as unknown[])[1])).toMatch(/unknown game: bogus/);
    expect(rt.state.log.at(-1)!.text).toBe("Couldn't deal: this level cannot be dealt");
    director.gameId = 'nlhe';
    rt.poke();
    expect(rt.state.handNumber).toBe(2);
  });

  it('nothing thrown inside a table timer escapes it', () => {
    const { rt, clock, director, errors } = tournamentTable(2);
    director.onHandEnded = () => {
      throw new Error('director down');
    };
    // Nobody acts: the turn clock folds the player to act, which ends the hand.
    expect(() => clock.advance(5 * 60_000)).not.toThrow();
    expect(rt.state.history).toHaveLength(1);
    expect(errors.map((e) => String((e as unknown[])[1]))).toContain('Error: director down');
  });
});
