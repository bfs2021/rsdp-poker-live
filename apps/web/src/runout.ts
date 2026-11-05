import { useEffect, useMemo, useState } from 'react';
import { HIDDEN_CARD, RUNOUT_SETTLE_MS, runoutSteps, runoutWaits, type HandEvent } from '@rsdp/engine/core';
import type { SeatView, TableView } from '@rsdp/engine/wire';

interface Reveal {
  handNumber: number;
  steps: number;
  /** The pause before each street (run it twice is slower; the last card of one run waits longest). */
  waits: number[];
  /** The table just before the runout (Frozen) comes from it. */
  before: Frozen;
}

/**
 * What the server changes as soon as the hand is over, kept as it was until
 * the result shows: the log (who won), seats (busted players sit out, leavers
 * go, tournaments knock players out) and the ledger.
 */
export interface Frozen {
  /** The newest log line before the runout. */
  logCut: number;
  seats: TableView['seats'];
  ledger: TableView['ledger'];
  me: TableView['me'];
  nit: TableView['nit'];
}

/**
 * All-in runouts arrive in one update, finished. This holds the table back
 * and deals them out a street at a time (board 1 before board 2), so each card
 * lands with its own sound, then shows the result. The server holds the next
 * hand for as long (runoutMs). Opening the table mid-runout shows it finished.
 */
