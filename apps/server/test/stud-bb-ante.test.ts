import { variants, type Stakes } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { describe, expect, it } from 'vitest';

import { fillStakes } from '../src/runtime/table';

registerAllVariants(variants);

const razz = variants.get('razz').spec;
const nlhe = variants.get('nlhe').spec;

const bbAnteStakes = (overrides: Partial<Stakes> = {}): Stakes => ({
  smallBlind: 150,
  bigBlind: 300,
  ante: 300,
  anteType: 'big-blind',
  bringIn: 100,
  smallBet: 300,
  bigBet: 600,
  ...overrides,
});

describe('fillStakes: big-blind ante on a stud game (issue #354)', () => {
  it('converts a big-blind ante to the per-player stud ante, not a full big blind', () => {
    const out = fillStakes(bbAnteStakes(), razz);
    expect(out.anteType).toBe('per-player');
    // The per-player presets give about bb/8: nearestNice(300 / 8 = 37.5) is 40, not 300.
    expect(out.ante).toBe(40);
    expect(out.ante).toBeLessThan(out.bigBlind);
  });

  it('leaves a per-player ante untouched', () => {
    const out = fillStakes(bbAnteStakes({ ante: 40, anteType: 'per-player' }), razz);
    expect(out.anteType).toBe('per-player');
    expect(out.ante).toBe(40);
  });

  it('leaves a big-blind ante untouched on a blind game', () => {
    const out = fillStakes(bbAnteStakes(), nlhe);
    expect(out.anteType).toBe('big-blind');
    expect(out.ante).toBe(300);
  });
});
