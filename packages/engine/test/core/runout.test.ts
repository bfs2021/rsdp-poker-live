import { describe, expect, it } from 'vitest';
import { engine, RUN_TWICE_STEP_MS, RUNOUT_LAST_STEP_MS, RUNOUT_SETTLE_MS, RUNOUT_STEP_MS, runoutMs, runoutSteps, runoutWaits } from '../../src/core';
import { start } from './harness';

const { act } = engine;
const shape = (s: ReturnType<typeof start>) => runoutSteps(s.events).map((step) => step.map((e) => `${e.run}.${e.board}:${e.cards.length}`));

describe('runout steps', () => {
  it('splits an all-in before the flop into the flop, the turn and the river', () => {
    const s = start({ stacks: [100, 100] });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    expect(shape(s)).toEqual([['0.0:3'], ['0.0:1'], ['0.0:1']]);
    // The river waits longer than the flop and the turn: the build-up (#308).
    expect(runoutWaits(s.events)).toEqual([RUNOUT_STEP_MS, RUNOUT_STEP_MS, RUNOUT_LAST_STEP_MS]);
    expect(RUNOUT_LAST_STEP_MS).toBeGreaterThan(RUNOUT_STEP_MS);
    expect(runoutMs(s.events)).toBe(2 * RUNOUT_STEP_MS + RUNOUT_LAST_STEP_MS + RUNOUT_SETTLE_MS);
  });

  it('gives a flop all-in its build-up before the river too', () => {
    const s = start({ stacks: [100, 100] });
    // Check and call up to the flop, then all in.
    while (s.street < 1) act(s, s.toAct!, engine.legalActions(s, s.toAct!)!.canCheck ? { type: 'check' } : { type: 'call' });
    act(s, s.toAct!, { type: 'raise', to: engine.legalActions(s, s.toAct!)!.maxTo });
    act(s, s.toAct!, { type: 'call' });
    expect(shape(s)).toEqual([['0.0:1'], ['0.0:1']]);
    expect(runoutWaits(s.events)).toEqual([RUNOUT_STEP_MS, RUNOUT_LAST_STEP_MS]);
  });

  it('finishes the first run before the second', () => {
    const s = start({ stacks: [100, 100], options: { runItTwice: 'always' } });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    expect(shape(s)).toEqual([['0.0:3'], ['0.0:1'], ['0.0:1'], ['1.0:3'], ['1.0:1'], ['1.0:1']]);
    // Run it twice is dealt slower.
    expect(runoutWaits(s.events)).toEqual(Array(6).fill(RUN_TWICE_STEP_MS));
    expect(runoutMs(s.events)).toBe(6 * RUN_TWICE_STEP_MS + RUNOUT_SETTLE_MS);
  });

  it('deals every board of a double board together, street by street', () => {
    const s = start({ stacks: [100, 100], options: { boards: 2 } });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    expect(shape(s)).toEqual([
      ['0.0:3', '0.1:3'],
      ['0.0:1', '0.1:1'],
      ['0.0:1', '0.1:1'],
    ]);
  });

  it('is empty when the hand was played out', () => {
    const s = start({ stacks: [100, 100] });
    act(s, 0, { type: 'fold' });
    expect(runoutSteps(s.events)).toEqual([]);
    expect(runoutMs(s.events)).toBe(0);
  });

  it('leaves stud alone: its runout deals to the seats, with a shared card at most', () => {
    const events = [
      { seq: 1, t: 'street', street: 1, name: '4th street' },
      { seq: 2, t: 'deal', seat: 0, cards: [] },
      { seq: 3, t: 'run-it', times: 1 },
      { seq: 4, t: 'board', run: 0, board: 0, cards: ['Ah'] },
    ] as unknown as Parameters<typeof runoutSteps>[0];
    expect(runoutSteps(events)).toEqual([]);
  });
});
