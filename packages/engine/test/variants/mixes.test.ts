import { describe, expect, it } from 'vitest';
import { anteForGame, bettingAdvice, gameTitle, getMixedGame, mixedGameMaxPlayers, mixedGameOf, MIXED_GAMES, skipsMixedGameAnte, studAnteForBigBlindAnte } from '../../src/variants';

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

  it('a big-blind ante becomes an ante of about an eighth for each stud player, on a nice amount', () => {
    const amounts = [1, 2, 8, 50, 300, 400, 1000, 25000];
    expect(amounts.map(studAnteForBigBlindAnte)).toEqual([1, 1, 1, 6, 40, 50, 100, 3000]);
    for (const a of [...amounts, 3, 7, 15, 99, 150, 2500, 1_000_000_000_000]) {
      const each = studAnteForBigBlindAnte(a);
      expect(Number.isInteger(each), `${a}`).toBe(true);
      expect(each, `${a}`).toBeGreaterThanOrEqual(1);
      expect(each, `${a}`).toBeLessThanOrEqual(a);
    }
    expect(studAnteForBigBlindAnte(0)).toBe(0);
  });

  it("only the stud games turn a big-blind ante into everyone's ante", () => {
    for (const id of ['stud', 'razz', 'stud8']) expect(anteForGame(id, 300, 'big-blind')).toEqual({ ante: 40, anteType: 'per-player' });
    for (const id of ['nlhe', 'plo4', 'plo8', 'td27', 'badugi', 'not-a-game']) expect(anteForGame(id, 300, 'big-blind')).toEqual({ ante: 300, anteType: 'big-blind' });
    expect(anteForGame('razz', 25, 'per-player')).toEqual({ ante: 25, anteType: 'per-player' });
    expect(anteForGame('razz', 0, 'none')).toEqual({ ante: 0, anteType: 'none' });
  });
});
