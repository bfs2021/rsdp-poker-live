import { describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings, SETTINGS_LIMITS, type BlindLevel, type RotationStep } from '@rsdp/engine/settings';
import { MIXED_GAMES } from '@rsdp/engine/variants';
import { canAddGame, canAddLevel, nextBlindLevel, scheduleBetsNote } from './lists';

/** Presses "Add game" until the dialog stops offering it (or well past the limit, should it never stop). */
function addAllGames(first: RotationStep) {
  const steps = [first];
  while (canAddGame(steps) && steps.length < 2 * SETTINGS_LIMITS.rotationSteps.max) steps.push({ ...steps[steps.length - 1] });
  return steps;
}

/** Presses "Add level" the same way. */
function addAllLevels(first: BlindLevel) {
  const levels = [first];
  while (canAddLevel(levels) && levels.length < 2 * SETTINGS_LIMITS.blindLevels.max) levels.push(nextBlindLevel(levels[levels.length - 1]));
  return levels;
}

describe('the settings dialog list editors', () => {
  it('stop adding games at the most the server accepts, and that rotation saves', () => {
    const s = defaultSettings('cash');
    const steps = addAllGames({ gameId: s.game.gameId, betting: s.game.betting, length: 1, unit: 'orbits' });
    expect(steps).toHaveLength(SETTINGS_LIMITS.rotationSteps.max);
    expect(() => parseSettings({ ...s, game: { ...s.game, rotation: { ...s.game.rotation, enabled: true, steps } } })).not.toThrow();
  });

  it('stop adding levels at the most the server accepts, never pass the chip maximum, and that schedule saves', () => {
    const s = defaultSettings('cash');
    const levels = addAllLevels({ smallBlind: 1, bigBlind: 2, ante: 1, minutes: 20, hands: 30 });
    expect(levels).toHaveLength(SETTINGS_LIMITS.blindLevels.max);
    const max = SETTINGS_LIMITS.chips.max;
    expect(levels[levels.length - 1]).toMatchObject({ smallBlind: max, bigBlind: max, ante: max });
    expect(() => parseSettings({ ...s, stakes: { ...s.stakes, anteType: 'per-player' }, blindSchedule: { ...s.blindSchedule, enabled: true, levels } })).not.toThrow();
  });

  it('doubles the blinds and ante of the last level and keeps its length', () => {
    expect(nextBlindLevel({ smallBlind: 50, bigBlind: 100, ante: 0, minutes: 15, hands: 25 })).toEqual({ smallBlind: 100, bigBlind: 200, ante: 0, minutes: 15, hands: 25 });
  });
});

describe('the blind schedule note', () => {
  it('says the Limit bets and the bring-in rise with the blinds, only where a game has them', () => {
    const game = defaultSettings('cash').game;
    expect(scheduleBetsNote(game)).toBeNull();
    expect(scheduleBetsNote({ ...game, betting: 'fixed-limit' })).toBe('The Limit bets rise with the blinds, keeping their size to the big blind.');
    expect(scheduleBetsNote({ ...game, gameId: 'razz', betting: 'no-limit' })).toBe('The stud bring-in rises with the blinds, keeping their size to the big blind.');
    const horse = { ...game, rotation: { enabled: true, steps: MIXED_GAMES[0].steps.map((st) => ({ ...st, length: 1, unit: 'orbits' as const })) } };
    expect(scheduleBetsNote(horse)).toBe('The Limit bets and the stud bring-in rise with the blinds, keeping their size to the big blind.');
  });
});
