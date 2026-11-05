import type { CSSProperties } from 'react';

/** Where things sit on the felt, in pixels from its top-left corner. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A point a fraction `t` (0..1) of the way round a stadium (a rectangle with
 * round ends) inside a w×h box, starting at the bottom centre and going
 * clockwise on screen (bottom, left, top, right). The round ends sit on the
 * short sides, so a tall box gives a tall table for phones.
 */
export function stadiumPoint(t: number, w: number, h: number): Point {
  const cx = w / 2;
  const cy = h / 2;
  const tall = h > w;
  const r = Math.min(w, h) / 2;
  const straight = Math.abs(h - w);
  const quarter = (Math.PI * r) / 2;
  const half = Math.PI * r;
  const arc = (c: Point, from: number, d: number): Point => {
    const a = from + d / r;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  };
  let d = (((t % 1) + 1) % 1) * (2 * straight + 2 * half);
  if (tall) {
    const low = { x: cx, y: cy + straight / 2 };
    const high = { x: cx, y: cy - straight / 2 };
    if (d < quarter) return arc(low, Math.PI / 2, d);
    d -= quarter;
    if (d < straight) return { x: cx - r, y: low.y - d };
    d -= straight;
    if (d < half) return arc(high, Math.PI, d);
    d -= half;
    if (d < straight) return { x: cx + r, y: high.y + d };
    d -= straight;
    return arc(low, 0, d);
  }
  const left = { x: cx - straight / 2, y: cy };
  const right = { x: cx + straight / 2, y: cy };
  if (d < straight / 2) return { x: cx - d, y: cy + r };
  d -= straight / 2;
  if (d < half) return arc(left, Math.PI / 2, d);
  d -= half;
  if (d < straight) return { x: left.x + d, y: cy - r };
  d -= straight;
  if (d < half) return arc(right, -Math.PI / 2, d);
  d -= half;
  return { x: right.x - d, y: cy + r };
}

/**
 * Where each seat sits round the table, as a fraction (0..1) from the bottom
 * centre. The anchor seat (yours, or seat 0 when watching) is at the bottom,
 * the players present are spaced evenly, and empty seats share the gaps
 * between them in seat order. So four players at a ten-seat table sit at the
 * four quarters instead of bunched on one side.
 *
 * `clear` is how far an empty seat must stay from a player's nameplate and
 * `minGap` how far empty seats stay from each other, both as fractions of
 * the way round. When some gap is too small for its empty seats (five empty
 * seats in a row on a phone), that gap grows just enough and the others share
 * what is left equally, so players stay as evenly spread as they can. When
 * nothing fits (a nearly full table), every seat goes back to even spacing.
 */
export function seatFractions(taken: readonly boolean[], anchor: number, { clear = 0, minGap = 0 } = {}): number[] {
  const n = taken.length;
  const even = Array.from({ length: n }, (_, seat) => ((seat - anchor + n) % n) / n);
  if (n === 0) return even;
  // Seat positions counted round from the anchor.
  const players: number[] = [];
  for (let k = 0; k < n; k++) if (taken[(anchor + k) % n]) players.push(k);
  if (players.length === 0) return even;
  if (players[0] !== 0) players.unshift(0);
  const m = players.length;
  const emptiesAfter = players.map((from, i) => (i + 1 < m ? players[i + 1] : n) - from - 1);
  // The least room each player's stretch (the player and the empty seats after it) needs.
  const least = emptiesAfter.map((e) => (e === 0 ? Math.max(2 * clear - minGap, minGap) : Math.max(2 * clear + (e - 1) * minGap, (e + 1) * minGap)));
  if (least.reduce((a, b) => a + b, 0) > 1 + 1e-9) return even;
  // Every stretch gets the same share, or the least it needs if that's more: the share is found by halving.
  let lo = least.every((b) => b <= 1 / m) ? 1 / m : 0;
  let hi = lo || 1;
  for (let k = 0; lo < hi && k < 50; k++) {
    const mid = (lo + hi) / 2;
    if (least.reduce((a, b) => a + Math.max(b, mid), 0) > 1) hi = mid;
    else lo = mid;
  }
  const spans = least.map((b) => Math.max(b, lo));
  const out = new Array<number>(n).fill(0);
  let at = 0;
  for (let i = 0; i < m; i++) {
    const from = players[i];
    const empties = emptiesAfter[i];
    const span = spans[i];
    out[(anchor + from) % n] = at;
    if (empties === 1) out[(anchor + from + 1) % n] = at + span / 2;
    else if (empties > 1) {
      // Evenly split, unless that would put the end ones too close to the players.
      const edge = Math.max(span / (empties + 1), clear);
      const room = span - 2 * edge;
      for (let j = 1; j <= empties; j++) out[(anchor + from + j) % n] = at + edge + (room * (j - 1)) / (empties - 1);
    }
    at += span;
  }
  return out;
}

/** Part of the way from `a` to `b`. */
export const lerp = (a: Point, b: Point, f: number): Point => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });

export const px = (p: Point) => ({ left: `${p.x}px`, top: `${p.y}px` });

/** CSS variables for an animation that starts at `from` and ends where the element is (`to`). */
export const fromVars = (from: Point, to: Point) =>
  ({ '--dx': `${from.x - to.x}px`, '--dy': `${from.y - to.y}px` }) as CSSProperties;

