import { MAX_CHIPS, SETTINGS_LIMITS, type BlindLevel, type RotationStep, type TableSettings } from '@rsdp/engine/settings';
import { getVariant } from '@rsdp/engine/variants';

/** Whether "Add game" may add another step: the server takes at most SETTINGS_LIMITS.rotationSteps.max. */
export const canAddGame = (steps: readonly RotationStep[]) => steps.length < SETTINGS_LIMITS.rotationSteps.max;

/** Whether "Add level" may add another level: the server takes at most SETTINGS_LIMITS.blindLevels.max. */
export const canAddLevel = (levels: readonly BlindLevel[]) => levels.length < SETTINGS_LIMITS.blindLevels.max;

/** The level "Add level" adds after `last`: blinds and ante doubled, but never past MAX_CHIPS, which the server refuses. */
export function nextBlindLevel(last: BlindLevel): BlindLevel {
  const double = (v: number) => Math.min(v * 2, MAX_CHIPS);
  return { ...last, smallBlind: double(last.smallBlind), bigBlind: double(last.bigBlind), ante: double(last.ante) };
}

/** For a blind schedule at a table with Limit or stud games: those amounts rise with the blinds too. Null when there are none. */
export function scheduleBetsNote(game: TableSettings['game']): string | null {
  const steps = game.rotation.enabled && game.rotation.steps.length ? game.rotation.steps : [game];
  const limit = steps.some((st) => st.betting === 'fixed-limit');
  const stud = steps.some((st) => getVariant(st.gameId).forcedBets === 'ante-bring-in');
  if (!limit && !stud) return null;
  const what = limit && stud ? 'The Limit bets and the stud bring-in rise' : limit ? 'The Limit bets rise' : 'The stud bring-in rises';
  return `${what} with the blinds, keeping their size to the big blind.`;
}
