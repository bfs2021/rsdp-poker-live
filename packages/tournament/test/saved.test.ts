import { describe, expect, it } from 'vitest';
import {
  applyStarter,
  curvePercents,
  defaultSettings,
  isRsdpLevels,
  matchingStarter,
  presetStructure,
  rsdpStructure,
  MAX_PAID_PLACES,
  MAX_PAYOUT_RANGES,
  MAX_SAVED_STRUCTURE_LENGTH,
  payoutPreset,
  readSavedStructure,
  savedStructureErrors,
  STARTERS,
  structureToSave,
  validateSettings,
  validatePayoutStructure,
  validateStructure,
  type TournamentSettings,
} from '../src';

const DAY = 24 * 3600_000;
const NOW = Date.parse('2026-10-26T12:00:00Z');

describe('saved structures', () => {
  it('come back exactly as saved when nothing has passed', () => {
    const s = defaultSettings({ name: 'Friday turbo', games: ['nlhe', 'plo'], bounty: { amount: 500, progressivePercent: 50 } });
    const back = readSavedStructure(JSON.stringify(structureToSave(s)), NOW);
    expect(back).toEqual(s);
  });

  it('move a weekly series to its next date, and keep a passed one-off at the same time on a day still to come', () => {
    const weekly: TournamentSettings = defaultSettings({
      start: { kind: 'scheduled', startAt: NOW - 30 * DAY, schedule: { timeZone: 'UTC', startDate: '2026-09-25', time: '19:30', repeat: { freq: 'weekly', weekdays: [5] } } },
    });
    const back = readSavedStructure(JSON.stringify(structureToSave(weekly)), NOW);
    expect(back.start.kind === 'scheduled' && back.start.startAt).toBe(Date.parse('2026-10-30T19:30:00Z'));
    // The form could not work out a start time (it had passed): it is saved as 0 and worked out on load.
    const oneOff = defaultSettings({ start: { kind: 'scheduled', startAt: NaN, schedule: { timeZone: 'UTC', startDate: '2026-10-01', time: '20:00', repeat: null } } });
    const saved = structureToSave(oneOff);
    expect(saved.start.kind === 'scheduled' && saved.start.startAt).toBe(0);
    expect(savedStructureErrors(saved)).toEqual([]);
    const loaded = readSavedStructure(JSON.stringify(saved), NOW);
    expect(loaded.start.kind === 'scheduled' && loaded.start.startAt).toBe(Date.parse('2026-10-26T20:00:00Z'));
  });

  it('fill in settings added since they were saved, and refuse what is not one', () => {
    const { handForHand: _h, graceMinutes: _g, ...old } = defaultSettings({ name: 'Old' });
    const back = readSavedStructure(JSON.stringify(old), NOW);
    expect(back).toMatchObject({ name: 'Old', handForHand: true, graceMinutes: 15 });
    expect(() => readSavedStructure('{nope', NOW)).toThrow(/damaged/);
    expect(() => readSavedStructure('[1]', NOW)).toThrow(/damaged/);
    expect(() => readSavedStructure('"x"'.padEnd(70_000, ' '), NOW)).toThrow(/too big/);
  });
});

describe('settings too big to save', () => {
  it('are refused when the tournament is made, not only when it is saved', () => {
    // A payout table within the caps on ranges and places that still runs past what a saved structure may hold.
    const ranges = [
      { minEntries: 2, maxEntries: MAX_PAID_PLACES, percents: [100] },
      ...Array.from({ length: MAX_PAYOUT_RANGES - 1 }, (_, i) => ({ minEntries: MAX_PAID_PLACES + 1 + i, maxEntries: MAX_PAID_PLACES + 1 + i, percents: curvePercents(MAX_PAID_PLACES, 0) })),
    ];
    ranges[ranges.length - 1].maxEntries = 600;
    const big = defaultSettings({ payouts: { structure: { name: 'custom', ranges }, money: { buyIn: 2000 } } });
    expect(validatePayoutStructure(big.payouts!.structure, big.maxEntrants)).toEqual([]);
    expect(JSON.stringify(structureToSave(big)).length).toBeGreaterThan(MAX_SAVED_STRUCTURE_LENGTH);
    expect(validateSettings(big)).toEqual(['These settings are too big to keep: use fewer payout ranges or blind levels']);
    expect(savedStructureErrors(structureToSave(big))).toEqual(validateSettings(big));
  });

  it('leave room for the biggest preset payout table', () => {
    const s = defaultSettings({ payouts: { structure: payoutPreset('flat', 600), money: { buyIn: 2000 } } });
    expect(validateSettings(s)).toEqual([]);
    expect(() => readSavedStructure(JSON.stringify(structureToSave(s)), NOW)).not.toThrow();
  });
});

