import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { MIXED_GAMES, registerAllVariants } from '@rsdp/engine/variants';
import { HOST_HANDOFF_MS, RESUME_MIN_MS, TableRuntime } from '../src/runtime/table';
import { behind, delayedPart, tableView, type DelayedPart } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

function table(patch: (s: TableSettings) => void = () => {}) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded() });
  for (const p of ['host', 'a', 'b', 'c', 'd']) rt.connect(p);
  return { rt, clock };
}

function seatPlayers(rt: TableRuntime, n: number, stack = 200) {
  const ids = ['host', 'a', 'b', 'c', 'd'].slice(0, n);
  rt.updateSettings('host', { seating: { requireApproval: false } });
  ids.forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack }));
  return ids;
}

const hand = (rt: TableRuntime) => rt.state.hand!;
const toActId = (rt: TableRuntime) => rt.state.seats[hand(rt).toAct!]!.playerId;
const stacks = (rt: TableRuntime) => rt.state.seats.filter(Boolean).map((s) => s!.stack);
const total = (rt: TableRuntime) => stacks(rt).reduce((a, b) => a + b, 0);

/** Plays a hand out with checks and calls. */
function checkDown(rt: TableRuntime) {
  for (let i = 0; i < 100 && rt.state.hand && rt.state.hand.phase !== 'complete'; i++) {
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

describe('seating', () => {
  it('the host sits straight away; others wait for approval', () => {
    const { rt } = table();
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 100 });
    rt.requestSeat('a', { seat: 1, name: 'Ann', stack: 150 });
    expect(rt.state.seats[0]?.name).toBe('Host');
    expect(rt.state.seats[1]).toBeNull();
    expect(rt.state.requests).toHaveLength(1);
    expect(() => rt.approve('a', rt.state.requests[0].id)).toThrow(/only the host/);
    rt.approve('host', rt.state.requests[0].id);
    expect(rt.state.seats[1]).toMatchObject({ name: 'Ann', stack: 150 });
    expect(rt.state.ledger.a).toMatchObject({ buyIn: 150, cashOut: 0 });
  });

  it('rejects taken seats, double seating and bad stacks', () => {
    const { rt } = table((s) => (s.seating.requireApproval = false));
    rt.requestSeat('a', { seat: 1, name: 'Ann', stack: 100 });
    expect(() => rt.requestSeat('b', { seat: 1, name: 'Bo', stack: 100 })).toThrow(/taken/);
    expect(() => rt.requestSeat('a', { seat: 2, name: 'Ann', stack: 100 })).toThrow(/already/);
    expect(() => rt.requestSeat('b', { seat: 2, name: 'Bo', stack: 0 })).toThrow(/positive/);
    expect(() => rt.requestSeat('b', { seat: 2, name: '  ', stack: 10 })).toThrow(/name/);
    expect(() => rt.requestSeat('b', { seat: 12, name: 'Bo', stack: 10 })).toThrow(/no such seat/);
  });
});

describe('dealing and the next hand', () => {
  it('starts, deals, plays out, and deals again after the delay with the button moved', () => {
    const { rt, clock } = table();
    seatPlayers(rt, 3);
    expect(() => rt.start('a')).toThrow(/host/);
    rt.start('host');
    const first = hand(rt);
    expect(first.input.seats).toHaveLength(3);
    expect(rt.state.handNumber).toBe(1);
    checkDown(rt);
    expect(hand(rt).phase).toBe('complete');
    expect(total(rt)).toBe(600);
    expect(rt.state.nextHandAt).not.toBeNull();
    clock.advance(10_000);
    expect(rt.state.handNumber).toBe(2);
    expect(hand(rt).input.button).not.toBe(first.input.button);
  });

  it('waits for the host when hands do not start by themselves', () => {
    const { rt, clock } = table((s) => (s.timing.autoStartNextHand = false));
    seatPlayers(rt, 2);
    rt.start('host');
    checkDown(rt);
    clock.advance(60_000);
    expect(rt.state.handNumber).toBe(1);
    rt.dealNext('host');
    expect(rt.state.handNumber).toBe(2);
  });

  it('stop finishes the current hand and deals no more', () => {
    const { rt, clock } = table();
    seatPlayers(rt, 2);
    rt.start('host');
    rt.stop('host');
    checkDown(rt);
    clock.advance(60_000);
    expect(rt.state.handNumber).toBe(1);
    expect(rt.state.started).toBe(false);
  });
});

