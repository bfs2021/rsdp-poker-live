import type { HandEvent } from './types';

/**
 * All-in runouts: the engine deals the rest of the board at once, and tables
 * show it a street at a time (the turn, a pause, the river; the first run
 * before the second). The server holds the next hand for as long as that takes.
 */
export const RUNOUT_STEP_MS = 2000;
/**
 * The last card of a single run waits longer than the streets before it, so
 * the table has a moment of build-up before the river (issue #308).
 */
export const RUNOUT_LAST_STEP_MS = 3000;
/**
 * Run it twice deals slower, about as PokerNow does (some 4 s a street), so
 * each card of both runs has its moment: a turn all-in is otherwise two
 * quick rivers.
 */
export const RUN_TWICE_STEP_MS = 3500;
/** A beat after the last card before the result shows, long enough to read the board first. */
export const RUNOUT_SETTLE_MS = 1200;

type BoardEvent = Extract<HandEvent, { t: 'board' }>;

/**
 * The board cards dealt after the hand went all in, one group per street
 * shown together: every board of a run gets its turn at once, and a second
 * run starts after the first has finished. Empty when there was no runout.
 */
export function runoutSteps(events: readonly HandEvent[]): BoardEvent[][] {
  const start = events.findIndex((e) => e.t === 'run-it');
  if (start < 0) return [];
  const steps: BoardEvent[][] = [];
  let last: BoardEvent | null = null;
  const after = events.slice(start + 1);
  // Stud deals each street to the seats (hold'em and Omaha deal to seats only before the first street),
  // and its runouts aren't paced, even when a short deck makes the last card a shared one.
  const firstStreet = events.findIndex((e) => e.t === 'street');
  if (firstStreet >= 0 && events.slice(firstStreet).some((e) => e.t === 'deal')) return [];
  for (const e of after) {
    if (e.t !== 'board') continue;
    // The engine deals run by run, street by street, board by board: a new street starts
    // when the run changes or the board index goes back to the first.
    if (!last || e.run !== last.run || e.board <= last.board) steps.push([]);
    steps[steps.length - 1].push(e);
    last = e;
  }
  return steps;
}

/**
 * The pause before each step of this hand's runout (one per runoutSteps entry).
 * Run it twice deals every street at its slower pace; a single run waits
 * longer before its last card.
 */
export function runoutWaits(events: readonly HandEvent[]): number[] {
  const n = runoutSteps(events).length;
  if (events.some((e) => e.t === 'run-it' && e.times === 2)) return Array(n).fill(RUN_TWICE_STEP_MS);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? RUNOUT_LAST_STEP_MS : RUNOUT_STEP_MS));
}

/** How long a table takes to show this hand's runout, or 0 with none. */
export function runoutMs(events: readonly HandEvent[]): number {
  const waits = runoutWaits(events);
  return waits.length ? waits.reduce((a, b) => a + b, 0) + RUNOUT_SETTLE_MS : 0;
}
