import { describe, expect, it } from 'vitest';
import { MIXED_GAMES } from '@rsdp/engine/variants';
import { clockText, gamesText, tableRulesText } from './format';

const RSDP = { decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30, rabbitHunt: false };

describe('table rules in words', () => {
  it('says the RSDP rules the way a player would', () => {
    expect(tableRulesText(RSDP)).toBe('10 seconds to act, a 20-second time bank that refills every 30 hands, no rabbit hunting and no straddles.');
    expect(clockText(RSDP)).toBe('10 s to act');
  });

  it('covers the other settings a host can pick', () => {
    expect(tableRulesText({ ...RSDP, timeBankRefillHands: 1, rabbitHunt: true })).toBe(
      '10 seconds to act, a 20-second time bank that refills every hand, rabbit hunting allowed and no straddles.',
    );
    expect(tableRulesText({ ...RSDP, timeBankRefillHands: 0 })).toBe('10 seconds to act, a 20-second time bank that never refills, no rabbit hunting and no straddles.');
    expect(tableRulesText({ ...RSDP, timeBankSeconds: 0 })).toBe('10 seconds to act, no time bank, no rabbit hunting and no straddles.');
    // With no clock there is no time bank to speak of.
    expect(tableRulesText({ ...RSDP, decisionSeconds: 0 })).toBe('No turn clock, no rabbit hunting and no straddles.');
    expect(clockText({ decisionSeconds: 0 })).toBe('no clock');
  });
});

describe('gamesText', () => {
  it('names HORSE and 8-Game, and spells out other mixes with their betting', () => {
    const steps = (id: string) => MIXED_GAMES.find((m) => m.id === id)!.steps;
    expect(gamesText({ games: steps('horse').map((s) => s.gameId), gameBetting: steps('horse').map((s) => s.betting) })).toBe('HORSE');
    expect(gamesText({ games: steps('8-game').map((s) => s.gameId), gameBetting: steps('8-game').map((s) => s.betting) })).toBe('8-Game');
    // The same games at their usual betting aren't HORSE.
    expect(gamesText({ games: steps('horse').map((s) => s.gameId) })).toBe("No-Limit Hold'em / Pot-Limit Omaha Hi-Lo (8 or better) / Razz / Seven Card Stud / Stud Hi-Lo (8 or better)");
    expect(gamesText({ games: ['nlhe', 'stud'], gameBetting: ['fixed-limit', null] })).toBe("Limit Hold'em / Seven Card Stud");
  });
});