/**
 * On a tall (phone) table, keeps a band of `band` pixels clear of seats in the
 * middle of each long side, so the board and pot have the full width of the
 * felt. Fractions from `seatFractions` are spread over what is left of the way
 * round. Wide tables, and bands that don't fit, are returned unchanged.
 */
export function clearSideBands(fractions: readonly number[], w: number, h: number, band: number): number[] {
  const straight = h - w;
  const b = Math.min(band, straight * 0.9);
  if (straight <= 0 || b <= 0) return [...fractions];
  const r = w / 2;
  const total = 2 * straight + 2 * Math.PI * r;
  // Where the bands start, measured round from the bottom centre.
  const quarter = (Math.PI * r) / 2;
  const left = quarter + (straight - b) / 2;
  const right = quarter + straight + Math.PI * r + (straight - b) / 2;
  const usable = total - 2 * b;
  return fractions.map((f) => {
    let d = (((f % 1) + 1) % 1) * usable;
    if (d >= left) d += b;
    if (d >= right) d += b;
    return d / total;
  });
}

/** A box around a point: how far it reaches left, right, up and down. */
export interface Reach {
  l: number;
  r: number;
  u: number;
  d: number;
  /** Half the nameplate's width, without cards, so layout doesn't shift as cards come and go. */
  pod?: number;
}

/**
 * Where a seat's bet goes: just in front of its nameplate and cards (`box`,
 * around `from`), towards the middle (`to`). Seats above or below the middle
 * get it straight below or above them, seats at the ends straight beside
 * them, leaning a little towards the middle, the way chips sit on a real
 * table. `half` is the bet's half-size; it never goes more than `most` of
 * the way.
 */
export function inFront(from: Point, to: Point, box: Reach, half: { w: number; h: number }, gap: number, lean = 0.12, most = 0.8): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // `to` is the middle, so it is also half the felt's width and height.
  const vertical = Math.abs(dy) / Math.max(1, to.y) >= Math.abs(dx) / Math.max(1, to.x);
  if (vertical) {
    const reach = Math.min((dy >= 0 ? box.d : box.u) + half.h + gap, Math.abs(dy) * most);
    return { x: from.x + dx * lean, y: from.y + Math.sign(dy || 1) * reach };
  }
  const reach = Math.min((dx >= 0 ? box.r : box.l) + half.w + gap, Math.abs(dx) * most);
  return { x: from.x + Math.sign(dx) * reach, y: from.y + dy * lean };
}

/** The dealer button: beside the seat's bet spot, on the side away from the middle. */
export function besideBet(bet: Point, from: Point, to: Point, half: { w: number; h: number }, gap: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const vertical = Math.abs(dy) / Math.max(1, to.y) >= Math.abs(dx) / Math.max(1, to.x);
  if (vertical) return { x: bet.x - Math.sign(dx || 1) * (half.w + gap), y: bet.y };
  return { x: bet.x, y: bet.y - Math.sign(dy || -1) * (half.h + gap) };
}

/** A box on screen, as getBoundingClientRect gives it. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * On a phone, how wide your own hand may be before it covers a neighbour's nameplate (#304).
 * Standing up, your cards sit centred above your nameplate, so the room is twice the
 * distance to the nearest plate either side, among the plates level with your cards.
 * On its side, your cards sit just left of your nameplate, so the room is the gap to
 * the nearest plate on the left. Infinity when nothing is in the way.
 */
export function handRoom(mine: Box, others: readonly Box[], sideways: boolean, cardHeight: number, margin = 6): number {
  if (sideways) {
    const edge = Math.max(-Infinity, ...others.filter((o) => o.bottom > mine.top && o.top < mine.bottom && o.right <= mine.left + margin).map((o) => o.right));
    return mine.left - margin - edge - margin;
  }
  const top = mine.top - cardHeight;
  const level = others.filter((o) => o.bottom > top && o.top < mine.top + 8);
  const cx = (mine.left + mine.right) / 2;
  const near = Math.min(...level.map((o) => (o.right <= cx ? cx - o.right : o.left >= cx ? o.left - cx : Infinity)));
  return 2 * (near - margin);
}

/** A card width and how much each card covers the one before it, in pixels. */
export interface HandFit {
  cw: number;
  overlap: number;
}

/**
 * Your hand made to fit the room beside your nameplate: first the cards bunch up, still showing
 * at least `minShow` of each card (enough for its rank and suit), then they get smaller, down to
 * `minCw`. Null when the hand fits as it is, so the usual look is kept.
 */
export function fitHand(cards: number, room: number, natural: HandFit, minShow = 0.45, minCw = 30): HandFit | null {
  const width = (f: HandFit) => f.cw + (cards - 1) * (f.cw - f.overlap);
  if (cards < 2 || !(room < width(natural))) return null;
  const show = Math.min(minShow, (natural.cw - natural.overlap) / natural.cw);
  const bunched = (room - natural.cw) / (cards - 1);
  if (bunched >= show * natural.cw) return { cw: natural.cw, overlap: Math.round(natural.cw - bunched) };
  const cw = Math.max(minCw, Math.min(natural.cw, Math.floor(room / (1 + (cards - 1) * show))));
  return { cw, overlap: Math.round(cw * (1 - show)) };
}