describe('starters', () => {
  it('set the stack, levels and late registration and keep the rest', () => {
    const current = defaultSettings({ name: 'Mine', games: ['plo'], maxEntrants: 40, allowQuit: true });
    for (const { id } of STARTERS) {
      const s = applyStarter(current, id);
      expect(validateSettings(s)).toEqual([]);
      expect(s).toMatchObject({ name: 'Mine', games: ['plo'], maxEntrants: 40, allowQuit: true, lateRegistration: { enabled: true } });
    }
    expect(applyStarter(current, 'deep').startingStack).toBe(20_000);
    const first = (id: 'turbo' | 'standard' | 'deep') => applyStarter(current, id).structure[0];
    expect(first('turbo')).toMatchObject({ bb: 200, minutes: 8 });
    expect(first('standard')).toMatchObject({ bb: 100, minutes: 15 });
    expect(first('deep')).toMatchObject({ bb: 100, minutes: 20 });
  });

  it('RSDP is the group\'s PokerNow structure: 63,000 chips, 28 eight-minute levels, no antes or breaks', () => {
    const s = applyStarter(defaultSettings({ name: 'Mine' }), 'rsdp');
    expect(s.startingStack).toBe(63_000);
    expect(s.lateRegistration).toEqual({ enabled: true, throughLevel: 5 });
    expect(s.structure).toHaveLength(28);
    expect(s.structure.every((r) => r.kind === 'level' && r.minutes === 8 && r.anteType === 'none' && r.ante === 0)).toBe(true);
    const blinds = s.structure.map((r) => (r.kind === 'level' ? [r.sb, r.bb] : []));
    expect(blinds.slice(0, 5)).toEqual([[100, 200], [200, 300], [200, 400], [300, 500], [300, 600]]);
    expect(blinds.at(-1)).toEqual([60_000, 120_000]);
    expect(validateStructure(s.structure).warnings).toEqual([]);
    expect(s.tableRules).toEqual({ decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30, rabbitHunt: false });
    // Other starters leave the table rules as they were.
    expect(applyStarter(s, 'turbo').tableRules).toEqual(s.tableRules);
  });

  it('checks table rules', () => {
    const rules = { decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30, rabbitHunt: false };
    expect(validateSettings(defaultSettings({ tableRules: rules }))).toEqual([]);
    expect(validateSettings(defaultSettings({ tableRules: { ...rules, decisionSeconds: 0 } }))).toEqual([]);
    expect(validateSettings(defaultSettings({ tableRules: { ...rules, decisionSeconds: 3 } }))).toEqual(['Decision clock must be 0 (no clock) or 5-600 seconds']);
    expect(validateSettings(defaultSettings({ tableRules: { ...rules, timeBankSeconds: 301, timeBankRefillHands: -1 } }))).toHaveLength(2);
  });

  it('keep rebuys and add-ons on, with levels and a break that offer them', () => {
    const current = defaultSettings({ rebuy: { max: 2, chips: 5000, approval: true, offerSeconds: 15 }, addOn: { max: 1, chips: 5000, approval: false } });
    for (const { id } of STARTERS) {
      const s = applyStarter(current, id);
      expect(validateSettings(s)).toEqual([]);
      expect(s.rebuy).toMatchObject({ max: 2, approval: true, chips: s.startingStack });
      expect(s.structure.filter((r) => r.kind === 'level' && r.rebuy)).toHaveLength(4);
      expect(s.structure.some((r) => r.kind === 'break' && r.addOn)).toBe(true);
    }
    // A Sit & Go for two ends before the first break; the add-on still gets one.
    const tiny = applyStarter({ ...current, maxEntrants: 2, start: { kind: 'sng', playersNeeded: 2, startDelaySeconds: 0, autoSpawn: false } }, 'turbo');
    expect(validateSettings(tiny)).toEqual([]);
  });
});

