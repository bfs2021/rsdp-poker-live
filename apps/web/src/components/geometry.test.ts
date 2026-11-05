import { describe, expect, it } from 'vitest';
import { besideBet, clearSideBands, fitHand, handRoom, inFront, seatFractions, stadiumPoint } from './geometry';

const seats = (n: number, taken: number[]) => Array.from({ length: n }, (_, i) => taken.includes(i));

describe('seatFractions', () => {
  it('spaces a full table evenly from the anchor', () => {
    expect(seatFractions(seats(4, [0, 1, 2, 3]), 2)).toEqual([0.5, 0.75, 0, 0.25]);
  });

  it('spreads four players round a ten-seat table instead of bunching them', () => {
    const f = seatFractions(seats(10, [0, 1, 2, 3]), 0);
    expect([0, 1, 2, 3].map((s) => f[s])).toEqual([0, 0.25, 0.5, 0.75]);
    // The six empty seats share the last quarter, in seat order.
    const empties = [4, 5, 6, 7, 8, 9].map((s) => f[s]);
    expect(empties.every((t, i) => t > 0.75 && t < 1 && (i === 0 || t > empties[i - 1]))).toBe(true);
  });

  it('puts the anchor at the bottom and keeps seat order round the table', () => {
    const f = seatFractions(seats(9, [1, 4, 8]), 4);
    expect(f[4]).toBe(0);
    expect(f[8]).toBeCloseTo(1 / 3);
    expect(f[1]).toBeCloseTo(2 / 3);
    const order = [4, 5, 6, 7, 8, 0, 1, 2, 3].map((s) => f[s]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('keeps empty seats clear of the players beside them', () => {
    const f = seatFractions(seats(10, [0, 1, 2, 3]), 0, { clear: 0.04 });
    const empties = [4, 5, 6, 7, 8, 9].map((s) => f[s]);
    expect(Math.min(...empties) - 0.75).toBeGreaterThanOrEqual(0.04 - 1e-9);
    expect(1 - Math.max(...empties)).toBeGreaterThanOrEqual(0.04 - 1e-9);
    // Not enough room to keep clear: back to even spacing rather than overlapping players.
    expect(seatFractions(seats(10, [0, 1, 2, 3]), 0, { clear: 0.2 })).toEqual(Array.from({ length: 10 }, (_, s) => s / 10));
    // A single empty seat needs room on both sides too.
    expect(seatFractions(seats(3, [0, 1]), 0, { clear: 0.3 })).toEqual([0, 1 / 3, 2 / 3]);
  });

  it('keeps empty seats apart, going back to even spacing on a nearly full table', () => {
    // Four players, six empty seats: plenty of room, so players spread out.
    const sparse = seatFractions(seats(10, [0, 1, 2, 3]), 0, { clear: 0.04, minGap: 0.03 });
    expect(sparse[1]).toBe(0.25);
    const gaps = [4, 5, 6, 7, 8, 9, 10].map((s, i, a) => (i === 0 ? sparse[4] - 0.75 : s === 10 ? 1 - sparse[9] : sparse[s] - sparse[a[i - 1]]));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.03 - 1e-9);
    // Eight players and two empty seats side by side: too tight to space the players evenly, so that stretch grows just
    // enough and the rest share what is left, everything still apart and in order.
    const tight = seatFractions(seats(10, [0, 1, 2, 3, 4, 5, 8, 9]), 0, { clear: 0.04, minGap: 0.045 });
    expect(tight[0]).toBe(0);
    expect(tight).toEqual([...tight].sort((a, b) => a - b));
    expect(tight[7] - tight[6]).toBeGreaterThanOrEqual(0.045 - 1e-9);
    expect(tight[6] - tight[5]).toBeGreaterThanOrEqual(0.04 - 1e-9);
  });

  it('keeps two players at neighbouring seats far apart when the empty seats can only fit on one side', () => {
    const f = seatFractions(seats(10, [0, 1]), 0, { clear: 0.12, minGap: 0.07 });
    // The eight empty seats need 0.73 of the way round, so the other player gets the rest, not a tenth.
    expect(f[1]).toBeCloseTo(0.27);
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => f[s]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(1 - f[9]).toBeGreaterThanOrEqual(0.12 - 1e-9);
  });

  it('spreads players as evenly as it can when one stretch of empty seats needs more room (a phone, five empty in a row)', () => {
    const f = seatFractions(seats(9, [0, 1, 2, 3]), 0, { clear: 0.06, minGap: 0.035 });
    const gaps = [1, 2, 3].map((s) => f[s] - f[s - 1]);
    expect(Math.min(...gaps)).toBeGreaterThan(0.06 * 1.5);
    // Not bunched at even ninths, as they would be with even spacing.
    expect(f[3]).toBeGreaterThan(3 / 9 + 0.05);
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((s) => f[s]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('falls back to even spacing when nobody is seated', () => {
    expect(seatFractions(seats(4, []), 0)).toEqual([0, 0.25, 0.5, 0.75]);
  });
});

describe('clearSideBands', () => {
  const even = (n: number) => Array.from({ length: n }, (_, i) => i / n);

  it('keeps every seat out of the middle of the long sides on a tall table', () => {
    const [w, h, band] = [300, 600, 160];
    for (const t of clearSideBands(even(8), w, h, band)) {
      const p = stadiumPoint(t, w, h);
      const onSide = Math.abs(Math.abs(p.x - w / 2) - w / 2) < 1;
      if (onSide) expect(Math.abs(p.y - h / 2)).toBeGreaterThanOrEqual(band / 2 - 0.5);
    }
  });

  it('keeps the bottom seat at the bottom and the order round the table', () => {
    const out = clearSideBands(even(8), 300, 600, 160);
    expect(out[0]).toBe(0);
    expect(out.every((t, i) => i === 0 || t > out[i - 1])).toBe(true);
  });

  it('leaves wide tables alone', () => {
    expect(clearSideBands(even(6), 800, 500, 160)).toEqual(even(6));
  });
});

describe('inFront', () => {
  const box = { l: 140, r: 140, u: 60, d: 30 };
  const half = { w: 30, h: 12 };

  it('puts a top seat\'s bet straight below its nameplate, leaning in a little', () => {
    const p = inFront({ x: 200, y: 0 }, { x: 600, y: 300 }, box, half, 6);
    expect(p.y).toBe(48);
    expect(p.x).toBeCloseTo(248);
  });

  it('puts a seat at the end of the table beside its nameplate', () => {
    const p = inFront({ x: 0, y: 300 }, { x: 600, y: 300 }, box, half, 6);
    expect(p).toEqual({ x: 176, y: 300 });
  });

  it('never goes most of the way to the middle', () => {
    const p = inFront({ x: 600, y: 560 }, { x: 600, y: 300 }, { ...box, u: 400 }, half, 6);
    expect(p.y).toBeCloseTo(560 - 260 * 0.8);
  });
});

describe('besideBet', () => {
  it('puts the button beside a top seat\'s bet, away from the middle', () => {
    expect(besideBet({ x: 250, y: 50 }, { x: 200, y: 0 }, { x: 600, y: 300 }, { w: 30, h: 12 }, 20)).toEqual({ x: 200, y: 50 });
  });

  it('puts the button above a left seat\'s bet when the seat is above the middle', () => {
    expect(besideBet({ x: 176, y: 290 }, { x: 0, y: 280 }, { x: 600, y: 300 }, { w: 30, h: 12 }, 20)).toEqual({ x: 176, y: 258 });
  });
});

describe('handRoom and fitHand (#304: your cards covering a neighbour on a phone)', () => {
  const box = (left: number, right: number, top: number, bottom: number) => ({ left, right, top, bottom });
  // A 390px phone, nine players: your nameplate in the middle, Bea and Host either side and a little higher, Cal far above.
  const mine = box(155, 235, 530, 578);
  const others = [box(66, 141, 495, 543), box(248, 327, 495, 543), box(23, 98, 408, 456)];

  it('upright: twice the gap to the nearer neighbour level with your cards, less a margin', () => {
    expect(handRoom(mine, others, false, 84)).toBe(2 * (248 - 195 - 6));
  });
  it('ignores plates far above your cards, and has no limit when nobody is beside you', () => {
    expect(handRoom(mine, [box(23, 98, 300, 348)], false, 84)).toBe(Infinity);
  });
  it('sideways: the gap to the nearest plate on your left', () => {
    expect(handRoom(box(380, 460, 265, 313), [box(205, 275, 265, 313), box(565, 640, 265, 313)], true, 56)).toBe(380 - 6 - 275 - 6);
  });

  it('leaves a hand that fits as it is', () => {
    expect(fitHand(4, 200, { cw: 60, overlap: 24 })).toBeNull();
    expect(fitHand(4, Infinity, { cw: 60, overlap: 24 })).toBeNull();
  });
  it('bunches the cards first, then shrinks them, never past the floor', () => {
    const natural = { cw: 60, overlap: 24 };
    const width = (f: { cw: number; overlap: number }) => f.cw + 3 * (f.cw - f.overlap);
    const bunched = fitHand(4, 150, natural)!;
    expect(bunched.cw).toBe(60);
    expect(width(bunched)).toBeLessThanOrEqual(150);
    const smaller = fitHand(4, 96, natural)!;
    expect(smaller.cw).toBeLessThan(60);
    expect(width(smaller)).toBeLessThanOrEqual(97);
    // At least 45% of each card still shows, enough for its rank and suit.
    expect(smaller.cw - smaller.overlap).toBeGreaterThanOrEqual(Math.floor(smaller.cw * 0.45));
    expect(fitHand(4, 20, natural)!.cw).toBe(30);
  });
});