describe('clocks', () => {
  it('the time bank kicks in after the decision clock, then the player is checked or folded', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 20;
      s.timing.timeBankSeconds = 30;
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const seat = hand(rt).toAct!;
    clock.advance(20_000);
    expect(hand(rt).toAct).toBe(seat);
    expect(rt.state.turn?.usingBank).toBe(true);
    clock.advance(30_000);
    expect(hand(rt).seats.find((s) => s.seat === seat)!.folded).toBe(true);
    expect(rt.state.seats[seat]!.timeBank).toBe(0);
  });

  it('a player who acts during the time bank keeps what is left of it', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 20;
      s.timing.timeBankSeconds = 30;
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const id = toActId(rt);
    clock.advance(30_000);
    rt.act(id, { type: 'fold' });
    expect(rt.seatOf(id)!.timeBank).toBe(20);
  });

  it('two timeouts in a row sit a player out', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 10;
      s.timing.timeBankSeconds = 0;
    });
    seatPlayers(rt, 2);
    rt.start('host');
    const slow = toActId(rt);
    for (let i = 0; i < 6 && !rt.seatOf(slow)!.sittingOut; i++) {
      if (rt.state.hand?.phase !== 'complete' && toActId(rt) === slow) clock.advance(10_000);
      else if (rt.state.hand?.phase !== 'complete') {
        const legal = engine.legalActions(hand(rt), hand(rt).toAct!)!;
        rt.act(toActId(rt), legal.canCheck ? { type: 'check' } : { type: 'call' });
      }
      else clock.advance(10_000);
    }
    expect(rt.seatOf(slow)).toMatchObject({ sittingOut: true, sitOutReason: 'timeouts' });
  });

  it('an offline player gets a short grace period, even with no clock', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 0;
      s.seating.offlineGraceSeconds = 15;
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const id = toActId(rt);
    clock.advance(60_000);
    expect(toActId(rt)).toBe(id);
    rt.disconnect(id);
    clock.advance(14_000);
    expect(toActId(rt)).toBe(id);
    clock.advance(2_000);
    expect(rt.state.hand!.seats.find((s) => s.playerId === id)!.folded).toBe(true);
  });

  it('pause freezes the clock and resume gives the same time back', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 30;
      s.timing.timeBankSeconds = 0;
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const seat = hand(rt).toAct!;
    clock.advance(10_000);
    rt.pause('host', true);
    expect(() => rt.act(toActId(rt), { type: 'fold' })).toThrow(/paused/);
    clock.advance(600_000);
    rt.pause('host', false);
    expect(rt.state.turn!.deadline! - clock.now()).toBe(20_000);
    clock.advance(19_000);
    expect(hand(rt).toAct).toBe(seat);
    clock.advance(1_000);
    expect(hand(rt).toAct).not.toBe(seat);
  });

  it('while paused the clock everyone sees stands still, with its bar where it stopped', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 30;
      s.timing.timeBankSeconds = 0;
    });
    seatPlayers(rt, 3);
    rt.start('host');
    clock.advance(10_000);
    rt.pause('host', true);
    for (const wait of [0, 45_000, 600_000]) {
      clock.advance(wait);
      const turn = tableView(rt, 'a', clock.now()).turn!;
      expect(turn.deadline! - clock.now()).toBe(20_000);
      expect(turn.deadline! - turn.startedAt).toBe(30_000);
    }
    // A table saved before the pause time was kept shows the same.
    delete rt.state.pausedLeft!.at;
    clock.advance(5_000);
    expect(tableView(rt, 'a', clock.now()).turn!.deadline! - clock.now()).toBe(20_000);
    rt.pause('host', false);
    const turn = tableView(rt, 'a', clock.now()).turn!;
    expect(turn.deadline! - clock.now()).toBe(20_000);
    expect(turn.deadline! - turn.startedAt).toBe(30_000);
  });

  it('a clock paused in its last seconds gets a few back on resume', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 30;
      s.timing.timeBankSeconds = 0;
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const seat = hand(rt).toAct!;
    clock.advance(29_500);
    rt.pause('host', true);
    clock.advance(60_000);
    expect(hand(rt).toAct).toBe(seat);
    expect(tableView(rt, 'a', clock.now()).turn!.deadline! - clock.now()).toBe(RESUME_MIN_MS);
    rt.pause('host', false);
    expect(rt.state.turn!.deadline! - clock.now()).toBe(RESUME_MIN_MS);
    clock.advance(RESUME_MIN_MS - 1);
    expect(hand(rt).toAct).toBe(seat);
  });

  it('a time bank running when the game is paused is frozen, and charged only for time played', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 20;
      s.timing.timeBankSeconds = 30;
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const id = toActId(rt);
    clock.advance(25_000);
    expect(rt.state.turn!.usingBank).toBe(true);
    rt.pause('host', true);
    expect(() => rt.useTimeBank(id)).toThrow(/paused/);
    clock.advance(300_000);
    expect(rt.seatOf(id)!.timeBank).toBe(30);
    rt.pause('host', false);
    expect(rt.state.turn!.deadline! - clock.now()).toBe(25_000);
    clock.advance(5_000);
    rt.act(id, { type: 'fold' });
    expect(rt.seatOf(id)!.timeBank).toBe(20);
  });

  it('an offline player is not folded while paused, and gets their grace period after', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 0;
      s.seating.offlineGraceSeconds = 15;
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const id = toActId(rt);
    rt.disconnect(id);
    clock.advance(10_000);
    rt.pause('host', true);
    clock.advance(120_000);
    expect(toActId(rt)).toBe(id);
    expect(tableView(rt, 'a', clock.now()).turn!.deadline! - clock.now()).toBe(15_000);
    rt.pause('host', false);
    clock.advance(14_000);
    expect(toActId(rt)).toBe(id);
    clock.advance(1_000);
    expect(rt.state.hand!.seats.find((s) => s.playerId === id)!.folded).toBe(true);
  });

  it('delayed spectators see the clock stand still through a pause, and pick up after it', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 30;
      s.timing.timeBankSeconds = 0;
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const delay = 30_000;
    const snap = () => ({ at: clock.now(), part: delayedPart(tableView(rt, '', clock.now())) });
    const shown = (feed: { at: number; part: DelayedPart }, now: number) => {
      const v = behind(tableView(rt, '', now), feed.part, delay);
      return v.turn!.deadline! - (v.paused ? v.serverNow : now);
    };
    clock.advance(10_000);
    rt.pause('host', true);
    const paused = snap();
    clock.advance(120_000);
    // The pause snapshot, shown 30 s after it and again much later, still says 20 s.
    expect(shown(paused, paused.at + delay)).toBe(20_000);
    expect(shown(paused, clock.now())).toBe(20_000);
    rt.pause('host', false);
    const resumed = snap();
    clock.advance(delay);
    expect(shown(resumed, clock.now())).toBe(20_000);
  });

  it('a run it twice vote waits out a pause with its time left', () => {
    const { rt, clock } = table((s) => (s.play.runItTwice = 'ask'));
    seatPlayers(rt, 2);
    rt.start('host');
    const a = toActId(rt);
    rt.act(a, { type: 'raise', to: 200 });
    const b = toActId(rt);
    rt.act(b, { type: 'call' });
    expect(hand(rt).phase).toBe('rit-vote');
    clock.advance(4_000);
    rt.pause('host', true);
    clock.advance(120_000);
    expect(hand(rt).phase).toBe('rit-vote');
    const view = tableView(rt, a, clock.now());
    expect(view.canVoteRunItTwice).toBe(false);
    expect(view.hand!.runItTwice.deadline! - clock.now()).toBe(8_000);
    expect(() => rt.voteRunItTwice(a, true)).toThrow(/paused/);
    rt.pause('host', false);
    rt.voteRunItTwice(a, true);
    rt.voteRunItTwice(b, true);
    expect(hand(rt).runs).toHaveLength(2);
  });

  it('a run it twice vote called late on the clock does not spin the timers', () => {
    const { rt, clock } = table((s) => (s.play.runItTwice = 'ask'));
    seatPlayers(rt, 2);
    rt.start('host');
    rt.act(toActId(rt), { type: 'raise', to: 200 });
    // The caller's clock runs out a few seconds into the vote.
    clock.advance((rt.settings.timing.decisionSeconds - 3) * 1000);
    rt.act(toActId(rt), { type: 'call' });
    expect(hand(rt).phase).toBe('rit-vote');
    expect(rt.state.turn).toBeNull();
    clock.advance(5_000);
    expect(hand(rt).phase).toBe('rit-vote');
    clock.advance(10_000);
    expect(hand(rt).phase).toBe('complete');
  });

  it('run it twice: missing votes count as no when time runs out', () => {
    const { rt, clock } = table((s) => (s.play.runItTwice = 'ask'));
    seatPlayers(rt, 2);
    rt.start('host');
    const a = toActId(rt);
    rt.act(a, { type: 'raise', to: 200 });
    rt.act(toActId(rt), { type: 'call' });
    expect(hand(rt).phase).toBe('rit-vote');
    rt.voteRunItTwice(a, true);
    clock.advance(13_000);
    expect(hand(rt).phase).toBe('complete');
    expect(hand(rt).runs).toHaveLength(1);
    // A vote that arrives after the vote closed is ignored rather than refused.
    const other = hand(rt).seats.find((x) => rt.state.seats[x.seat]!.playerId !== a)!;
    expect(() => rt.voteRunItTwice(rt.state.seats[other.seat]!.playerId, true)).not.toThrow();
    expect(hand(rt).runs).toHaveLength(1);
  });
});

