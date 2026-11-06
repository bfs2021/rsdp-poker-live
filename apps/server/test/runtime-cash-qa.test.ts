import { beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { TableRuntime } from '../src/runtime/table';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

function table() {
  const clock = new FakeClock();
  const s = defaultSettings('cash');
  s.seating.requireApproval = false;
  s.play.runItTwice = 'off';
  const rt = TableRuntime.create({ id: 't', hostId: 'host', settings: s }, { clock, rng: seeded() });
  for (const p of ['host', 'a', 'b', 'c']) rt.connect(p);
  rt.requestSeat('host', { seat: 0, name: 'H', stack: 100 });
  rt.requestSeat('a', { seat: 1, name: 'A', stack: 100 });
  rt.requestSeat('b', { seat: 2, name: 'B', stack: 100 });
  return { rt, clock };
}

const toAct = (rt: TableRuntime) => rt.state.seats[rt.state.hand!.toAct!]!.playerId;
const chipsAddUp = (rt: TableRuntime) => {
  const rows = Object.values(rt.state.ledger);
  const onTable = rt.state.seats.reduce((n, x) => n + (x ? x.stack + x.pendingChips : 0), 0);
  return rows.reduce((n, r) => n + r.buyIn, 0) === onTable + rows.reduce((n, r) => n + r.cashOut, 0);
};

describe('cash table edge cases', () => {
  it('nobody can sit in a seat a smaller table is about to drop', () => {
    const { rt, clock } = table();
    rt.start('host');
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    expect(() => rt.requestSeat('c', { seat: 8, name: 'C', stack: 300 })).toThrow(/going down to 6 seats/);
    expect(() => rt.moveSeat('host', 'a', 7)).toThrow(/going down to 6 seats/);
    expect(() => rt.addBot('host', { seat: 9 })).toThrow(/going down to 6 seats/);
    rt.requestSeat('c', { seat: 5, name: 'C', stack: 300 });
    while (rt.state.hand?.phase !== 'complete') rt.act(toAct(rt), { type: 'fold' });
    clock.advance(10_000);
    expect(rt.state.seats).toHaveLength(6);
    expect(rt.seatOf('c')?.seat).toBe(5);
    expect(chipsAddUp(rt)).toBe(true);
  });

  describe('switching to a game with fewer seats', () => {
    // The table from the bug report: 8 seats at a stud game, every seat taken (here the host and seven bots).
    function fullStud() {
      const clock = new FakeClock();
      const s = defaultSettings('cash');
      s.seating.requireApproval = false;
      s.play.runItTwice = 'off';
      s.table.maxSeats = 8;
      s.game.gameId = 'stud';
      s.game.betting = 'fixed-limit';
      const rt = TableRuntime.create({ id: 't', hostId: 'host', settings: s }, { clock, rng: seeded() });
      rt.connect('host');
      rt.requestSeat('host', { seat: 0, name: 'H', stack: 100 });
      for (let i = 1; i < 8; i++) rt.addBot('host', { seat: i });
      return { rt, clock };
    }
    const toTripleDraw = { game: { gameId: 'td27', betting: 'fixed-limit' as const }, table: { maxSeats: 6 } };

    it('says in plain words how many have to leave when everyone would not fit', () => {
      const { rt } = fullStud();
      expect(() => rt.updateSettings('host', toTripleDraw)).toThrow('2-7 Triple Draw seats at most 6 players and 8 are sitting down. 2 players need to leave the table (or remove some bots) before you can switch.');
      expect(rt.state.settings.game.gameId).toBe('stud');
      expect(rt.state.pendingSettings).toBeNull();
    });

    it('moves the players in the dropped seats into free ones when everyone fits', () => {
      const { rt } = fullStud();
      for (const x of rt.state.seats.slice(1, 4)) rt.removeBot('host', x!.playerId);
      const inSeven = rt.state.seats[6]!.playerId;
      const inEight = rt.state.seats[7]!.playerId;
      rt.updateSettings('host', toTripleDraw);
      expect(rt.state.settings.game.gameId).toBe('td27');
      expect(rt.state.seats).toHaveLength(6);
      expect(rt.seatOf(inSeven)!.seat).toBe(2);
      expect(rt.seatOf(inEight)!.seat).toBe(3);
      expect(rt.state.seats.filter(Boolean)).toHaveLength(5);
      expect(chipsAddUp(rt)).toBe(true);
      rt.start('host');
      expect(rt.state.hand?.input.game.id).toBe('td27');
    });

    it('mid-hand, waits for the hand to end and keeps the free seats for the players moving', () => {
      const { rt, clock } = table();
      rt.connect('c');
      rt.connect('d');
      rt.moveSeat('host', 'b', 8);
      rt.start('host');
      rt.updateSettings('host', { table: { maxSeats: 4 } });
      expect(rt.state.seats).toHaveLength(10);
      // Seats 3 and 4 are the only ones the smaller table keeps free, and seat 9 needs one of them.
      rt.requestSeat('c', { seat: 2, name: 'C', stack: 100 });
      expect(() => rt.requestSeat('d', { seat: 3, name: 'D', stack: 100 })).toThrow('the table is going down to 4 seats after this hand, and that seat is kept for a player moving into it');
      expect(() => rt.addBot('host')).toThrow(/every seat is taken/);
      while (rt.state.hand?.phase !== 'complete') rt.act(toAct(rt), { type: 'fold' });
      clock.advance(10_000);
      expect(rt.state.seats).toHaveLength(4);
      expect(rt.seatOf('b')!.seat).toBe(3);
      expect(rt.seatOf('c')!.seat).toBe(2);
      expect(chipsAddUp(rt)).toBe(true);
    });

    it('in a mixed-game rotation the game with the fewest seats sizes the table', () => {
      const { rt } = fullStud();
      const rotation = {
        enabled: true,
        steps: [
          { gameId: 'nlhe', betting: 'no-limit' as const, length: 1, unit: 'orbits' as const },
          { gameId: 'badugi', betting: 'fixed-limit' as const, length: 1, unit: 'orbits' as const },
        ],
      };
      expect(() => rt.updateSettings('host', { game: { rotation }, table: { maxSeats: 6 } })).toThrow(/^Badugi, one of the games in the rotation, seats at most 6 players and 8 are sitting down/);
      // Asking for more seats than the smallest game has is still refused.
      rt.removeBot('host', rt.state.seats[1]!.playerId);
      rt.removeBot('host', rt.state.seats[2]!.playerId);
      expect(() => rt.updateSettings('host', { game: { rotation }, table: { maxSeats: 8 } })).toThrow('Badugi seats at most 6');
      rt.updateSettings('host', { game: { rotation }, table: { maxSeats: 6 } });
      expect(rt.state.seats).toHaveLength(6);
      expect(rt.state.seats.every(Boolean)).toBe(true);
    });

    it('the blinds carry on from where they were', () => {
      const { rt, clock } = table();
      rt.moveSeat('host', 'b', 9);
      rt.start('host');
      while (rt.state.hand?.phase !== 'complete') rt.act(toAct(rt), { type: 'fold' });
      // b, in seat 10, had the big blind: it moves with them.
      expect(rt.state.positions).toEqual({ button: 0, smallBlind: 1, bigBlind: 9 });
      rt.updateSettings('host', { table: { maxSeats: 3 } });
      expect(rt.seatOf('b')!.seat).toBe(2);
      expect(rt.state.positions).toEqual({ button: 0, smallBlind: 1, bigBlind: 2 });
      clock.advance(10_000);
      // The button moves on to the next seat, as after any hand.
      expect(rt.state.positions?.button).toBe(1);
    });

    it("a seat someone asked for isn't given to a player moving when another is free", () => {
      const { rt } = table();
      rt.connect('c');
      rt.updateSettings('host', { seating: { requireApproval: true } });
      rt.moveSeat('host', 'b', 9);
      rt.requestSeat('c', { seat: 3, name: 'C', stack: 100 });
      rt.start('host');
      rt.updateSettings('host', { table: { maxSeats: 4 } });
      rt.approve('host', rt.state.requests[0].id);
      expect(rt.seatOf('c')!.seat).toBe(3);
    });

    it('lowering the seat count by hand works the same way', () => {
      const { rt } = table();
      rt.moveSeat('host', 'b', 9);
      expect(() => rt.updateSettings('host', { table: { maxSeats: 2 } })).toThrow('3 players are sitting down, so the table needs at least 3 seats');
      rt.updateSettings('host', { table: { maxSeats: 3 } });
      expect(rt.seatOf('b')!.seat).toBe(2);
    });
  });

  it('a seat request for a dropped seat is approved into an open one', () => {
    const { rt } = table();
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.requestSeat('c', { seat: 9, name: 'C', stack: 300 });
    rt.start('host');
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    rt.approve('host', rt.state.requests[0].id);
    expect(rt.seatOf('c')!.seat).toBeLessThan(6);
  });

  it('an all-in player who leaves keeps their hand and goes when it ends', () => {
    const { rt } = table();
    rt.start('host');
    const shover = toAct(rt);
    rt.act(shover, { type: 'raise', to: 100 });
    rt.act(toAct(rt), { type: 'call' });
    rt.stand(shover);
    const hs = rt.state.hand!.seats.find((x) => x.playerId === shover)!;
    expect(hs.folded).toBe(false);
    rt.act(toAct(rt), { type: 'fold' });
    expect(rt.state.hand!.phase).toBe('complete');
    expect(rt.seatOf(shover)).toBeNull();
    expect(chipsAddUp(rt)).toBe(true);
    // Whatever they won went out with them.
    const won = rt.state.hand!.seats.find((x) => x.playerId === shover)!.stack;
    expect(rt.state.ledger[shover].cashOut).toBe(won);
  });

  it('a player who leaves takes their rebuy request with them', () => {
    const { rt } = table();
    rt.updateSettings('host', { seating: { rebuyRequiresApproval: true } });
    rt.rebuy('a', 50);
    expect(rt.state.requests).toHaveLength(1);
    rt.stand('a');
    expect(rt.state.requests).toHaveLength(0);
  });
});
