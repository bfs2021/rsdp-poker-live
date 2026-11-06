import { describe, expect, it } from 'vitest';
import { bettingAdvice, gameTitle, getMixedGame, mixedGameMaxPlayers, mixedGameOf, MIXED_GAMES, skipsMixedGameAnte } from '../../src/variants';

const titles = (id: string) => getMixedGame(id)!.steps.map((s) => gameTitle(s.gameId, s.betting));

describe('mixed games', () => {
  it('HORSE is the five Limit games in the usual order, up to 8 players', () => {
    expect(titles('horse')).toEqual(["Limit Hold'em", 'Limit Omaha Hi-Lo (8 or better)', 'Razz', 'Seven Card Stud', 'Stud Hi-Lo (8 or better)']);
    expect(mixedGameMaxPlayers(getMixedGame('horse')!)).toBe(8);
  });

  it('8-Game adds Triple Draw, No-Limit Hold\'em and Pot-Limit Omaha, up to 6 players', () => {
    expect(titles('8-game')).toEqual([
      '2-7 Triple Draw',
      "Limit Hold'em",
      'Limit Omaha Hi-Lo (8 or better)',
      'Razz',
      'Seven Card Stud',
      'Stud Hi-Lo (8 or better)',
      "No-Limit Hold'em",
      'Pot-Limit Omaha',
    ]);
    expect(mixedGameMaxPlayers(getMixedGame('8-game')!)).toBe(6);
  });

  it('every game in a mix is played with usual betting, so the dialog shows no nudge', () => {
    for (const mix of MIXED_GAMES) for (const s of mix.steps) expect(bettingAdvice(s.gameId, s.betting)).toBeNull();
  });

  it('recognises a mix from its steps, whatever their lengths, and nothing else', () => {
    const horse = getMixedGame('horse')!;
    expect(mixedGameOf(horse.steps.map((s) => ({ ...s, length: 3, unit: 'hands' })))?.id).toBe('horse');
    expect(mixedGameOf(horse.steps.slice(1))).toBeNull();
    expect(mixedGameOf(horse.steps.map((s, i) => (i === 0 ? { ...s, betting: 'no-limit' as const } : s)))).toBeNull();
  });

  it('blind games skip the ante only in a rotation with stud', () => {
    expect(skipsMixedGameAnte('nlhe', ['nlhe', 'stud'])).toBe(true);
    expect(skipsMixedGameAnte('td27', ['td27', 'razz'])).toBe(true);
    expect(skipsMixedGameAnte('stud', ['nlhe', 'stud'])).toBe(false);
    expect(skipsMixedGameAnte('nlhe', ['nlhe', 'plo4'])).toBe(false);
  });
});