describe('host settings', () => {
  it('blinds change at the next hand, the table name at once, and both are logged', () => {
    const { rt, clock } = table();
    seatPlayers(rt, 2);
    rt.start('host');
    rt.updateSettings('host', { table: { name: 'Friday game' }, stakes: { smallBlind: 5, bigBlind: 10 } });
    expect(rt.settings.table.name).toBe('Friday game');
    expect(rt.settings.stakes.bigBlind).toBe(2);
    expect(rt.state.settingsLog.slice(-2).map((e) => e.when)).toEqual(['now', 'next-hand']);
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.stakes.bigBlind).toBe(10);
  });

  it('refuses unknown games, too many seats for a game, and mode switches', () => {
    const { rt } = table();
    expect(() => rt.updateSettings('host', { game: { gameId: 'nope' } })).toThrow(/unknown game/);
    expect(() => rt.updateSettings('host', { game: { gameId: 'plo6' } })).toThrow(/at most 7/);
    expect(() => rt.updateSettings('host', { table: { mode: 'tournament' } })).toThrow();
    expect(() => rt.updateSettings('host', { stakes: { smallBlind: 5, bigBlind: 2 } })).toThrow(/stakes.smallBlind/);
  });

  it('a blind schedule moves up by hands', () => {
    const { rt, clock } = table((s) => {
      s.blindSchedule = {
        enabled: true,
        countdown: 'hands',
        levels: [
          { smallBlind: 1, bigBlind: 2, ante: 0, minutes: 10, hands: 2 },
          { smallBlind: 2, bigBlind: 4, ante: 0, minutes: 10, hands: 2 },
        ],
      };
    });
    seatPlayers(rt, 2);
    rt.start('host');
    const bbs: number[] = [];
    for (let i = 0; i < 4; i++) {
      bbs.push(hand(rt).input.stakes.bigBlind);
      checkDown(rt);
      clock.advance(10_000);
    }
    expect(bbs).toEqual([2, 2, 4, 4]);
  });

  it('game rotation switches games every N hands', () => {
    const { rt, clock } = table((s) => {
      s.table.maxSeats = 6;
      s.game.rotation = {
        enabled: true,
        steps: [
          { gameId: 'nlhe', betting: 'no-limit', length: 2, unit: 'hands' },
          { gameId: 'plo4', betting: 'pot-limit', length: 1, unit: 'hands' },
          { gameId: 'stud', betting: 'fixed-limit', length: 1, unit: 'hands' },
        ],
      };
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const games: string[] = [];
    for (let i = 0; i < 5; i++) {
      games.push(hand(rt).input.game.id);
      checkDown(rt);
      clock.advance(10_000);
    }
    expect(games).toEqual(['nlhe', 'nlhe', 'plo4', 'stud', 'nlhe']);
  });

  for (const mix of MIXED_GAMES) {
    it(`${mix.name} deals every game in turn with its own betting, and only the stud games ante`, () => {
      const { rt, clock } = table((s) => {
        s.table.maxSeats = 6;
        s.stakes = { ...s.stakes, smallBlind: 1, bigBlind: 2, ante: 1, anteType: 'per-player', bringIn: 1, smallBet: 2, bigBet: 4 };
        s.game.rotation = { enabled: true, steps: mix.steps.map((st) => ({ ...st, length: 1, unit: 'hands' as const })) };
      });
      seatPlayers(rt, 3, 1000);
      rt.start('host');
      const dealt: { game: string; betting: string; antes: number }[] = [];
      for (let i = 0; i < mix.steps.length; i++) {
        const h = hand(rt);
        dealt.push({ game: h.input.game.id, betting: h.input.betting, antes: h.input.stakes.ante });
        checkDown(rt);
        expect(total(rt)).toBe(3000);
        clock.advance(10_000);
      }
      expect(dealt).toEqual(mix.steps.map((st) => ({ game: st.gameId, betting: st.betting, antes: ['razz', 'stud', 'stud8'].includes(st.gameId) ? 1 : 0 })));
    });
  }

  it('HORSE by orbits gives every game a full orbit, also going from stud back to the blind games', () => {
    const { rt, clock } = table((s) => {
      s.table.maxSeats = 8;
      s.stakes = { ...s.stakes, ante: 1, anteType: 'per-player', bringIn: 1, smallBet: 2, bigBet: 4 };
      s.game.rotation = { enabled: true, steps: MIXED_GAMES[0].steps.map((st) => ({ ...st, length: 1, unit: 'orbits' as const })) };
    });
    seatPlayers(rt, 3, 1000);
    rt.start('host');
    const games: string[] = [];
    for (let i = 0; i < 30; i++) {
      games.push(hand(rt).input.game.id);
      checkDown(rt);
      clock.advance(10_000);
    }
    const cycle = ['nlhe', 'plo8', 'razz', 'stud', 'stud8'].flatMap((g) => [g, g, g]);
    expect(games).toEqual([...cycle, ...cycle]);
  });

  it('a rotation without stud keeps its antes in every game', () => {
    const { rt, clock } = table((s) => {
      s.stakes = { ...s.stakes, ante: 1, anteType: 'per-player' };
      s.game.rotation = {
        enabled: true,
        steps: [
          { gameId: 'nlhe', betting: 'no-limit', length: 1, unit: 'hands' },
          { gameId: 'plo4', betting: 'pot-limit', length: 1, unit: 'hands' },
        ],
      };
    });
    seatPlayers(rt, 3);
    rt.start('host');
    const antes: number[] = [];
    for (let i = 0; i < 2; i++) {
      antes.push(hand(rt).input.stakes.ante);
      checkDown(rt);
      clock.advance(10_000);
    }
    expect(antes).toEqual([1, 1]);
  });
});

describe('chips and leaving', () => {
  it('a busted player sits out until a rebuy, which can need the host', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 0;
      s.play.runItTwice = 'off';
    });
    seatPlayers(rt, 2, 100);
    rt.start('host');
    // Shove and call until someone busts.
    for (let i = 0; i < 20; i++) {
      const h = hand(rt);
      if (h.phase !== 'complete') {
        const legal = engine.legalActions(h, h.toAct!)!;
        const id = toActId(rt);
        if (legal.canRaise) rt.act(id, { type: legal.raiseKind, to: legal.maxTo });
        else rt.act(id, legal.canCheck ? { type: 'check' } : { type: 'call' });
        continue;
      }
      if (rt.state.seats.some((s) => s && s.stack === 0)) break;
      clock.advance(10_000);
    }
    const busted = rt.state.seats.find((s) => s && s.stack === 0)!;
    expect(busted).toMatchObject({ sittingOut: true, sitOutReason: 'busted' });
    // Past the showdown pause and the all-in runout, which the next hand waits for.
    clock.advance(20_000);
    expect(rt.state.hand!.phase).toBe('complete');
    if (busted.playerId !== 'host') {
      rt.rebuy(busted.playerId, 100);
      expect(rt.state.requests).toHaveLength(1);
      rt.approve('host', rt.state.requests[0].id);
    } else rt.rebuy('host', 100);
    expect(rt.seatOf(busted.playerId)).toMatchObject({ stack: 100, sittingOut: false });
    expect(rt.state.ledger[busted.playerId].buyIn).toBe(200);
    clock.advance(1);
    expect(rt.state.hand!.phase).not.toBe('complete');
  });

  it('a busted player the host gives a stack to is back in, as after a rebuy', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 0;
      s.play.runItTwice = 'off';
    });
    seatPlayers(rt, 2, 100);
    rt.start('host');
    for (let i = 0; i < 20; i++) {
      const h = hand(rt);
      if (h.phase !== 'complete') {
        const legal = engine.legalActions(h, h.toAct!)!;
        const id = toActId(rt);
        if (legal.canRaise) rt.act(id, { type: legal.raiseKind, to: legal.maxTo });
        else rt.act(id, legal.canCheck ? { type: 'check' } : { type: 'call' });
        continue;
      }
      if (rt.state.seats.some((s) => s && s.stack === 0)) break;
      clock.advance(10_000);
    }
    const busted = rt.state.seats.find((s) => s && s.stack === 0)!;
    expect(busted).toMatchObject({ sittingOut: true, sitOutReason: 'busted' });
    clock.advance(20_000);
    rt.setStack('host', busted.playerId, 150);
    expect(rt.seatOf(busted.playerId)).toMatchObject({ stack: 150, sittingOut: false, sitOutReason: null });
    expect(rt.state.ledger[busted.playerId].buyIn).toBe(250);
    clock.advance(1);
    expect(rt.state.hand!.phase).not.toBe('complete');
  });

  it("leaves a player sitting out by choice sitting out when the host sets their stack", () => {
    const { rt } = table();
    seatPlayers(rt, 3);
    rt.sitOut('a', true);
    rt.setStack('host', 'a', 300);
    expect(rt.seatOf('a')).toMatchObject({ stack: 300, sittingOut: true, sitOutReason: 'player' });
  });

  it("tells a sitting-out player with no chips that they can't sit back in, by the rule sitting in uses", () => {
    const { rt } = table();
    seatPlayers(rt, 3);
    rt.sitOut('a', true);
    rt.setStack('host', 'a', 0);
    expect(tableView(rt, 'a', 0).me.canSitIn).toBe(false);
    expect(() => rt.sitOut('a', false)).toThrow(/rebuy before sitting back in/);
    rt.setStack('host', 'a', 50);
    expect(tableView(rt, 'a', 0).me.canSitIn).toBe(true);
    // During a hand a stack edit waits for the end, and the chips the hand started with still count.
    rt.sitOut('a', false);
    rt.start('host');
    rt.sitOut('a', true);
    rt.setStack('host', 'a', 0);
    expect(tableView(rt, 'a', 0).me.canSitIn).toBe(true);
    // Someone not seated has no seat to sit back in to.
    rt.connect('e');
    expect(tableView(rt, 'e', 0).me.canSitIn).toBe(false);
  });

  it('standing up mid-hand folds, leaves after the hand and records the cash-out', () => {
    const { rt, clock } = table();
    seatPlayers(rt, 3);
    rt.start('host');
    const id = toActId(rt);
    rt.stand(id);
    expect(hand(rt).seats.find((s) => s.playerId === id)!.folded).toBe(true);
    expect(rt.seatOf(id)).not.toBeNull();
    checkDown(rt);
    expect(rt.seatOf(id)).toBeNull();
    expect(rt.state.ledger[id].cashOut).toBe(200);
    clock.advance(10_000);
    expect(hand(rt).input.seats).toHaveLength(2);
  });

  it('a player joining a running game posts a big blind to play or waits for it', () => {
    const { rt, clock } = table();
    seatPlayers(rt, 3);
    rt.start('host');
    checkDown(rt);
    rt.requestSeat('d', { seat: 5, name: 'D', stack: 200 });
    expect(rt.seatOf('d')!.isNew).toBe(true);
    clock.advance(10_000);
    const h = hand(rt);
    const dealt = h.input.seats.some((s) => s.playerId === 'd');
    const posted = h.input.posts.some((p) => p.seat === 5);
    expect(dealt).toBe(posted);
    expect(total(rt) + h.seats.reduce((a, s) => a + s.total, 0) - h.seats.reduce((a, s) => a + s.startStack - s.stack, 0)).toBeGreaterThan(0);
  });

  it('chips are conserved over many hands with players coming and going', () => {
    const { rt, clock } = table((s) => (s.timing.decisionSeconds = 0));
    seatPlayers(rt, 4);
    rt.start('host');
    const r = seeded(99);
    for (let i = 0; i < 300; i++) {
      const h = rt.state.hand;
      if (h && h.phase !== 'complete' && h.toAct !== null) {
        const id = toActId(rt);
        const roll = r(10);
        try {
          if (h.phase === 'drawing') rt.draw(id, []);
          else if (roll < 2) rt.act(id, { type: 'fold' });
          else if (roll < 4) rt.act(id, { type: 'raise', to: (h.currentBet || 2) * 2 });
          else rt.act(id, { type: 'call' });
        } catch {
          // A raise past the stack (or a call with nothing to call) is refused; check, or call if there's a bet.
          rt.act(id, engine.legalActions(h, h.toAct)!.canCheck ? { type: 'check' } : { type: 'call' });
        }
      } else clock.advance(10_000);
      if (i === 100) rt.stand('d', { afterHand: true });
      if (i === 150) rt.requestSeat('d', { seat: 7, name: 'D', stack: 50 });
    }
    // During a hand the table's stacks are still the starting stacks; queued chips land after it.
    const inPlay = rt.state.seats.filter(Boolean).reduce((a, s) => a + s!.stack + s!.pendingChips, 0);
    const ledger = Object.values(rt.state.ledger);
    const bought = ledger.reduce((a, l) => a + l.buyIn, 0);
    const out = ledger.reduce((a, l) => a + l.cashOut, 0);
    expect(inPlay + out).toBe(bought);
    expect(rt.state.handNumber).toBeGreaterThan(20);
  });
});

