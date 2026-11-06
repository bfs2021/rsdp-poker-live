import { SETTINGS_LIMITS, type ChoiceGame, type DealersChoiceSettings, type TableSettings } from '@rsdp/engine/settings';
import { getVariant, MIXED_GAMES, VARIANT_LIST } from '@rsdp/engine/variants';
import { defaultStudAnte, studBringIn } from '../../format';

/** Dealer's choice settings, filled in for tables saved before it existed (D31). */
export const choiceOf = (settings: TableSettings): DealersChoiceSettings => settings.game.dealersChoice ?? { enabled: false, games: [], hands: 0, pickSeconds: 20 };

const fromMix = (id: string) => MIXED_GAMES.find((m) => m.id === id)!.steps.map((st) => ({ gameId: st.gameId, betting: st.betting }));

/** One-tap menus. HORSE and 8-Game fill the menu with their games; they aren't a single pick (D31, decision 8). */
export const CHOICE_FILLS: { id: string; name: string; games: ChoiceGame[] }[] = [
  { id: '8-game', name: 'The 8-Game games', games: fromMix('8-game') },
  { id: 'horse', name: 'The HORSE games', games: fromMix('horse') },
  {
    id: 'flop',
    name: "Hold'em and Omaha",
    games: [
      { gameId: 'nlhe', betting: 'no-limit' },
      { gameId: 'nlhe', betting: 'fixed-limit' },
      { gameId: 'plo4', betting: 'pot-limit' },
      { gameId: 'plo8', betting: 'pot-limit' },
    ],
  },
  { id: 'all', name: 'Every game', games: VARIANT_LIST.map((v) => ({ gameId: v.id, betting: v.defaultBetting })) },
];

/** The menu a new Dealer's choice table starts with: the 8-Game games. */
export const DEFAULT_MENU: ChoiceGame[] = CHOICE_FILLS[0].games;

export const isStud = (gameId: string) => getVariant(gameId).forcedBets === 'ante-bring-in';

/** Most players the menu's biggest game seats: the table can have that many seats. */
export const menuSeats = (games: readonly ChoiceGame[]) => (games.length ? Math.max(...games.map((g) => getVariant(g.gameId).maxPlayers)) : SETTINGS_LIMITS.maxSeats.max);

/** The same game and betting twice: the server refuses it. */
export const repeatsOf = (games: readonly ChoiceGame[]) => games.flatMap((g, i) => (games.findIndex((x) => x.gameId === g.gameId && x.betting === g.betting) < i ? [i] : []));

/** A game not on the menu yet, for "Add game": the first in the list, with its usual betting. */
export function nextMenuGame(games: readonly ChoiceGame[]): ChoiceGame | null {
  for (const v of VARIANT_LIST) if (!games.some((g) => g.gameId === v.id && g.betting === v.defaultBetting)) return { gameId: v.id, betting: v.defaultBetting };
  return null;
}

/**
 * The stakes a menu needs, as for HORSE: Limit bets of the big blind and twice it when a Limit game is added and
 * none are set, a small blind for the blind games, and the stud ante and bring-in when the first stud game goes
 * on (in place of any other ante: with stud on the menu, only the stud games ante, D29).
 */
export function stakesForMenu(stakes: TableSettings['stakes'], games: readonly ChoiceGame[], before: readonly ChoiceGame[]): TableSettings['stakes'] {
  const next = { ...stakes };
  if (games.some((g) => g.betting === 'fixed-limit') && next.smallBet < 1) {
    next.smallBet = Math.max(1, next.bigBlind);
    next.bigBet = next.smallBet * 2;
  }
  if (games.some((g) => !isStud(g.gameId)) && next.smallBlind === 0 && next.bigBlind > 1) next.smallBlind = Math.floor(next.bigBlind / 2);
  const stud = games.some((g) => isStud(g.gameId));
  if (stud && !before.some((g) => isStud(g.gameId))) {
    next.ante = defaultStudAnte(next);
    next.anteType = 'per-player';
  }
  if (stud && next.bringIn === 0) next.bringIn = studBringIn(next.smallBet || next.bigBlind, next.centsMode);
  return next;
}
