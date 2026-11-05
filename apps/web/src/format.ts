import type { BettingKind, HandEvent, PostKind, Stakes } from '@rsdp/engine/core';
import { gameCode, getVariant } from '@rsdp/engine/variants';

export type Fmt = (chips: number) => string;

/** Chip amounts as shown at this table: whole chips, or dollars and cents. */
export function chipFormat(centsMode: boolean): Fmt {
  if (!centsMode) return (n) => n.toLocaleString();
  return (n) => (n / 100).toLocaleString(undefined, { minimumFractionDigits: n % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

/** Amounts in big blinds ("12.5 BB"), for players who think in blinds. */
export function bbFormat(bigBlind: number): Fmt {
  return (n) => {
    const bb = n / bigBlind;
    // Under one big blind, keep enough digits that an ante never shows as 0.
    const digits = n % bigBlind === 0 ? 0 : bb < 1 ? Math.min(3, Math.max(1, Math.ceil(-Math.log10(bb)) + 1)) : 1;
    return `${bb.toLocaleString(undefined, { maximumFractionDigits: digits })} BB`;
  };
}

/** A stud bring-in of about a third of the small bet; in dollars, to the nearest nickel (0.15 at .50/1) rather than 0.16. */
export function studBringIn(smallBet: number, centsMode: boolean): number {
  const third = smallBet / 3;
  return centsMode && third >= 5 ? Math.round(third / 5) * 5 : Math.max(1, Math.floor(third));
}

/** Chips to the number typed in an input, and back (cents mode types dollars). */
export const toInput = (centsMode: boolean, chips: number) => (centsMode ? chips / 100 : chips);
export const fromInput = (centsMode: boolean, value: number) => Math.round(centsMode ? value * 100 : value);

/**
 * What the bet box works in: chips (dollars in cents mode), or big blinds.
 * A typed amount in big blinds becomes the nearest whole chip, so a bet is
 * always a real amount the table can take; the caller clamps it to the legal range.
 */
export type BetUnit = { bb: number } | { centsMode: boolean };
export function betToInput(unit: BetUnit, chips: number): number {
  if (!('bb' in unit)) return toInput(unit.centsMode, chips);
  // Two places when that names the exact chip amount, more when the big blind is big (2,999 at 1,000 is 2.999, not 3).
  for (let places = 2; places < 6; places++) {
    const k = 10 ** places;
    const v = Math.round((chips / unit.bb) * k) / k;
    if (Math.round(v * unit.bb) === chips) return v;
  }
  return chips / unit.bb;
}
/** Chips as big blinds for the action buttons, exact to the chip like the bet box ("Raise to 2.83 BB"). */
export const bbExactFormat =
  (bigBlind: number): Fmt =>
  (n) =>
    `${betToInput({ bb: bigBlind }, n).toLocaleString(undefined, { maximumFractionDigits: 6 })} BB`;
export function betFromInput(unit: BetUnit, value: number): number {
  if (Number.isNaN(value)) return 0;
  // Something huge means as much as allowed; the caller clamps it to the most it can be.
  if (!Number.isFinite(value)) return value > 0 ? Number.MAX_SAFE_INTEGER : 0;
  if ('bb' in unit) return Math.round(value * unit.bb);
  return fromInput(unit.centsMode, value);
}

/**
 * Whether text typed, pasted or dropped into the bet box may go in: digits only,
 * plus a decimal point (or comma) when the box takes fractions (dollars and cents, or big blinds).
 * Browsers let letters, "e", "+" and "-" into a number box; this keeps them out.
 */
export function betBoxAccepts(text: string, decimals: boolean): boolean {
  // A comma too: phones set to a comma-decimal region show only "," on the decimal keypad.
  return decimals ? /^[0-9.,]*$/.test(text) : /^[0-9]*$/.test(text);
}

export const BETTING_NAME: Record<BettingKind, string> = { 'no-limit': 'No Limit', 'pot-limit': 'Pot Limit', 'fixed-limit': 'Limit' };

/** Short label for the felt and top bar: NLH, PLO8, Stud, NL Badugi. */
export const gameLabel = (gameId: string, betting: BettingKind): string => gameCode(gameId, betting);

/** "1/2", "1/2 ante 1", or "ante 1 · bring-in 2 · 4/8" for stud. */
export function stakesLabel(stakes: Stakes, family: string, betting: BettingKind, fmt: Fmt): string {
  const ante = stakes.anteType === 'none' || !stakes.ante ? '' : `${stakes.anteType === 'big-blind' ? 'BB ante' : 'ante'} ${fmt(stakes.ante)}`;
  if (family === 'stud') {
    const sizes = betting === 'fixed-limit' ? `${fmt(stakes.smallBet)}/${fmt(stakes.bigBet)}` : '';
    return [sizes, ante, `bring-in ${fmt(stakes.bringIn)}`].filter(Boolean).join(' · ');
  }
  const blinds = `${fmt(stakes.smallBlind)}/${fmt(stakes.bigBlind)}`;
  const limit = betting === 'fixed-limit' ? ` (${fmt(stakes.smallBet)}/${fmt(stakes.bigBet)})` : '';
  return [blinds + limit, ante].filter(Boolean).join(' · ');
}

const POST_TEXT: Record<PostKind, string> = {
  ante: 'an ante of',
  'big-blind-ante': 'the big blind ante of',
  'small-blind': 'the small blind of',
  'big-blind': 'the big blind of',
  'dead-small-blind': 'a dead small blind of',
  'missed-big-blind': 'a missed big blind of',
  straddle: 'a straddle of',
  'bomb-pot': 'a bomb pot ante of',
  'bring-in': 'the bring-in of',
};

/** Cards in log text are written [Ah]; the log renders them as little cards. */
const cardsText = (cards: string[]) => cards.map((c) => `[${c}]`).join(' ');

/**
 * Turns hand events into log lines, naming board cards Flop, Turn and River
 * by how many are out. Hidden cards are left out. My deal (`mySeat`) reads
 * "You are dealt"; a shared link's sharer's (`sharerSeat`) gives their name.
 */
export function eventLines(events: HandEvent[], name: (seat: number) => string, fmt: Fmt, mySeat: number | null = null, sharerSeat: number | null = null): string[] {
  const lines: string[] = [];
  let gameFamily = '';
  let split = false;
  let runs = 1;
  // Cards on each run's boards so far, to name flop, turn and river.
  const boardCount = new Map<string, number>();
  for (const e of events) {
    switch (e.t) {
      case 'hand-start': {
        let family = 'flop';
        try {
          const spec = getVariant(e.gameId);
          family = spec.family;
          split = spec.split === 'hi-lo';
        } catch {
          /* unknown game */
        }
        gameFamily = family;
        boardCount.clear();
        lines.push(`--- Hand #${e.handNumber} · ${gameLabel(e.gameId, e.betting)} ${stakesLabel(e.stakes, family, e.betting, fmt)}${e.bombPot ? ' · bomb pot' : ''}`);
        break;
      }
      case 'post':
        lines.push(`${name(e.seat)} posts ${POST_TEXT[e.kind]} ${fmt(e.amount)}${e.allIn ? ' and is all in' : ''}`);
        break;
      case 'deal': {
        const seen = e.cards.filter((c) => c.card !== '??');
        if (!seen.length) break;
        if (e.seat === mySeat) lines.push(`You are dealt ${cardsText(e.cards.map((c) => c.card).filter((c) => c !== '??'))}`);
        // A shared link's sharer, as someone else watching it sees them.
        else if (e.seat === sharerSeat) lines.push(`${name(e.seat)} is dealt ${cardsText(seen.map((c) => c.card))}`);
        else if (gameFamily === 'stud') lines.push(`${name(e.seat)} gets ${cardsText(seen.map((c) => c.card))}`);
        break;
      }
      case 'street':
        if (gameFamily !== 'flop' && e.street > 0) lines.push(`— ${e.name} —`);
        break;
      case 'board': {
        const key = `${e.run}:${e.board}`;
        const before = boardCount.get(key) ?? 0;
        const total = before + e.cards.length;
        boardCount.set(key, total);
        // A whole board at once (a second run, or a bomb pot runout) is just "Board".
        const label = before === 0 && total === 3 ? 'Flop' : e.cards.length === 1 && total === 4 ? 'Turn' : e.cards.length === 1 && total === 5 ? 'River' : 'Board';
        const where = (runs > 1 ? ` (run ${e.run + 1})` : '') + (e.board > 0 ? ` (board ${e.board + 1})` : '');
        lines.push(`${label}${where}: ${cardsText(e.cards)}`);
        break;
      }
      case 'action': {
        const who = name(e.seat);
        const tail = (e.allIn ? ' and is all in' : '') + (e.auto ? ' (auto)' : '');
        const text =
          e.action === 'fold'
            ? 'folds'
            : e.action === 'check'
              ? 'checks'
              : e.action === 'call'
                ? `calls ${fmt(e.amount)}`
                : e.action === 'bet'
                  ? `bets ${fmt(e.to)}`
                  : e.action === 'raise'
                    ? `raises to ${fmt(e.to)}`
                    : e.action === 'bring-in'
                      ? `brings in for ${fmt(e.to)}`
                      : `completes to ${fmt(e.to)}`;
        lines.push(`${who} ${text}${tail}`);
        break;
      }
      case 'draw': {
        const drawn = e.cards.filter((c) => c !== '??');
        if (e.discarded === 0) lines.push(`${name(e.seat)} stands pat${e.auto ? ' (auto)' : ''}`);
        else lines.push(`${name(e.seat)} draws ${e.discarded}${drawn.length ? `: ${cardsText(drawn)}` : ''}`);
        break;
      }
      case 'uncalled':
        lines.push(`Uncalled ${fmt(e.amount)} returned to ${name(e.seat)}`);
        break;
      case 'rit-offer':
        lines.push('All in. Run it twice?');
        break;
      case 'rit-vote':
        lines.push(`${name(e.seat)} says ${e.yes ? 'yes' : 'no'} to running it twice`);
        break;
      case 'run-it':
        runs = e.times;
        lines.push(e.times === 2 ? 'Running it twice' : 'Running it once');
        break;
      case 'show':
        lines.push(`${name(e.seat)} shows ${cardsText(e.cards)}${e.handName ? ` (${e.handName})` : ''}`);
        break;
      case 'muck':
        lines.push(`${name(e.seat)} mucks`);
        break;
      case 'award': {
        const parts = [e.pot > 0 ? `side pot ${e.pot}` : '', runs > 1 ? `run ${e.run + 1}` : '', e.board > 0 ? `board ${e.board + 1}` : '', split && e.half !== 'scoop' ? e.half : '']
          .filter(Boolean)
          .join(', ');
        lines.push(`${name(e.seat)} wins ${fmt(e.amount)}${parts ? ` (${parts})` : ''}${e.handName ? ` with ${e.handName}` : ''}`);
        break;
      }
      case 'transfer': {
        const who = (s: number | 'house') => (s === 'house' ? 'the house' : name(s));
        const why = e.kind === 'bounty-72' ? '7-2 bounty' : e.kind === 'rake' ? 'rake' : 'nit game';
        lines.push(`${who(e.from)} pays ${who(e.to)} ${fmt(e.amount)} (${why})`);
        break;
      }
      case 'hand-end':
        break;
    }
  }
  return lines;
}

/** Countdown text: 0:45, 4:05, 1:02:03. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
}

/**
 * The smallest bet step at this table: the small blind (half the big blind, or half the small bet, where there is no
 * small blind). Bets made with the slider and the pot buttons are multiples of it, so a .25/.50 game bets in quarters,
 * never 18.61.
 */
export function betUnit(stakes: Pick<Stakes, 'smallBlind' | 'bigBlind' | 'smallBet'>): number {
  const base = stakes.smallBlind || Math.floor(stakes.bigBlind / 2) || Math.floor(stakes.smallBet / 2);
  return Math.max(1, base);
}

/** Round step sizes: 1, 2, 2.5, 5 and 10 times the powers of ten (a quarter, a dollar, $5 ... in cents). */
function roundSteps(upTo: number): number[] {
  const out: number[] = [];
  for (let p = 1; p <= upTo * 10; p *= 10) for (const m of [1, 2, 2.5, 5]) if (Number.isInteger(p * m)) out.push(p * m);
  return out;
}

/** About this many stops at most, so a finger or mouse moving a few pixels doesn't jump the amount. */
export const SLIDER_STOPS = 60;

/**
 * Where the bet slider can stop, from the least you may bet to the most: the minimum, then round amounts a whole
 * number of steps apart, then the maximum. The step is the table's bet unit, or a round multiple of it once the
 * range is wide (a $50 stack at .25/.50 moves a dollar at a time), so there are never more than about SLIDER_STOPS.
 */
export function betStops(minTo: number, maxTo: number, unit: number): number[] {
  if (maxTo <= minTo) return [minTo];
  const range = maxTo - minTo;
  // A round amount that is a whole number of units if there is one (a quarter, a dollar), else a round number of units.
  const fits = (s: number) => s >= unit && range / s <= SLIDER_STOPS;
  const step =
    roundSteps(range).find((s) => s % unit === 0 && fits(s)) ??
    roundSteps(range / unit)
      .map((k) => k * unit)
      .find((s) => Number.isInteger(s) && fits(s)) ??
    unit;
  const stops = [minTo];
  for (let x = (Math.floor(minTo / step) + 1) * step; x < maxTo; x += step) stops.push(x);
  stops.push(maxTo);
  return stops;
}

/** The stop nearest an amount (an amount typed in the box may sit between two). */
export function nearestStop(stops: number[], amount: number): number {
  let best = 0;
  for (let i = 1; i < stops.length; i++) if (Math.abs(stops[i] - amount) < Math.abs(stops[best] - amount)) best = i;
  return best;
}

/** An amount rounded to the nearest whole bet unit (for the pot buttons). */
export const roundToUnit = (amount: number, unit: number) => Math.round(amount / unit) * unit;