describe('snapshots', () => {
  it('a table restored from JSON mid-hand carries on', () => {
    const { rt, clock } = table((s) => (s.timing.decisionSeconds = 30));
    seatPlayers(rt, 3);
    rt.start('host');
    clock.advance(5_000);
    const json = JSON.parse(JSON.stringify(rt.state));
    rt.dispose();
    const restored = new TableRuntime(json, { clock, rng: seeded(3) });
    for (const p of ['host', 'a', 'b']) restored.connect(p);
    restored.resume();
    expect(restored.state.hand!.toAct).toBe(rt.state.hand!.toAct);
    const seat = restored.state.hand!.toAct!;
    // The clocks run again: the turn starts over after the restart (see 'a restart in the middle of a hand').
    clock.advance(30_000);
    expect(restored.state.hand!.seats.find((s) => s.seat === seat)!.folded || restored.state.turn?.usingBank).toBeTruthy();
  });
});

describe('host handoff', () => {
  it('passes the table to the next online seated player after the host is offline a while', () => {
    const { rt, clock } = table();
    seatPlayers(rt, 4);
    rt.sitOut('a', true);
    rt.disconnect('host');
    clock.advance(HOST_HANDOFF_MS - 1000);
    expect(rt.state.hostId).toBe('host');
    clock.advance(1000);
    // Seat 1 is sitting out, so seat 2 takes over.
    expect(rt.state.hostId).toBe('b');
    expect(rt.state.log.at(-1)?.text).toMatch(/B is now the host/);
  });

  it('does nothing if the host comes back in time', () => {
    const { rt, clock } = table();
    seatPlayers(rt, 3);
    rt.disconnect('host');
    clock.advance(HOST_HANDOFF_MS / 2);
    rt.connect('host');
    clock.advance(HOST_HANDOFF_MS * 2);
    expect(rt.state.hostId).toBe('host');
  });

  it('waits for someone to be online to take over', () => {
    const { rt, clock } = table();
    seatPlayers(rt, 2);
    rt.disconnect('a');
    rt.disconnect('host');
    clock.advance(HOST_HANDOFF_MS * 2);
    expect(rt.state.hostId).toBe('host');
    // Someone to take over arriving hands the table on straight away.
    rt.connect('a');
    clock.advance(0);
    expect(rt.state.hostId).toBe('a');
  });

  it('lets the host hand over by hand, but only to someone at the table', () => {
    const { rt } = table();
    seatPlayers(rt, 2);
    expect(() => rt.transferHost('host', 'stranger')).toThrow(/not at the table/);
    rt.disconnect('a');
    expect(() => rt.transferHost('host', 'a')).toThrow(/offline/);
    rt.connect('a');
    rt.transferHost('host', 'a');
    expect(rt.state.hostId).toBe('a');
    expect(() => rt.transferHost('host', 'a')).toThrow(/host/);
  });
});

