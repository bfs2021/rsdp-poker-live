import type { VariantRegistry } from '../core/api';
import type { VariantRules } from '../core/types';
import { awardPortion } from './showdown';
import { VARIANT_LIST } from './specs';
import { bringInSeat, firstToActSeat, studOddChipOrder } from './stud';

export * from './types';
export * from './specs';
export * from './advice';
export * from './mixes';
export * from './antes';
export * from './evaluators';
export { awardPortion } from './showdown';
export { bringInSeat, firstToActSeat, studOddChipOrder } from './stud';
export { drawReplacements, type DrawResult } from './draw';

const FLOP_OR_DRAW: VariantRules = { awardPortion };
const STUD: VariantRules = { awardPortion, bringInSeat, firstToActSeat, oddChipOrder: studOddChipOrder };

/** Registers every game. The engine calls this once at startup. */
export function registerAllVariants(registry: Pick<VariantRegistry, 'register'>) {
  for (const spec of VARIANT_LIST) registry.register(spec, spec.family === 'stud' ? STUD : FLOP_OR_DRAW);
}
