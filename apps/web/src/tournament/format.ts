import type { BettingKind } from '@rsdp/engine/core';
import { gameTitle, getVariant, mixedGameOf, VARIANT_LIST } from '@rsdp/engine/variants';

export const chips = (n: number) => n.toLocaleString();

/** Countdown text: 4:05, 1:02:03, or 2d 3h for long waits. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** "Thu, Oct 29, 7:30 PM" in the viewer's own time zone. */
export function localTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Tournaments play each game with its usual betting, so the pickers say which.
export const GAMES: { id: string; name: string }[] = VARIANT_LIST.map((v) => ({ id: v.id, name: gameTitle(v.id) }));

/** The game with its betting, its usual one when left out: "No-Limit Hold'em", "Pot-Limit Omaha". */
export const gameName = (id: string, betting?: BettingKind | null) => gameTitle(id, betting ?? undefined);

/** A tournament's games: the mix's name for HORSE and 8-Game, otherwise each game with its betting. */
export function gamesText(s: { games: string[]; gameBetting?: (BettingKind | null)[] }): string {
  const steps = s.games.map((gameId, i) => ({ gameId, betting: s.gameBetting?.[i] ?? defaultBetting(gameId) }));
  return mixedGameOf(steps)?.name ?? s.games.map((id, i) => gameName(id, s.gameBetting?.[i])).join(' / ');
}

function defaultBetting(id: string): BettingKind {
  try {
    return getVariant(id).defaultBetting;
  } catch {
    return 'no-limit';
  }
}

/** Money in the smallest unit (cents) shown as dollars. */
export const money = (cents: number) =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 });

export function blinds(l: { sb: number; bb: number; ante: number; anteType: string }): string {
  const ante = l.anteType === 'none' || l.ante === 0 ? '' : l.anteType === 'big-blind' ? ` · BB ante ${chips(l.ante)}` : ` · ante ${chips(l.ante)}`;
  return `${chips(l.sb)} / ${chips(l.bb)}${ante}`;
}

/** The clock part of the lobby heading: "10 s to act", or "no clock". */
export const clockText = (r: { decisionSeconds: number }) => (r.decisionSeconds ? `${r.decisionSeconds} s to act` : 'no clock');

/**
 * An event's table rules in a sentence, for everyone in the lobby:
 * "10 seconds to act, a 20-second time bank that refills every 30 hands, no rabbit hunting and no straddles."
 */
export function tableRulesText(r: { decisionSeconds: number; timeBankSeconds: number; timeBankRefillHands: number; rabbitHunt: boolean }): string {
  const clock = r.decisionSeconds ? `${r.decisionSeconds} seconds to act` : 'No turn clock';
  const bank = !r.timeBankSeconds
    ? 'no time bank'
    : `a ${r.timeBankSeconds}-second time bank that ${r.timeBankRefillHands === 0 ? 'never refills' : r.timeBankRefillHands === 1 ? 'refills every hand' : `refills every ${r.timeBankRefillHands} hands`}`;
  // Without a clock there is nothing for a time bank to add to.
  const parts = r.decisionSeconds ? [clock, bank] : [clock];
  return `${parts.join(', ')}, ${r.rabbitHunt ? 'rabbit hunting allowed' : 'no rabbit hunting'} and no straddles.`;
}