describe('ledger', () => {
  it('counts host stack cuts as chips taken out, so net is unchanged by the edit itself', () => {
    const { rt } = table();
    seatPlayers(rt, 2, 200);
    rt.setStack('host', 'a', 150);
    expect(rt.state.ledger.a).toMatchObject({ buyIn: 200, cashOut: 50 });
    rt.setStack('host', 'a', 300);
    expect(rt.state.ledger.a).toMatchObject({ buyIn: 350, cashOut: 50 });
  });
});

describe('late shows', () => {
  it('stores the hand again when someone shows after it', () => {
    const { rt } = table();
    seatPlayers(rt, 2);
    const saved: { handNumber: number; shown: boolean }[] = [];
    rt.start('host');
    const folder = toActId(rt);
    rt.act(folder, { type: 'fold' });
    rt.onHandFinished = (r) => saved.push({ handNumber: r.handNumber, shown: r.hand.seats.some((x) => x.playerId === folder && x.shown?.length) });
    expect(hand(rt).phase).toBe('complete');
    rt.show(folder, [0, 1]);
    expect(saved).toEqual([{ handNumber: 1, shown: true }]);
    expect(rt.state.history.at(-1)!.hand.seats.find((x) => x.playerId === folder)!.shown?.length).toBe(2);
  });
});

