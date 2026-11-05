import { describe, expect, it } from 'vitest';
import { bbExactFormat, bbFormat, betBoxAccepts, betFromInput, betStops, betToInput, betUnit, nearestStop, roundToUnit, SLIDER_STOPS, studBringIn } from './format';

describe('bbFormat', () => {
  it('shows amounts in big blinds, to one decimal when it is not whole', () => {
    const fmt = bbFormat(20);
    expect(fmt(200)).toBe('10 BB');
    expect(fmt(250)).toBe('12.5 BB');
    expect(fmt(10)).toBe('0.5 BB');
    expect(fmt(7)).toBe('0.35 BB');
    expect(bbFormat(100)(1)).toBe('0.01 BB');
    expect(bbFormat(50)(25)).toBe('0.5 BB');
  });
});

describe('bet box units', () => {
  it('turns big blinds typed in the box into whole chips', () => {
    const unit = { bb: 50 };
    expect(betFromInput(unit, 3)).toBe(150);
    expect(betFromInput(unit, 2.5)).toBe(125);
    expect(betFromInput(unit, 0.01)).toBe(1);
    expect(betFromInput({ bb: 3 }, 2.5)).toBe(8); // 7.5 chips rounds to 8
    expect(betFromInput({ bb: 2 }, 0.1 + 0.2)).toBe(1);
    expect(betFromInput(unit, NaN)).toBe(0);
    expect(betFromInput(unit, Infinity)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('shows chips in the box as big blinds to two places', () => {
    expect(betToInput({ bb: 50 }, 125)).toBe(2.5);
    expect(betToInput({ bb: 150 }, 425)).toBe(2.83);
    expect(betToInput({ bb: 2 }, 6)).toBe(3);
  });
  it('shows enough places to name the exact chip amount', () => {
    expect(betToInput({ bb: 1000 }, 2999)).toBe(2.999);
    expect(bbExactFormat(1000)(2999)).toBe('2.999 BB');
    expect(bbExactFormat(150)(425)).toBe('2.83 BB');
    for (const bb of [3, 7, 25, 150, 1000, 2500]) {
      for (let chips = 1; chips <= 20000; chips += 7) expect(betFromInput({ bb }, betToInput({ bb }, chips))).toBe(chips);
    }
  });
  it('round-trips amounts that are whole tenths of a big blind', () => {
    for (const bb of [2, 20, 50, 100, 150, 400]) {
      for (let tenths = 1; tenths <= 500; tenths++) {
        const chips = (tenths * bb) / 10;
        if (!Number.isInteger(chips)) continue;
        expect(betFromInput({ bb }, betToInput({ bb }, chips))).toBe(chips);
      }
    }
  });
  it('keeps chips and cents mode as before', () => {
    expect(betFromInput({ centsMode: false }, 40)).toBe(40);
    expect(betFromInput({ centsMode: true }, 1.25)).toBe(125);
    expect(betToInput({ centsMode: true }, 125)).toBe(1.25);
  });
});

describe('stud bring-in', () => {
  it('is a third of the small bet, to the nickel in dollars', () => {
    expect(studBringIn(50, true)).toBe(15);
    expect(studBringIn(100, true)).toBe(35);
    expect(studBringIn(10, true)).toBe(3);
    expect(studBringIn(2, false)).toBe(1);
    expect(studBringIn(10, false)).toBe(3);
  });
});

describe('bet slider stops', () => {
  it('bets in small blinds: quarters at .25/.50, the big blind when there is no small blind', () => {
    expect(betUnit({ smallBlind: 25, bigBlind: 50, smallBet: 50 })).toBe(25);
    expect(betUnit({ smallBlind: 0, bigBlind: 50, smallBet: 50 })).toBe(25);
    expect(betUnit({ smallBlind: 0, bigBlind: 0, smallBet: 0 })).toBe(1);
  });

  it('a short range moves one small blind at a time, ending on the exact all in', () => {
    const stops = betStops(100, 1037, 25);
    expect(stops[0]).toBe(100);
    expect(stops[1]).toBe(125);
    expect(stops.at(-1)).toBe(1037);
    expect(stops.at(-2)).toBe(1025);
    expect(stops.length).toBeLessThanOrEqual(SLIDER_STOPS + 2);
  });

  it('a deep stack moves in round amounts, never odd cents', () => {
    // $50 at .25/.50: whole dollars.
    const stops = betStops(100, 5000, 25);
    expect(stops.slice(0, 4)).toEqual([100, 200, 300, 400]);
    expect(stops.every((s) => s % 100 === 0)).toBe(true);
    // An odd minimum raise still starts the slider, then it joins the round amounts.
    expect(betStops(137, 5000, 25).slice(0, 3)).toEqual([137, 200, 300]);
    // $200 at 1/2: $5 at a time.
    expect(betStops(400, 20000, 100)[1]).toBe(500);
    expect(betStops(400, 20000, 100).length).toBeLessThanOrEqual(SLIDER_STOPS + 2);
    // Tournament chips at 10/20 with 1,500: 50 at a time.
    expect(betStops(40, 1500, 10).slice(0, 3)).toEqual([40, 50, 100]);
  });

  it('an odd small blind still gets a step that is a whole number of blinds', () => {
    const stops = betStops(30, 10000, 15);
    expect(stops.slice(1, -1).every((s) => s % 15 === 0)).toBe(true);
    // A round number of them (20 blinds at a time here), not a doubling like 240.
    expect(stops[2] - stops[1]).toBe(300);
    expect(stops.length).toBeLessThanOrEqual(SLIDER_STOPS + 2);
  });

  it('finds the stop nearest an amount, and rounds pot sizes to the unit', () => {
    const stops = betStops(100, 5000, 25);
    expect(stops[nearestStop(stops, 1861)]).toBe(1900);
    expect(roundToUnit(187, 25)).toBe(175);
    expect(roundToUnit(188, 25)).toBe(200);
  });
});

describe('betBoxAccepts', () => {
  it('lets digits in, and a decimal point only when the box takes fractions', () => {
    expect(betBoxAccepts('125', false)).toBe(true);
    expect(betBoxAccepts('12.5', true)).toBe(true);
    expect(betBoxAccepts('.', false)).toBe(false);
    expect(betBoxAccepts('', false)).toBe(true);
  });
  it('keeps letters and number-box extras out (#306)', () => {
    for (const t of ['a', 'abc', 'e', 'E', '+', '-', '1e5', '12a', ' '])
      for (const decimals of [false, true]) expect(betBoxAccepts(t, decimals), t).toBe(false);
  });
  it('takes a decimal comma where fractions are allowed, for comma-decimal phones', () => {
    expect(betBoxAccepts('12,5', true)).toBe(true);
    expect(betBoxAccepts(',', false)).toBe(false);
  });
});
