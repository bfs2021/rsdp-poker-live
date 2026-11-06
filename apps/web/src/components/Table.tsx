import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { runoutSteps } from '@rsdp/engine/core';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { clock, type Fmt } from '../format';
import { handStrength } from '../strength';
import { PlayingCard } from './PlayingCard';
import { besideBet, clearSideBands, fitHand, fromVars, handRoom, inFront, lerp, px, seatFractions, stadiumPoint, type HandFit, type Point, type Reach } from './geometry';
import { BoardExtras, FeltExtras, SeatExtras } from './table/slots';
import { baseChip, CHIP_SET, ChipStacks, DOLLAR_CHIPS } from './table/Chips';
import { feltStyle, usePrefs } from '../prefs';
import { CountUp, FeltEmblem, useLanded } from './table/Feel';
import { botOwnerLabel, botPlateLabel } from './table/BotLevels';

/** What a player who showed down made, when every card of theirs is face up to us. */
const shownHand = (gameId: string, seat: SeatView, board: string[]) =>
  seat.cards.length && seat.cards.every((c) => c.card !== '??') ? handStrength(gameId, seat.cards.map((c) => c.card), board) : null;

/** Re-renders on an interval while something on screen is counting down. */
export function useNow(active: boolean, ms = 200) {
  const [now, setNow] = useState(Date.now());
  // Catch up before painting when it starts again, so a countdown doesn't open on a stale time.
  useLayoutEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/**
 * The acting seat's clock: a line that drains to empty at the deadline. Keyed on the turn, so where it
 * starts and how long it runs are fixed when it appears; changing them on every tick would make it jump.
 */
function TurnLine({ turn, paused, serverNow, skew, bank, low }: { turn: { startedAt: number; deadline: number }; paused: boolean; serverNow: number; skew: number; bank: boolean; low: boolean }) {
  // Read the clock here rather than taking the table's \`now\`, which stands still while nothing ticks (a pause, a fresh turn).
  const [start] = useState(() => {
    const ms = Math.max(0, turn.deadline - (paused ? serverNow : Date.now() + skew));
    return { fraction: Math.min(1, ms / (turn.deadline - turn.startedAt)), ms };
  });
  return (
    <div className={`timer ${bank ? 'bank' : ''}`}>
      <div
        className={`timer-fill ${low ? 'low' : ''}`}
        style={{ '--from': start.fraction, animationDuration: `${start.ms}ms`, animationPlayState: paused ? 'paused' : 'running' } as CSSProperties}
      />
    </div>
  );
}

/**
 * The room the felt has in its column: the column's width, and the felt's height plus its top and bottom margins.
 * The felt stretches to fill the column, so this stays the same whatever its margins are.
 */
function useRoom(ref: RefObject<HTMLElement>, on: boolean) {
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!on || !el || !parent) return;
    const measure = () => {
      const css = getComputedStyle(el);
      const w = parent.clientWidth;
      // The exact height, not offsetHeight: that one is rounded while the margins (which grow with the table) are not, so
      // the sum moved by a pixel each time the scale changed, which changed the scale back: the table twitched (#350).
      const h = Math.round(el.getBoundingClientRect().height + parseFloat(css.marginTop) + parseFloat(css.marginBottom));
      setRoom((r) => (r.w === w && r.h === h ? r : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [ref, on]);
  return room;
}

/** The element's size, kept up to date as it changes. */
function useSize(ref: RefObject<HTMLElement>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * Your own hand's size on a phone as styles.css draws it (the 4-card and 5-to-7-card rules,
 * standing up and on its side). Keep in step with those rules.
 */
const PHONE_HAND = {
  upright: { four: { cw: 60, overlap: 24 }, more: { cw: 38, overlap: 15 } },
  sideways: { four: { cw: 40, overlap: 24 }, more: { cw: 34, overlap: 15 } },
};

/**
 * On a phone, a hand of four or more cards can be wider than the gap between the players either
 * side of you, and then covers their nameplates (#304). Measured after each render, this gives a
 * smaller fit for your cards when they'd reach a neighbour, and null when they fit as they are.
 * Desktop seats tuck the cards into the nameplate, so they're left alone.
 */
function useHandFit(felt: RefObject<HTMLElement>, compact: boolean): HandFit | null {
  const [fit, setFit] = useState<HandFit | null>(null);
  // Seats glide to new places when someone sits down or leaves; measure again once they've arrived.
  const [, setGlides] = useState(0);
  useEffect(() => {
    const el = felt.current;
    if (!el || !compact) return;
    const arrived = (e: TransitionEvent) => (e.target as HTMLElement).classList?.contains('seat') && setGlides((g) => g + 1);
    el.addEventListener('transitionend', arrived);
    return () => el.removeEventListener('transitionend', arrived);
  }, [felt, compact]);
  useLayoutEffect(() => {
    const el = felt.current;
    const me = el?.querySelector<HTMLElement>('.seat.me');
    const plate = me?.querySelector<HTMLElement>('.nameplate');
    const cards = me?.querySelectorAll('.hole:not(.mucked) .playing-card').length ?? 0;
    let next: HandFit | null = null;
    if (el && compact && plate && cards >= 4) {
      const sideways = window.matchMedia('(max-height: 500px)').matches;
      const natural = PHONE_HAND[sideways ? 'sideways' : 'upright'][cards === 4 ? 'four' : 'more'];
      const others = [...el.querySelectorAll<HTMLElement>('.seat:not(.me) .nameplate')].map((p) => p.getBoundingClientRect());
      // On its side the cards hang off the seat's left edge, which can be wider than its nameplate.
      next = fitHand(cards, handRoom((sideways ? me! : plate).getBoundingClientRect(), others, sideways, natural.cw * 1.4), natural);
    }
    if (next?.cw !== fit?.cw || next?.overlap !== fit?.overlap) setFit(next);
  });
  return fit;
}

/**
 * How far each seat's nameplate and cards reach from its centre, measured after
 * each render, so bets can sit just clear of them.
 */
function useSeatReach(felt: RefObject<HTMLElement>) {
  const [reach, setReach] = useState<Record<number, Reach>>({});
  useLayoutEffect(() => {
    const el = felt.current;
    if (!el) return;
    const next: Record<number, Reach> = {};
    let changed = false;
    el.querySelectorAll<HTMLElement>('.seat[data-seat]').forEach((seatEl) => {
      const seat = Number(seatEl.dataset.seat);
      const box = seatEl.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const pod = box.width / 2;
      let { left, right, top, bottom } = box;
      const hole = seatEl.querySelector<HTMLElement>('.hole:not(.mucked)');
      if (hole && hole.childElementCount) {
        const r = hole.getBoundingClientRect();
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      const now = { l: cx - left, r: right - cx, u: cy - top, d: bottom - cy, pod };
      const was = reach[seat];
      if (!was || Math.abs(was.pod! - pod) > 4 || Math.abs(was.l - now.l) + Math.abs(was.r - now.r) + Math.abs(was.u - now.u) + Math.abs(was.d - now.d) > 4) changed = true;
      next[seat] = now;
    });
    if (changed || Object.keys(next).length !== Object.keys(reach).length) setReach(next);
  });
  return reach;
}

/** The last card of a single all-in run: it waited face down on the board before turning over (#308). */
function heldCards(hand: TableView['hand']): string[] {
  if (!hand || !hand.events.some((e) => e.t === 'run-it' && e.times === 1)) return [];
  return runoutSteps(hand.events).at(-1)?.flatMap((e) => e.cards) ?? [];
}

/** A short badge for a seat that is not playing, or null when it is. */
function seatBadge(s: SeatView, tournament: boolean): { text: string; kind: 'offline' | 'away' | 'info' } | null {
  if (s.departed) return { text: 'Knocked out', kind: 'info' };
  if (!s.online) return { text: s.sittingOut ? 'Away · offline' : 'Offline', kind: 'offline' };
  if (s.sittingOut) {
    if (s.sitOutReason === 'busted') return { text: 'Busted', kind: 'away' };
    if (s.sitOutReason === 'host') return { text: 'Sat out by host', kind: 'away' };
    if (s.sitOutReason === 'timeouts') return { text: 'Away · timed out', kind: 'away' };
    return { text: 'Away', kind: 'away' };
  }
  if (s.leaving) return { text: 'Leaving', kind: 'info' };
  // A newcomer to a tournament table may sit out one more hand on the button or small blind, so don't promise the next.
  if (s.waiting && !s.inHand) return { text: s.waitForBigBlind ? 'Waits for big blind' : tournament ? 'Joining' : 'Plays next hand', kind: 'info' };
  return null;
}

export interface DiscardPick {
  selected: number[];
  toggle: (index: number) => void;
}

/** Chips flying across the felt: bets swept into the pot, the pot pushed to a winner. */
interface Flight {
  id: number;
  from: Point;
  to: Point;
  delay: number;
  kind: 'sweep' | 'award';
}

let flightId = 0;

export function Table({
  view,
  skew,
  fmt,
  compact = false,
  onPickSeat,
  onAddBot,
  onSeatClick,
  discard,
  fill = false,
  wide = false,
}: {
  view: TableView;
  /** Server clock minus ours. */
  skew: number;
  fmt: Fmt;
  /** Phone layout: a tall table and smaller seats. */
  compact?: boolean;
  onPickSeat?: (seat: number) => void;
  /** Put a practice bot in this empty seat. */
  onAddBot?: (seat: number) => void;
  onSeatClick?: (seat: SeatView) => void;
  discard?: DiscardPick | null;
  /** The table page's own table: on a big window it grows to fill its column. */
  fill?: boolean;
  /** The wide desktop layout (no side column): cards grow a little more than the nameplates. */
  wide?: boolean;
}) {
  const felt = useRef<HTMLDivElement>(null);
  const prefs = usePrefs();
  const size = useSize(felt);
  const reach = useSeatReach(felt);
  const handFit = useHandFit(felt, compact);
  const room = useRoom(felt, fill && !compact);
  const n = view.seats.length;
  // Rotate so your own seat is at the bottom.
  const offset = view.me.seat ?? 0;
  const hand = view.hand;
  const done = hand?.phase === 'complete';
  const live = !!hand && !done;
  const ticking = !view.paused && (!!view.turn || view.nextHandAt !== null || !!hand?.runItTwice.deadline);
  // While paused the server sends each clock as the time left at the view's own moment, so it stands still.
  const clientNow = useNow(ticking) + skew;
  const now = view.paused ? view.serverNow : clientNow;
  const myTurn = !!view.legal || !!view.canDraw || view.canVoteRunItTwice;

  // Geometry. Before the first measure, assume a typical box so nothing jumps far.
  const w = size.w || (compact ? 320 : 800);
  const h = size.h || (compact ? 520 : 500);
  const center: Point = { x: w / 2, y: h / 2 };
  // Empty seats keep half the widest nameplate (as measured, without cards, so nothing moves on the deal) plus half an empty seat clear of
  // players, and some room between each other, so they never land on someone's nameplate.
  const perimeter = 2 * Math.abs(w - h) + Math.PI * Math.min(w, h);
  const podHalf = Math.max(compact ? 60 : 120, ...view.seats.map((s, seat) => (s && reach[seat]?.pod ? reach[seat].pod! : 0)));
  const emptyHalf = compact ? 34 : 58;
  const spread = seatFractions(
    view.seats.map((s) => !!s),
    offset,
    { clear: (podHalf + emptyHalf + 6) / perimeter, minGap: (compact ? 72 : 120) / perimeter },
  );
  // On a phone, no seat sits level with the middle, so the board gets the felt's full width.
  // The band fits the pot, the board rows and a result line, plus the seats either side of it.
  const boardRows = !hand || hand.family === 'flop' ? Math.max(1, (hand?.boards.length ?? 1) * (hand?.boards[0]?.length ?? 1)) : 0;
  const band = 30 + (boardRows > 1 ? boardRows * 52 : boardRows * 68) + 30 + 100;
  const fractions = compact ? clearSideBands(spread, w, h, Math.max(0, Math.min(band, (perimeter - n * 100) / 2))) : spread;
  const seatPoint = (seat: number) => stadiumPoint(fractions[seat], w, h);
  // Desktop seats shrink a little when the players and empty seats round the table leave them less room than a
  // nameplate (about 290px a player and 130px an empty seat at full size), and grow a little on a big window. A short
  // felt keeps them smaller too, so seats at the top and bottom leave the board (two boards, the result) room between them.
  const players = view.seats.filter(Boolean).length;
  const roomy = Math.min(1.1, h / 460, (perimeter * 0.92) / (players * 290 + (n - players) * 130));
  // On a big window the whole table grows with it (#317): k is the table's scale, from the room the felt has. Below k = 1
  // (laptops, and the replayer) the sizes above stay as they were.
  // A short, very wide window (an ultrawide screen, or a big one with tall browser bars) has the width but not the height:
  // there the wide layout packs the table tighter from top to bottom, so it still grows a little instead of shrinking (#347).
  const kTall = Math.min(1.9, room.h / 560, room.w / 1180);
  const kShort = wide ? Math.min(1.25, room.h / 470, room.w / 1180) : 0;
  const k = !fill || compact || !room.w ? 1 : Math.round(Math.max(kTall, kShort) * 100) / 100;
  // On such a window the board gives up some height too, so bets in front of the seats above and below don't reach it.
  const short = kShort > kTall && k > 1;
  const grown = k > 1;
  // Seats grow with k unless the players round the felt need them smaller. The felt's size is estimated from the room
  // and k, not measured, because its margins grow with the seats and a measured size would feed back.
  // A player's nameplate with its tucked cards, at scale 1: wider with four cards, and with the wide layout's bigger cards.
  const gameId = (hand ?? view.upcoming)?.gameId ?? '';
  const fourCard = ['plo4', 'plo8', 'badugi'].includes(gameId);
  // Stud, triple draw and five- and six-card Omaha show a row of cards over the nameplate. In the wide layout those
  // cards are bigger too (#331), so the row stands taller and the felt leaves more room above the top seats.
  const longGame = wide && ['plo5', 'plo6', 'plo5-8', 'plo6-8', 'stud', 'razz', 'stud8', 'td27'].includes(gameId);
  const topMargin = longGame ? 106 : 84;
  const podWidth = (wide ? 320 : 290) + (fourCard ? 50 : 0);
  // The felt's side margins hold half a side seat's nameplate.
  const sideMargin = 140 + (fourCard ? 30 : 0);
  const estW = room.w - 2 * sideMargin * k;
  const estH = room.h - (topMargin + 46) * k;
  const estPerimeter = 2 * Math.abs(estW - estH) + Math.PI * Math.min(estW, estH);
  const grownScale = Math.round(Math.max(0.72, Math.min(k, (estPerimeter * 0.92) / (players * podWidth + (n - players) * 130))) * 100) / 100;
  const seatScale = compact ? 1 : grown ? grownScale : Math.round(Math.max(0.72, roomy) * 100) / 100;
  // Board cards grow with the felt, so a big window doesn't leave a small board in a sea of green.
  const boardCard = compact
    ? null
    : grown
      ? // With a row of big cards above and below it (#331), the board gives up a little height so bets don't reach it.
        Math.round(Math.max(short ? 44 : 60, Math.min((wide ? 80 : 68) * k, w * 0.085, h * (longGame ? 0.19 : 0.21) * (short ? 0.82 : 1))))
      : Math.round(Math.max(60, Math.min(88, w * 0.062, h * 0.17)));
  // Bets sit just inside each seat's nameplate and cards, on the way to the middle.
  const guess: Reach = compact ? { l: 50, r: 50, u: 55, d: 25 } : { l: 100, r: 100, u: 70, d: 32 };
  // The board sits midway between the seats above it and below it (your own cards are bigger),
  // so on a short window it doesn't run into either.
  let boardShift = 0;
  if (!compact || w > h) {
    let above = 0;
    let below = h;
    view.seats.forEach((s, seat) => {
      if (!s) return;
      const p = seatPoint(seat);
      const r = reach[seat] ?? guess;
      if (Math.abs(p.x - center.x) > w * 0.3) return;
      if (p.y < center.y) above = Math.max(above, p.y + r.d);
      else below = Math.min(below, p.y - r.u);
    });
    boardShift = Math.max(-h * 0.15, Math.min(h * 0.15, (above + below) / 2 - center.y));
  }
  const boardMiddle: Point = { x: center.x, y: center.y + boardShift };
  const betHalf = compact ? { w: 22, h: 10 } : { w: 30, h: 13 };
  const betPoint = (seat: number) => inFront(seatPoint(seat), boardMiddle, reach[seat] ?? guess, betHalf, compact ? 4 : 8);
  // The dealer button sits beside where that seat's bet goes, so the two never cover each other.
  const buttonPoint = (seat: number) => besideBet(betPoint(seat), seatPoint(seat), boardMiddle, betHalf, compact ? 18 : 24);

  // Winning cards, per board, and every card any winner used.
  const boardWinners = new Map<string, Set<string>>();
  const winningHole = new Set<string>();
  if (done)
    for (const a of hand!.awards) {
      const key = `${a.run}-${a.board}`;
      if (!boardWinners.has(key)) boardWinners.set(key, new Set());
      a.cards?.forEach((c) => {
        boardWinners.get(key)!.add(c);
        winningHole.add(c);
      });
    }
  const highlight = (card: string, set: Set<string> | undefined) => (!set || set.size === 0 || card === '??' ? '' : set.has(card) ? 'win' : 'dim');

  // One line per winner: total won and each different hand they won with. With two runs or two boards,
  // each hand says which run or board it won, so run 2's full house isn't shown as run 1's two pair.
  const results = new Map<number, { amount: number; handName?: string }>();
  if (done) {
    const twoRuns = hand!.boards.length > 1;
    const twoBoards = (hand!.boards[0]?.length ?? 0) > 1;
    const slots = hand!.boards.length * (hand!.boards[0]?.length ?? 1);
    const names = new Map<number, Map<string, string[]>>();
    for (const a of hand!.awards) {
      const prev = results.get(a.seat);
      results.set(a.seat, { amount: (prev?.amount ?? 0) + a.amount });
      if (!a.handName) continue;
      const where = [twoRuns && `Run ${a.run + 1}`, twoBoards && `Board ${a.board + 1}`].filter(Boolean).join(', ');
      const byName = names.get(a.seat) ?? new Map<string, string[]>();
      names.set(a.seat, byName);
      // A hi-lo scoop is named "Flush and 8-6 low": its halves group with high-only or low-only wins elsewhere.
      for (const name of a.half === 'scoop' ? a.handName.split(' and ') : [a.handName]) {
        const places = byName.get(name) ?? [];
        if (where && !places.includes(where)) places.push(where);
        byName.set(name, places);
      }
    }
    for (const [seat, byName] of names) {
      const list = [...byName.entries()];
      // Places are named unless every hand was won everywhere (or there's only one run and board).
      const everywhere = list.every(([, places]) => places.length === 0 || places.length === slots);
      results.get(seat)!.handName = everywhere
        ? list.map(([name]) => name).join(' and ')
        : list.map(([name, places]) => (places.length ? `${places.join(' & ')}: ${name}` : name)).join(' · ');
    }
  }

  // Chip flights: bets swept in when a betting round ends, the pot pushed to the winners.
  const [flights, setFlights] = useState<Flight[]>([]);
  const lastRound = useRef<{ key: string; hand: number } | null>(null);
  const lastBets = useRef<number[]>([]);
  const flightTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => flightTimers.current.forEach(clearTimeout), []);
  // Chips fly to the pot pill itself, not the middle of the board, so they land on it rather than on the cards.
  // The pill is gone once the hand is over, so its spot is kept from the last time it was on screen.
  const potSpot = useRef<Point | null>(null);
  useLayoutEffect(() => {
    const el = felt.current;
    const pot = el?.querySelector<HTMLElement>('.board .pot-row .pot');
    if (!el || !pot) return;
    const f = el.getBoundingClientRect();
    const r = pot.getBoundingClientRect();
    potSpot.current = { x: r.left + r.width / 2 - f.left - el.clientLeft, y: r.top + r.height / 2 - f.top - el.clientTop };
  }, [view, w, h]);
  const potPoint = (): Point => potSpot.current ?? boardMiddle;
  const geometry = useRef({ betPoint, seatPoint, center, potPoint });
  geometry.current = { betPoint, seatPoint, center: boardMiddle, potPoint };
  const roundKey = hand ? `${hand.handNumber}:${hand.street}:${done ? 'done' : 'live'}` : '';
  // Runs before the effect below stores this view's bets, so lastBets holds the round that just ended.
  useEffect(() => {
    const before = lastRound.current;
    lastRound.current = hand ? { key: roundKey, hand: hand.handNumber } : null;
    if (!hand || !before || before.key === roundKey || before.hand !== hand.handNumber || document.hidden) return;
    const g = geometry.current;
    const pot = g.potPoint();
    const next: Flight[] = [];
    lastBets.current.forEach((amount, seat) => {
      if (amount > 0) next.push({ id: ++flightId, from: g.betPoint(seat), to: pot, delay: 0, kind: 'sweep' });
    });
    if (done) {
      const winners = [...new Set(hand.awards.map((a) => a.seat))];
      for (const seat of winners) next.push({ id: ++flightId, from: pot, to: g.seatPoint(seat), delay: next.length ? 350 : 100, kind: 'award' });
    }
    if (!next.length) return;
    setFlights((f) => [...f, ...next]);
    const ids = new Set(next.map((f) => f.id));
    const t = setTimeout(() => {
      flightTimers.current.delete(t);
      setFlights((f) => f.filter((x) => !ids.has(x.id)));
    }, 1400);
    flightTimers.current.add(t);
  }, [roundKey]);
  useEffect(() => {
    lastBets.current = view.seats.map((s) => s?.bet ?? 0);
  }, [view]);

  // The pile in the pot pill grows when the swept bets land on it, not as they leave the seats.
  const potPile = useLanded(hand?.pots[0]?.amount ?? 0, 550);
  const bets = view.seats.reduce((s, x) => s + (x?.bet ?? 0), 0);
  const runs = hand?.boards ?? [];
  const multiRun = runs.length > 1;
  const multiBoard = (runs[0]?.length ?? 0) > 1;
  const stud = hand?.family === 'stud';
  // A single all-in run's last card waits face down on its board, then turns over where it lies (#308).
  const coming = new Set((hand?.comingNext ?? []).map((c) => `${c.run}-${c.board}`));
  const held = new Set(heldCards(hand));
  // Cash games use casino chips, a cent upwards. In chips, colours follow the stakes: the smallest forced bet sets the white chip.
  const stakes = hand?.stakes ?? view.settings.stakes;
  const dollars = view.settings.stakes.centsMode;
  const chipSet = dollars ? DOLLAR_CHIPS : CHIP_SET;
  const chipBase = dollars ? 1 : baseChip(Math.min(...[stakes.smallBlind, stakes.ante, stud ? stakes.bringIn : 0].filter((x): x is number => !!x && x > 0), Infinity));
  // Order of seats from the button, so the deal goes round the table.
  const dealOrder = (seat: number) => (hand ? (seat - hand.button - 1 + n) % n : 0);

  return (
    <div
      ref={felt}
      className={['felt', compact && 'compact', grown && 'grown', grown && wide && 'big-cards', short && 'short', handFit && 'hand-fit', done && hand!.awards.length > 0 && 'showdown', view.me.seat !== null && 'seated-view', myTurn && 'my-turn', view.cardsWatched && 'cards-watched'].filter(Boolean).join(' ')}
      style={{ ...feltStyle(prefs, view.settings.table.felt), '--seat-scale': seatScale, ...(grown ? { '--k': k, '--sk': seatScale, '--side-margin': `${sideMargin}px`, '--top-margin': `${topMargin}px` } : {}), ...(boardCard ? { '--board-cw': `${boardCard}px` } : {}), ...(handFit ? { '--fit-cw': `${handFit.cw}px`, '--fit-overlap': `${-handFit.overlap}px` } : {}) } as CSSProperties}
    >
      <FeltEmblem />
      <div className={`board${multiRun || multiBoard ? ' multi' : ''}`} style={boardShift ? { translate: `0 ${Math.round(boardShift)}px` } : undefined}>
        {runs.map((run, r) =>
          run.map(
            (cards, b) =>
              cards.length > 0 && (
                <div className="cards board-row" key={`${r}-${b}`}>
                  {(multiRun || multiBoard) && <span className="board-label">{multiRun ? `Run ${r + 1}` : `Board ${b + 1}`}</span>}
                  {cards.map((c, i) =>
                    held.has(c) ? (
                      // Takes the face-down card's place and turns over there.
                      <PlayingCard key={`${hand!.handNumber}-${r}-${b}-${c}`} card={c} className={`turn-held ${highlight(c, boardWinners.get(`${r}-${b}`))}`} />
                    ) : (
                      <PlayingCard
                        key={`${hand!.handNumber}-${r}-${b}-${c}`}
                        card={c}
                        className={`deal-board ${highlight(c, boardWinners.get(`${r}-${b}`))}`}
                        style={{ animationDelay: `${cards.length <= 3 ? i * 160 : 0}ms` }}
                      />
                    ),
                  )}
                  {coming.has(`${r}-${b}`) && (
                    <span className="held-slot" key={`${hand!.handNumber}-${r}-${b}-held`}>
                      <PlayingCard card={null} className="deal-board" />
                    </span>
                  )}
                </div>
              ),
          ),
        )}
        {live && (
          <div className="pots">
            <div className="pot-row">
              {hand!.pots.length > 1 ? (
                hand!.pots.map((p, i) => (
                  <div className="pot" key={i}>
                    <ChipStacks amount={p.amount} base={chipBase} set={chipSet} />
                    {i === 0 ? 'Pot' : `Side pot ${i}`} {fmt(p.amount)}
                  </div>
                ))
              ) : (
                // One pot: show everything in play, bets in front of the seats included, so it never reads "Pot 0" with chips out.
                <div className="pot">
                  <ChipStacks amount={potPile} base={chipBase} set={chipSet} />
                  {/* The pot counts as fast as a bet is tossed, so it reads right when the chips land. */}
                  Pot <CountUp value={Math.max(hand!.potTotal, hand!.pots[0]?.amount ?? 0)} fmt={fmt} upMs={380} />
                </div>
              )}
            </div>
            {hand!.pots.length > 1 && bets > 0 && <div className="pot total">Total {fmt(hand!.potTotal)}</div>}
          </div>
        )}
        {done &&
          [...results.entries()].map(([seat, w]) => (
            <div className="pot result" key={seat}>
              {view.hand?.names?.[seat] ?? view.seats[seat]?.name ?? 'Player'} wins {fmt(w.amount)}
              {w.handName ? ` · ${w.handName}` : ''}
            </div>
          ))}
        {/* The pot's spot above the board says what happens next between hands. */}
        {!live && view.nextHandAt !== null && view.started && !view.paused && (
          <div className="next-hand">Next hand in {Math.max(0, Math.ceil((view.nextHandAt - now) / 1000))}</div>
        )}
        {view.paused && <div className="next-hand">Paused</div>}
        {!hand && view.upcoming && <div className="next-hand muted">{view.upcoming.gameName}</div>}
        <BoardExtras view={view} />
      </div>

      {view.seats.map((s, seat) => {
        const pos = seatPoint(seat);
        if (!s) {
          return (
            <div className="seat empty" style={px(pos)} key={seat}>
              {onPickSeat ? <button onClick={() => onPickSeat(seat)}>Sit</button> : !onAddBot && <span>{seat + 1}</span>}
              {onAddBot && (
                <button className="add-bot" onClick={() => onAddBot(seat)} title="Add a practice bot to this seat">
                  + Bot
                </button>
              )}
            </div>
          );
        }
        const isMe = seat === view.me.seat;
        const acting = live && hand!.toAct === seat;
        const won = results.get(seat);
        let timeFraction: number | null = null;
        let secondsLeft: number | null = null;
        if (acting && view.turn?.seat === seat && view.turn.deadline) {
          const total = view.turn.deadline - view.turn.startedAt;
          timeFraction = Math.max(0, Math.min(1, (view.turn.deadline - now) / total));
          secondsLeft = Math.max(0, Math.ceil((view.turn.deadline - now) / 1000));
        }
        const badge = seatBadge(s, view.mode === 'tournament');
        const classes = [
          'seat',
          pos.x < w * 0.18 ? 'edge-left' : pos.x > w * 0.82 ? 'edge-right' : '',
          acting && 'acting',
          s.folded && 'folded',
          s.allIn && live && 'all-in',
          (s.sittingOut || !s.online) && 'away',
          won && 'winner',
          isMe && 'me',
          s.cards.length > 0 && (isMe || !s.folded) && 'has-cards',
          // Stud and five-card draw hands are too long to tuck beside the nameplate.
          s.cards.length > 4 && 'long-hand',
          s.departed && 'departed',
          s.departed === 'fading' && 'fading',
          onSeatClick && !s.departed && 'host-click',
        ]
          .filter(Boolean)
          .join(' ');
        const pickable = isMe && !!discard;
        const shown = done && !won && s.inHand && !s.folded ? shownHand(hand!.gameId, s, hand!.boards[0]?.[0] ?? []) : null;
        // Cards come off the dealer button (stud has none, so the middle of the table).
        const toMiddle = fromVars(hand && !stud ? buttonPoint(hand.button) : center, pos);
        const muck = fromVars(lerp(pos, center, 0.5), pos);
        return (
          <div key={seat}>
            <div className={classes} style={px(pos)} data-seat={seat}>
              <div className={`hole n${s.cards.length} ${s.folded && !isMe ? 'mucked' : ''}`} style={muck}>
                {s.cards.map((c, i) => {
                  const face = c.card !== '??';
                  // Cards turned over at showdown flip; everything else is dealt in from the middle.
                  const flip = face && !isMe && !c.up;
                  return (
                    <PlayingCard
                      key={`${hand?.handNumber}-${i}-${isMe ? c.card : face ? 'f' : 'b'}`}
                      card={c.card}
                      small={!(compact && isMe)}
                      className={[
                        flip ? 'flip-in' : 'deal-hole',
                        highlight(c.card, winningHole),
                        stud && !c.up && 'facedown',
                        pickable && discard!.selected.includes(i) && 'discard',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ ...toMiddle, animationDelay: flip ? `${i * 80}ms` : hand?.street === 0 ? `${(i * n + dealOrder(seat)) * 45}ms` : '0ms' }}
                      onClick={pickable ? () => discard!.toggle(i) : undefined}
                      title={pickable ? 'Tap to throw this card away' : undefined}
                    />
                  );
                })}
              </div>
              <div
                className="nameplate"
                onClick={onSeatClick && !s.departed ? () => onSeatClick(s) : undefined}
              >
                {badge && badge.kind !== 'info' && <div className={`pill ${badge.kind}`}>{badge.text}</div>}
                <div className="name" title={s.bot ? `${s.name}, ${botOwnerLabel(s.bot, 'practice bot')}` : undefined}>
                  {s.name}
                  {s.playerId === view.hostId && <span className="tag">host</span>}
                  {/* The bot's own short name comes first, so a long owner name is what gets cut short. */}
                  {s.bot && <span className="bot-owner">· {botPlateLabel(s.bot)}</span>}
                </div>
                <div className="stack">{s.allIn ? 'ALL IN' : <CountUp value={s.stack} fmt={fmt} />}</div>
                {badge?.kind === 'info' && <div className="status">{badge.text}</div>}
                {s.lastAction && live && <div className={`last-action a-${s.lastAction.split(' ')[0].toLowerCase()}`}>{s.lastAction}</div>}
                {shown && <div className="status">{shown}</div>}
                {timeFraction !== null && (
                  <TurnLine
                    key={`${view.turn!.startedAt}:${view.turn!.deadline}:${view.paused}:${skew}`}
                    turn={view.turn as { startedAt: number; deadline: number }}
                    paused={view.paused}
                    serverNow={view.serverNow}
                    skew={skew}
                    bank={!!view.turn?.usingBank}
                    low={secondsLeft! <= 5}
                  />
                )}
                {timeFraction !== null && (secondsLeft! <= 10 || view.turn?.usingBank) && (
                  <div className={`status ${view.turn?.usingBank ? 'bank-text' : 'low-text'}`}>
                    {view.turn?.usingBank ? 'time bank ' : ''}
                    {clock(secondsLeft! * 1000)}
                  </div>
                )}
                <SeatExtras view={view} seat={s} />
              </div>
              {won && <div className="win-float">+{fmt(won.amount)}</div>}
            </div>
            {s.bet > 0 && (
              <div className="bet" style={{ ...px(betPoint(seat)), ...fromVars(pos, betPoint(seat)) }}>
                <ChipStacks amount={s.bet} base={chipBase} set={chipSet} max={2} />
                {fmt(s.bet)}
              </div>
            )}
          </div>
        );
      })}

      {hand && !stud && <div className={`dealer ${hand.buttonDead ? 'dead' : ''}`} style={px(buttonPoint(hand.button))}>D</div>}

      <FeltExtras view={view} seatPoint={seatPoint} railPoint={{ x: w / 2, y: h }} />

      {flights.map((f) => (
        <div key={f.id} className={`chip-flight ${f.kind}`} style={{ ...px(f.to), ...fromVars(f.from, f.to), animationDelay: `${f.delay}ms` }}>
          <span className="chip" />
          <span className="chip" />
          <span className="chip" />
        </div>
      ))}
    </div>
  );
}