describe('hole cards after the hand', () => {
  /** Hole cards dealt to `seat` as `viewer` receives them in the hand still on the table. */
  const dealtTo = (rt: TableRuntime, viewer: string, seat: number) =>
    tableView(rt, viewer, 0)
      .hand!.events.flatMap((e) => (e.t === 'deal' && e.seat === seat ? e.cards.map((c) => c.card) : []));
  const foldAround = (rt: TableRuntime) => {
    for (let i = 0; i < 20 && hand(rt).phase !== 'complete'; i++) rt.act(toActId(rt), { type: 'fold' });
  };

  it('a seat shuffle does not show anyone the folded cards of whoever had their new seat', () => {
    const { rt } = table((s) => (s.timing.autoStartNextHand = false));
    seatPlayers(rt, 4, 1000);
    rt.start('host');
    const h = hand(rt);
    foldAround(rt);
    const dealt = new Map(h.seats.map((x) => [x.playerId, x.cards.map((c) => c.card)]));
    rt.shuffleSeats('host');
    let moved = 0;
    for (const seat of rt.state.seats) {
      if (!seat) continue;
      const before = h.seats.find((x) => x.seat === seat.seat)!;
      if (before.playerId === seat.playerId) continue;
      moved++;
      expect(dealtTo(rt, seat.playerId, seat.seat)).not.toContain(dealt.get(before.playerId)![0]);
      // Their own cards still show, from the seat they played the hand in.
      const mine = h.seats.find((x) => x.playerId === seat.playerId)!;
      expect(dealtTo(rt, seat.playerId, mine.seat)).toEqual(dealt.get(seat.playerId));
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('someone who sits down where a folder just left does not see the folded cards', () => {
    const { rt } = table((s) => (s.timing.autoStartNextHand = false));
    seatPlayers(rt, 3, 1000);
    rt.start('host');
    foldAround(rt);
    const folded = hand(rt).seats.find((x) => x.folded && x.playerId !== 'host')!;
    rt.stand(folded.playerId);
    rt.updateSettings('host', { seating: { requireApproval: false } });
    rt.requestSeat('d', { seat: folded.seat, name: 'D', stack: 1000 });
    expect(rt.seatOf('d')?.seat).toBe(folded.seat);
    expect(dealtTo(rt, 'd', folded.seat).every((c) => c === '??' || !folded.cards.some((x) => x.card === c))).toBe(true);
  });
});

describe('a restart in the middle of a hand', () => {
  /** SIGTERM: the table is saved as it is; the new server loads it `downMs` later and the first browser reconnects. */
  const restart = (rt: TableRuntime, clock: FakeClock, downMs: number, first: string) => {
    const saved = JSON.parse(JSON.stringify(rt.state));
    rt.dispose();
    clock.advance(downMs);
    const back = new TableRuntime(saved, { clock, rng: seeded(6) });
    back.resume();
    back.connect(first);
    return back;
  };

  it('gives the player to act a fresh clock instead of folding them', () => {
    const { rt, clock } = table((s) => (s.timing.decisionSeconds = 30));
    seatPlayers(rt, 3, 1000);
    rt.start('host');
    rt.act(toActId(rt), { type: 'raise', to: 60 });
    const thinker = toActId(rt);
    clock.advance(10_000);
    const back = restart(rt, clock, 20_000, thinker);
    const seat = back.seatOf(thinker)!;
    expect(hand(back).seats.find((x) => x.seat === seat.seat)!.folded).toBe(false);
    expect(seat.timeouts).toBe(0);
    expect(back.turnDeadline()).toBe(clock.now() + 30_000);
    back.act(thinker, { type: 'call' });
    // Someone who doesn't come back still times out, after the usual grace for a dropped player.
    const next = toActId(back);
    clock.advance(back.state.settings.seating.offlineGraceSeconds * 1000 + 1);
    expect(hand(back).seats.find((x) => x.playerId === next)!.folded).toBe(true);
  });

  it('keeps a run it twice vote open for the players who had not voted', () => {
    const { rt, clock } = table((s) => (s.play.runItTwice = 'ask'));
    seatPlayers(rt, 2, 1000);
    rt.start('host');
    const h = hand(rt);
    while (h.phase === 'betting') {
      const me = h.seats.find((x) => x.seat === h.toAct)!;
      rt.act(toActId(rt), h.currentBet > me.bet ? { type: 'call' } : { type: 'raise', to: 1000 });
    }
    expect(h.phase).toBe('rit-vote');
    rt.voteRunItTwice('host', true);
    const back = restart(rt, clock, 20_000, 'a');
    expect(hand(back).phase).toBe('rit-vote');
    back.voteRunItTwice('a', true);
    expect(hand(back).events.some((e) => e.t === 'run-it' && e.times === 2)).toBe(true);
  });
});

describe('removed during a run it twice vote', () => {
  it('plays out the hand of a player who called an all-in with chips behind', () => {
    const { rt } = table((s) => {
      s.play.runItTwice = 'ask';
      s.seating.requireApproval = false;
    });
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 1000 });
    rt.requestSeat('a', { seat: 1, name: 'Ann', stack: 300 });
    rt.requestSeat('b', { seat: 2, name: 'Bo', stack: 1000 });
    rt.start('host');
    const h = hand(rt);
    // Ann shoves; Bo, who covers her, calls; the host folds.
    while (h.phase === 'betting') {
      const who = toActId(rt);
      rt.act(who, who === 'a' ? { type: 'raise', to: 300 } : who === 'b' ? { type: 'call' } : { type: 'fold' });
    }
    expect(h.phase).toBe('rit-vote');
    const bo = h.seats.find((x) => x.playerId === 'b')!;
    expect(bo.allIn).toBe(false);
    rt.kick('host', 'b');
    // Bo had nothing left to decide: his called chips stay live, his missing vote counts as no, and he leaves after.
    expect(bo.folded).toBe(false);
    expect(h.phase).toBe('complete');
    expect(h.awards.length).toBeGreaterThan(0);
    expect(rt.seatOf('b')).toBeNull();
    expect(rt.state.ledger.b.cashOut).toBe(1000 - 300 + h.awards.filter((x) => x.seat === bo.seat).reduce((n, x) => n + x.amount, 0));
  });
});

describe('changing the table size between hands', () => {
  const firstHandThenResize = (seed: number, from: number, to: number, players: number) => {
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    Object.assign(settings.seating, { requireApproval: false });
    settings.table.maxSeats = from;
    settings.timing.autoStartNextHand = false;
    const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(seed) });
    ['host', 'a', 'b', 'c', 'd'].slice(0, players).forEach((id, seat) => {
      rt.connect(id);
      rt.requestSeat(id, { seat, name: id.toUpperCase(), stack: 1000 });
    });
    rt.start('host');
    for (let i = 0; i < 20 && hand(rt).phase !== 'complete'; i++) rt.act(toActId(rt), { type: 'fold' });
    const before = rt.state.positions!;
    rt.updateSettings('host', { table: { maxSeats: to } });
    rt.dealNext('host');
    return { before, after: rt.state.positions! };
  };

  it('a bigger table keeps the blinds moving one seat', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { before, after } = firstHandThenResize(seed, 6, 9, 4);
      expect(after.bigBlind, `seed ${seed}`).not.toBe(before.bigBlind);
      expect(after.smallBlind, `seed ${seed}`).toBe(before.bigBlind);
    }
  });

  it('a smaller table starts the blinds afresh only when one of them sat in a dropped seat', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { before, after } = firstHandThenResize(seed, 9, 6, 5);
      if (Math.max(before.button, before.smallBlind ?? 0, before.bigBlind ?? 0) < 6) expect(after.smallBlind, `seed ${seed}`).toBe(before.bigBlind);
      expect(after.bigBlind).toBeLessThan(6);
    }
  });
});