export function useRunoutReveal(live: TableView | null): TableView | null {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  /** Steps shown so far; the count past the last is the settle beat. */
  const [shown, setShown] = useState(0);
  // Checked while rendering (not in an effect), so the finished board never flashes up first.
  const [before, setBefore] = useState(live);
  if (live !== before) {
    setBefore(live);
    const hand = live?.hand;
    if (reveal && reveal.handNumber !== hand?.handNumber) setReveal(null);
    const ranIt = (h: TableView['hand']) => !!h?.events.some((e) => e.t === 'run-it');
    const steps = hand ? runoutSteps(hand.events).length : 0;
    // A hand can also be dealt and run out in one go (a bomb pot with someone all in from the start).
    // The first view after opening the table has nothing to compare with, so it shows the runout finished.
    // Only straight after the hand before, so coming back from a dropped connection doesn't replay an old runout.
    const prior = before?.hand;
    const fresh = !!hand && !!prior && (prior.handNumber === hand.handNumber ? !ranIt(prior) : prior.handNumber === hand.handNumber - 1);
    if (hand && before && steps && fresh) {
      setReveal({
        handNumber: hand.handNumber,
        steps,
        waits: runoutWaits(hand.events),
        before: { logCut: before.log.at(-1)?.at ?? 0, seats: before.seats, ledger: before.ledger, me: before.me, nit: before.nit },
      });
      setShown(0);
    }
  }

  useEffect(() => {
    if (!reveal) return;
    if (shown > reveal.steps) return setReveal(null);
    const wait = shown === reveal.steps ? RUNOUT_SETTLE_MS : reveal.waits[shown];
    const t = setTimeout(() => setShown((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [reveal, shown]);

  return useMemo(() => (live && reveal && live.hand?.handNumber === reveal.handNumber ? holdBack(live, reveal.before, shown) : live), [live, reveal, shown]);
}

/** The table as it was with only the first `shown` runout steps dealt. */
export function holdBack(view: TableView, before: Frozen, shown: number): TableView {
  const hand = view.hand!;
  const steps = runoutSteps(hand.events);
  const hidden = new Set(steps.slice(shown).flat().map((e) => e.seq));
  const runsStarted = new Set(steps.slice(0, shown).flat().map((e) => e.run));
  const boards = hand.boards.map((run, r) =>
    run.map((cards, b) => {
      // A second run stays off the felt until its first card, so it reads as a new board.
      if (r > 0 && !runsStarted.has(r)) return [];
      const owed = steps
        .slice(shown)
        .flat()
        .filter((e) => e.run === r && e.board === b)
        .reduce((n, e) => n + e.cards.length, 0);
      return cards.slice(0, cards.length - owed);
    }),
  );
  const runItEvent = hand.events.find((e) => e.t === 'run-it')!;
  const runIt = runItEvent.seq;
  // A single run waits longest before its last card: that card waits face down on its board (#308).
  const lastWait = runItEvent.t === 'run-it' && runItEvent.times === 1 && shown === steps.length - 1;
  const comingNext = lastWait ? steps[shown].map((e) => ({ run: e.run, board: e.board })) : undefined;
  const events = hand.events.filter((e) => e.seq <= runIt || (e.t === 'board' && !hidden.has(e.seq)));
  const won = hand.awards.reduce((s, a) => s + a.amount, 0);
  const pots = hand.pots.length ? hand.pots : [{ amount: won, eligible: [] }];
  return {
    ...view,
    hand: { ...hand, phase: 'betting', showdown: false, awards: [], boards, events, pots, potTotal: Math.max(hand.potTotal, won), ...(comingNext ? { comingNext } : {}) },
    seats: seatsDuring(view, before),
    ledger: before.ledger,
    // Knocked out or leaving: you stay in your seat, with the table turned your way, until the result.
    me: view.me.seat === null && before.me.playerId === view.me.playerId ? before.me : view.me,
    nit: before.nit,
    log: view.log.filter((l) => l.at <= before.logCut),
    history: view.history.filter((h) => h.handNumber !== hand.handNumber),
    canShow: [],
    nextHandAt: null,
    rabbit: { available: false, cards: null },
  };
}

/** Seats as they stand with everything in the middle and nothing paid out yet. */
function seatsDuring(view: TableView, before: Frozen): TableView['seats'] {
  const events = view.hand!.events;
  const dealt = events.find((e) => e.t === 'hand-start')?.seats ?? [];
  const paid = new Map<number, number>();
  const pay = (seat: number, n: number) => paid.set(seat, (paid.get(seat) ?? 0) + n);
  for (const e of events) {
    if (e.t === 'post' || e.t === 'action') pay(e.seat, e.amount);
    else if (e.t === 'uncalled') pay(e.seat, -e.amount);
  }
  return view.seats.map((live, i) => {
    const was = before.seats[i] ?? null;
    const start = dealt.find((d) => d.seat === i);
    // Someone dealt in who has since gone (left after the hand, knocked out) is still at the table until the result.
    const gone = !!start && live?.playerId !== start.playerId && was?.playerId === start.playerId;
    const s = gone ? { ...was!, cards: withShown(was!.cards, events, i) } : live;
    if (!s) return s;
    const stack = start?.playerId === s.playerId ? start.stack - (paid.get(i) ?? 0) : s.stack - s.won;
    // Sitting out for being busted, leaving, coming off the nit and the like are the result too.
    // Players not in the hand change as they like.
    const prior = start?.playerId === s.playerId && was?.playerId === s.playerId ? was : s;
    return {
      ...s,
      stack,
      won: 0,
      handName: null,
      allIn: s.inHand && !s.folded && stack === 0,
      sittingOut: prior.sittingOut,
      sitOutReason: prior.sitOutReason,
      leaving: prior.leaving,
      waiting: prior.waiting,
      nit: prior.nit,
    };
  });
}

/**
 * A seat's cards with those its player showed in the hand turned up. The table before the hand ended had them face
 * down; a player who has gone since (knocked out, left) has no seat in the finished table to show them (#308).
 */
export function withShown(cards: SeatView['cards'], events: readonly HandEvent[], seat: number): SeatView['cards'] {
  const shown = events.flatMap((e) => (e.t === 'show' && e.seat === seat ? e.cards : []));
  return cards.map((c) => (c.card === HIDDEN_CARD && !c.up && shown.length ? { ...c, card: shown.shift()! } : c));
}

/** Who went out in the hand being shown, kept in their seats until the next deal. */
interface Departures {
  handNumber: number;
  seats: Map<number, SeatView>;
  fading: boolean;
}

/** How long before the next deal a departed player's seat fades out. */
export const DEPART_FADE_MS = 1000;

/**
 * A player who busts out of a tournament is gone from the server's table the moment the hand ends.
 * Taking them away just as the result shows felt abrupt (#308), so the table keeps them in their seat, cards up,
 * marked as out, through the result, and fades them just before the next deal. Display only: the seat is free
 * on the server, and anyone who sits in it takes it at once.
 */
export function useDepartures(view: TableView | null): TableView | null {
  const [kept, setKept] = useState<Departures | null>(null);
  const [before, setBefore] = useState(view);
  if (view !== before) {
    setBefore(view);
    const next = departures(before, view, kept);
    if (next !== kept) setKept(next);
  }

  // Fade out a little before the next deal (or after a while if no deal is coming).
  const nextAt = view?.nextHandAt ?? null;
  const serverNow = view?.serverNow ?? 0;
  useEffect(() => {
    if (!kept || kept.fading || kept.seats.size === 0) return;
    const wait = nextAt === null ? 8000 : Math.max(1500, nextAt - serverNow - DEPART_FADE_MS);
    const t = setTimeout(() => setKept((k) => (k && k.handNumber === kept.handNumber ? { ...k, fading: true } : k)), wait);
    return () => clearTimeout(t);
  }, [kept, nextAt, serverNow]);

  return useMemo(() => {
    if (!view || !kept || view.hand?.handNumber !== kept.handNumber) return view;
    let changed = false;
    const seats = view.seats.map((s, i) => {
      const gone = kept.seats.get(i);
      if (s || !gone) return s;
      changed = true;
      return kept.fading ? { ...gone, departed: 'fading' as const } : gone;
    });
    return changed ? { ...view, seats } : view;
  }, [view, kept]);
}

/** Who to keep at the table after `view` arrives, `before` being the table as last shown. */
export function departures(before: TableView | null, view: TableView | null, kept: Departures | null): Departures | null {
  const hand = view?.hand;
  if (!hand || view!.mode !== 'tournament') return null;
  let out = kept && kept.handNumber === hand.handNumber ? kept : null;
  const prior = before?.hand;
  if (hand.phase !== 'complete' || !prior || prior.handNumber !== hand.handNumber) return out;
  const dealt = hand.events.find((e) => e.t === 'hand-start')?.seats ?? [];
  const end = [...hand.events].reverse().find((e) => e.t === 'hand-end');
  for (const d of dealt) {
    const was = before!.seats[d.seat];
    if (view!.seats[d.seat] || !was || was.playerId !== d.playerId || out?.seats.has(d.seat)) continue;
    // Only a bust: a player moved to another table, or who quit, just goes.
    const stack = end && end.t === 'hand-end' ? end.stacks[d.seat] : undefined;
    if (stack !== 0 || was.folded) continue;
    const gone: SeatView = {
      ...was,
      cards: withShown(was.cards, hand.events, d.seat),
      stack: 0,
      bet: 0,
      won: 0,
      allIn: false,
      lastAction: null,
      handName: null,
      leaving: false,
      departed: 'out',
    };
    out = { handNumber: hand.handNumber, seats: new Map(out?.seats ?? []).set(d.seat, gone), fading: out?.fading ?? false };
  }
  return out;
}
