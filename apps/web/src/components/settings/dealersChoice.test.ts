import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import { CHOICE_FILLS, DEFAULT_MENU, menuSeats, nextMenuGame, repeatsOf, stakesForMenu } from './dealersChoice';

describe("Dealer's choice settings helpers", () => {
  it('fill the menu in one tap, starting with the 8-Game games', () => {
    expect(DEFAULT_MENU.map((g) => g.gameId)).toEqual(['td27', 'nlhe', 'plo8', 'razz', 'stud', 'stud8', 'nlhe', 'plo4']);
    expect(CHOICE_FILLS.find((f) => f.id === 'all')!.games).toHaveLength(12);
    for (const f of CHOICE_FILLS) expect(repeatsOf(f.games)).toEqual([]);
  });

  it('size the table by the biggest game on the menu', () => {
    expect(menuSeats(DEFAULT_MENU)).toBe(10);
    expect(menuSeats([{ gameId: 'badugi', betting: 'fixed-limit' }, { gameId: 'razz', betting: 'fixed-limit' }])).toBe(8);
  });

  it('find repeats and a game to add', () => {
    const nl = { gameId: 'nlhe', betting: 'no-limit' as const };
    expect(repeatsOf([nl, { ...nl, betting: 'fixed-limit' }, nl])).toEqual([2]);
    expect(nextMenuGame([nl])).toMatchObject({ gameId: 'plo4' });
    expect(nextMenuGame(CHOICE_FILLS.find((f) => f.id === 'all')!.games)).toBeNull();
  });

  it('set up the stakes a menu needs, as for HORSE', () => {
    const stakes = { ...defaultSettings('cash').stakes, centsMode: true, smallBlind: 25, bigBlind: 50, smallBet: 0, bigBet: 0, ante: 50, anteType: 'big-blind' as const };
    const next = stakesForMenu(stakes, DEFAULT_MENU, []);
    expect(next).toMatchObject({ smallBet: 50, bigBet: 100, ante: 10, anteType: 'per-player', bringIn: 15 });
    // Adding more games to a menu that already had stud leaves the host's ante alone.
    expect(stakesForMenu({ ...next, ante: 20 }, [...DEFAULT_MENU, { gameId: 'badugi', betting: 'fixed-limit' }], DEFAULT_MENU).ante).toBe(20);
  });
});