describe('table chat text', () => {
  it('never keeps half an emoji: lone surrogates go, and a long line is cut by whole characters', () => {
    const { rt } = table();
    rt.chat('a', 'hi \ud83d there');
    expect(rt.state.chat.at(-1)!.text).toBe('hi  there');
    rt.chat('a', `${'x'.repeat(299)}🃏🃏`);
    const long = rt.state.chat.at(-1)!.text;
    expect(Array.from(long)).toHaveLength(300);
    expect(long.endsWith('🃏')).toBe(true);
    expect(/\p{Cs}/u.test(long)).toBe(false);
  });
});

describe('hand-history downloads (no live HUDs)', () => {
  it('are closed to seated players and onlookers who never played while the game runs, and open when they leave or it stops', () => {
    const { rt } = table();
    seatPlayers(rt, 3);
    expect(['host', 'a', 'b', 'c'].map((p) => rt.recordsLocked(p))).toEqual([false, false, false, false]);
    rt.start('host');
    expect(['host', 'a', 'b', 'c'].map((p) => rt.recordsLocked(p))).toEqual([true, true, true, true]);
    expect(tableView(rt, 'a', 0).recordsLocked).toBe(true);
    checkDown(rt);
    rt.stand('a');
    // Ann played here and left: she can take her hands home. Cy only watched, so a second device can't fetch them.
    expect(rt.recordsLocked('a')).toBe(false);
    expect(rt.recordsLocked('c')).toBe(true);
    rt.stand('host');
    expect(rt.recordsLocked('host')).toBe(false);
    rt.stop('host');
    expect(['host', 'a', 'b', 'c'].map((p) => rt.recordsLocked(p))).toEqual([false, false, false, false]);
  });
});