describe('which starter the form is on', () => {
  const rsdp = applyStarter(defaultSettings({ name: 'Friday', games: ['nlhe', 'plo4', 'plo8'] }), 'rsdp');

  it('is RSDP for a new tournament, mixed games and all', () => {
    expect(matchingStarter(rsdp)).toBe('rsdp');
    expect(matchingStarter({ ...rsdp, games: ['nlhe'], name: 'Other', maxEntrants: 12, start: { kind: 'manual' } })).toBe('rsdp');
  });

  it('is each starter just after it is loaded, on top of any other', () => {
    for (const { id } of STARTERS) {
      for (const { id: from } of STARTERS) expect(matchingStarter(applyStarter(applyStarter(rsdp, from), id))).toBe(id);
    }
  });

  it('stays the same when rebuys or add-ons are ticked on the form afterwards', () => {
    // As the form does it: the first four levels allow rebuys, and an add-on break goes in after level 4.
    let n = 0;
    const rebuys = { ...rsdp, rebuy: { ...rsdp.rebuy, max: 1 }, structure: rsdp.structure.map((r) => (r.kind === 'level' && n++ < 4 ? { ...r, rebuy: true } : r)) };
    expect(matchingStarter(rebuys)).toBe('rsdp');
    const addOns = { ...rsdp, addOn: { ...rsdp.addOn, max: 1 }, structure: [...rsdp.structure.slice(0, 4), { kind: 'break' as const, minutes: 5, addOn: true }, ...rsdp.structure.slice(4)] };
    expect(matchingStarter(addOns)).toBe('rsdp');
  });

  it('is none once the host changes the stack, a level, late registration or the clock', () => {
    expect(matchingStarter({ ...rsdp, startingStack: 50_000 })).toBeNull();
    expect(matchingStarter({ ...rsdp, structure: rsdp.structure.map((r, i) => (i === 3 && r.kind === 'level' ? { ...r, minutes: 10 } : r)) })).toBeNull();
    expect(matchingStarter({ ...rsdp, structure: rsdp.structure.slice(0, 27) })).toBeNull();
    expect(matchingStarter({ ...rsdp, lateRegistration: { enabled: true, throughLevel: 6 } })).toBeNull();
    expect(matchingStarter({ ...rsdp, lateRegistration: { enabled: false, throughLevel: 5 } })).toBeNull();
    expect(matchingStarter({ ...rsdp, tableRules: { ...rsdp.tableRules!, decisionSeconds: 20 } })).toBeNull();
    const { tableRules: _t, ...noRules } = rsdp;
    expect(matchingStarter(noRules)).toBeNull();
  });

  it("does not care in which order a row's fields were set", () => {
    const reordered = rsdp.structure.map((r) => (r.kind === 'level' ? { minutes: r.minutes, anteType: r.anteType, ante: r.ante, bb: r.bb, sb: r.sb, kind: r.kind } : r));
    expect(matchingStarter({ ...rsdp, structure: reordered })).toBe('rsdp');
  });
});

describe('the RSDP blind levels', () => {
  it('are recognised with breaks, rebuy marks or a game on a level added', () => {
    expect(isRsdpLevels(rsdpStructure())).toBe(true);
    const rows = rsdpStructure({ rebuyThroughLevel: 4 });
    rows.splice(4, 0, { kind: 'break', minutes: 5, addOn: true });
    rows[0] = { ...rows[0], kind: 'level', gameId: 'plo4' } as (typeof rows)[0];
    expect(isRsdpLevels(rows)).toBe(true);
  });

  it('are not recognised once a blind, an ante, a length or the number of levels differs', () => {
    const rows = rsdpStructure();
    const change = (i: number, patch: object) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
    expect(isRsdpLevels(change(5, { bb: 900 }))).toBe(false);
    expect(isRsdpLevels(change(5, { sb: 450 }))).toBe(false);
    expect(isRsdpLevels(change(5, { ante: 100, anteType: 'per-player' }))).toBe(false);
    expect(isRsdpLevels(change(27, { minutes: 15 }))).toBe(false);
    expect(isRsdpLevels(rows.slice(1))).toBe(false);
    expect(isRsdpLevels([])).toBe(false);
    expect(isRsdpLevels(presetStructure('regular', { startingStack: 63_000 }))).toBe(false);
  });
});
