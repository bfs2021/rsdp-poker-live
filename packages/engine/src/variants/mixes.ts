import type { BettingKind } from '../core/types';
import { getVariant } from './specs';

/** One game of a mix, with the betting it is played with. */
export interface MixedGameStep {
  gameId: string;
  betting: BettingKind;
}

/** A standard mixed game: a fixed list of games played in turn. */
export interface MixedGame {
  id: 'horse' | '8-game';
  name: string;
  /** One line for pickers: what is in the mix. */
  summary: string;
  steps: readonly MixedGameStep[];
}

const L: BettingKind = 'fixed-limit';

/**
 * The two standard mixes, in their usual order. HORSE is all Limit; 8-Game adds
 * 2-7 Triple Draw, No-Limit Hold'em and Pot-Limit Omaha.
 */
export const MIXED_GAMES: readonly MixedGame[] = [
  {
    id: 'horse',
    name: 'HORSE',
    summary: "Limit Hold'em, Omaha Hi-Lo, Razz, Seven Card Stud and Stud Hi-Lo, in turn.",
    steps: [
      { gameId: 'nlhe', betting: L },
      { gameId: 'plo8', betting: L },
      { gameId: 'razz', betting: L },
      { gameId: 'stud', betting: L },
      { gameId: 'stud8', betting: L },
    ],
  },
  {
    id: '8-game',
    name: '8-Game',
    summary: "2-7 Triple Draw, Limit Hold'em, Omaha Hi-Lo, Razz, Seven Card Stud, Stud Hi-Lo, No-Limit Hold'em and Pot-Limit Omaha, in turn.",
    steps: [
      { gameId: 'td27', betting: L },
      { gameId: 'nlhe', betting: L },
      { gameId: 'plo8', betting: L },
      { gameId: 'razz', betting: L },
      { gameId: 'stud', betting: L },
      { gameId: 'stud8', betting: L },
      { gameId: 'nlhe', betting: 'no-limit' },
      { gameId: 'plo4', betting: 'pot-limit' },
    ],
  },
];

export function getMixedGame(id: string): MixedGame | null {
  return MIXED_GAMES.find((m) => m.id === id) ?? null;
}

/** Most players the whole mix can deal to: its smallest game's limit. */
export function mixedGameMaxPlayers(mix: MixedGame): number {
  return Math.min(...mix.steps.map((s) => getVariant(s.gameId).maxPlayers));
}

/** The mix these steps play, game for game and in order, or null. Step lengths don't matter. */
export function mixedGameOf(steps: readonly MixedGameStep[]): MixedGame | null {
  return (
    MIXED_GAMES.find((m) => m.steps.length === steps.length && m.steps.every((s, i) => s.gameId === steps[i].gameId && s.betting === steps[i].betting)) ?? null
  );
}

/**
 * Whether a hand of `gameId` skips the ante because it is part of a rotation with
 * stud in it. In mixed games only the stud games ante: the ante setting is the stud
 * ante, and hold'em, Omaha and draw hands are played with the blinds alone. A
 * rotation without stud keeps its antes in every game.
 */
export function skipsMixedGameAnte(gameId: string, rotationGameIds: readonly string[]): boolean {
  if (getVariant(gameId).forcedBets !== 'blinds') return false;
  return rotationGameIds.some((id) => getVariant(id).forcedBets === 'ante-bring-in');
}