describe('hand-history downloads at a practice table', () => {
  it('stay open while you have only played bots there, and close once it is a real game', () => {
    const { rt } = table();
    rt.requestSeat('host', { seat: 0, name: 'John', stack: 200 });
    rt.addBot('host', { ownerName: 'John' });
    rt.start('host');
    expect(rt.state.hand?.phase).toBe('betting');
    expect(rt.recordsLocked('host')).toBe(false);
    // Two people have been dealt into a hand here (set at the deal): a HUD would be on a person now.
    rt.state.realGame = true;
    expect(rt.recordsLocked('host')).toBe(true);
  });
});

describe('hand-history downloads at tournament tables', () => {
  it('stay closed to a player moved to another table until they are out or the event ends', () => {
    const clock = new FakeClock();
    let over = false;
    const alive = new Set(['a', 'b']);
    const hooks = { busy: () => false, over: () => over, stillPlaying: (p: string) => alive.has(p), gate: () => 'hold' as const, level: () => ({ gameId: 'nlhe', stakes: defaultSettings('tournament').stakes }), handStarted: () => {}, handEnded: () => {} };
    const rt = TableRuntime.create({ id: 't2', hostId: 'host', settings: defaultSettings('tournament') }, { clock, rng: seeded(), tournament: hooks });
    // Bob plays at another table now: no seat here, but still in the event.
    expect(rt.recordsLocked('b')).toBe(true);
    alive.delete('b');
    rt.state.handNames = { b: 'Bob' };
    expect(rt.recordsLocked('b')).toBe(false);
    over = true;
    alive.add('b');
    expect(rt.recordsLocked('b')).toBe(false);
  });
});
