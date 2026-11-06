import { describe, expect, it } from 'vitest';
import { studAnteForBigBlindAnte } from '@rsdp/engine/variants';
import {
  apply,
  chipChop,
  createTournament,
  defaultSettings,
  finishPrizes,
  paidPlaces,
  rangeFor,
  standings,
  tick,
  type Command,
  type TournamentState,
  clockAt,
  curvePercents,
  generateStructure,
  icm,
  MAX_PAID_PLACES,
  MAX_PAYOUT_RANGES,
  payoutPreset,
  placePrizes,
  plannedMinutes,
  presetStructure,
  prizePool,
  prizesForPlaces,
  RSDP_PAYOUTS_20,
  validatePayoutStructure,
  validateStructure,
  type LevelRow,
  type StructureRow,
} from '../src';

const lv = (sb: number, bb: number, minutes = 10, extra: Partial<LevelRow> = {}): LevelRow => ({ kind: 'level', sb, bb, ante: 0, anteType: 'none', minutes, ...extra });

describe('structures', () => {
  it('ships valid presets with rising blinds', () => {
    for (const name of ['hyper', 'turbo', 'regular', 'deep'] as const) {
      const rows = presetStructure(name, { startingStack: 10_000, expectedEntrants: 30 });
      expect(validateStructure(rows)).toEqual({ errors: [], warnings: [] });
      const levels = rows.filter((r): r is LevelRow => r.kind === 'level');
      expect(levels[0].bb * (name === 'deep' ? 200 : name === 'regular' ? 100 : name === 'turbo' ? 50 : 25)).toBeCloseTo(10_000, -4);
      levels.slice(1).forEach((l, i) => expect(l.bb).toBeGreaterThan(levels[i].bb));
      expect(levels.every((l) => l.sb * 2 === l.bb)).toBe(true);
      expect(levels.at(-1)!.bb).toBeGreaterThanOrEqual(30_000);
    }
  });

  it('regular preset starts 50/100 with a 10,000 stack and adds antes at level 5', () => {
    const rows = presetStructure('regular', { startingStack: 10_000 });
    expect(rows[0]).toMatchObject({ sb: 50, bb: 100, minutes: 15, anteType: 'none' });
    const l5 = rows.filter((r) => r.kind === 'level')[4] as LevelRow;
    expect(l5.anteType).toBe('per-player');
    expect(l5.ante).toBeGreaterThan(0);
    expect(rows[6]).toMatchObject({ kind: 'break', minutes: 10 });
  });

  it('big-blind antes equal the big blind', () => {
    const rows = presetStructure('turbo', { startingStack: 5000, anteType: 'big-blind' });
    const l = rows.filter((r): r is LevelRow => r.kind === 'level' && r.anteType !== 'none');
    expect(l.every((x) => x.ante === x.bb && x.anteType === 'big-blind')).toBe(true);
  });

  it('in stud a big-blind ante becomes the same ante the per-player presets give', () => {
    for (const startingStack of [1000, 5000, 63_000, 1_000_000]) {
      const each = presetStructure('turbo', { startingStack, anteType: 'per-player' }).filter((r): r is LevelRow => r.kind === 'level' && r.anteType !== 'none');
      const bb = presetStructure('turbo', { startingStack, anteType: 'big-blind' }).filter((r): r is LevelRow => r.kind === 'level' && r.anteType !== 'none');
      expect(bb.map((x) => studAnteForBigBlindAnte(x.ante))).toEqual(each.map((x) => x.ante));
    }
  });

  it('marks rebuy levels and the add-on break', () => {
    const rows = presetStructure('regular', { startingStack: 10_000, rebuyThroughLevel: 6, addOnAtFirstBreak: true });
    expect(rows.filter((r) => r.kind === 'level' && r.rebuy)).toHaveLength(6);
    expect(rows.find((r) => r.kind === 'break')).toMatchObject({ addOn: true });
  });

  it('generates a structure near a target duration', () => {
    for (const target of [60, 180, 300]) {
      const rows = generateStructure({ startingStack: 10_000, expectedEntrants: 20, targetMinutes: target });
      expect(validateStructure(rows).errors).toEqual([]);
      expect(Math.abs(plannedMinutes(rows) - target) / target).toBeLessThan(0.25);
    }
  });

  it('reports errors and warnings', () => {
    const rows: StructureRow[] = [
      { kind: 'break', minutes: 10 },
      lv(60, 50),
      lv(10, 20, 0),
      { kind: 'break', minutes: 5 },
      { kind: 'break', minutes: 5 },
      lv(100, 200, 10, { ante: 300, anteType: 'per-player' }),
      lv(0, 0, 10, { limit: { smallBet: 10, bigBet: 5, bringIn: 20 } }),
    ];
    const { errors, warnings } = validateStructure(rows, { maxRebuys: 1 });
    expect(errors).toEqual(
      expect.arrayContaining([
        'A break cannot be first',
        'Level 1: small blind is larger than the big blind',
        'Level 2: length must be 1-240 minutes',
        'Break after level 2: two breaks in a row',
        'Level 4: big blind must be above 0',
        'Level 4: big bet is smaller than the small bet',
        'Level 4: bring-in is larger than the small bet',
        'Rebuys are on, but no level allows rebuys',
      ]),
    );
    expect(warnings).toEqual(expect.arrayContaining(['Level 3: ante is larger than the big blind', 'Level 2: blinds go down from the previous level']));
  });

  it('clock lookup', () => {
    const rows: StructureRow[] = [lv(1, 2), lv(2, 4), { kind: 'break', minutes: 5 }, lv(5, 10)];
    const min = 60_000;
    expect(clockAt(rows, 0)).toMatchObject({ rowIndex: 0, levelNumber: 1, msLeft: 10 * min, msToBreak: 20 * min, onBreak: false });
    expect(clockAt(rows, 15 * min)).toMatchObject({ rowIndex: 1, levelNumber: 2, msLeft: 5 * min, msToBreak: 5 * min });
    const brk = clockAt(rows, 22 * min);
    expect(brk).toMatchObject({ rowIndex: 2, levelNumber: 2, onBreak: true, msLeft: 3 * min });
    expect(brk.level.bb).toBe(10);
    expect(clockAt(rows, 999 * min)).toMatchObject({ rowIndex: 3, levelNumber: 3, msLeft: null, nextLevel: null });
  });
});

describe('payouts', () => {
  it('presets are valid up to 600 entries', () => {
    for (const name of ['rsdp', 'winner-take-all', 'top-two', 'top-three', 'standard', 'flat'] as const) {
      expect(validatePayoutStructure(payoutPreset(name), 600)).toEqual([]);
    }
  });

  it('standard pays 1 / 2 / 3 / ~15%', () => {
    const s = payoutPreset('standard');
    const paid = (n: number) => placePrizes(10_000, s, n).length;
    expect([paid(4), paid(7), paid(10), paid(20), paid(100), paid(600)]).toEqual([1, 2, 3, 4, 15, 90]);
  });

  it('rsdp pays exactly the sheet amounts at a $20 buy-in', () => {
    for (const max of [2, 5, 9, 50, 600]) {
      const s = payoutPreset('rsdp', max);
      expect(validatePayoutStructure(s, max)).toEqual([]);
      for (let n = 2; n <= Math.min(max, 50); n++) expect(placePrizes(n * 2000, s, n)).toEqual(RSDP_PAYOUTS_20[n].map((d) => d * 100));
    }
    // Above 50 the 50-player split carries on, still in $5 steps.
    const big = placePrizes(80 * 2000, payoutPreset('rsdp', 600), 80);
    expect(big).toHaveLength(10);
    expect(big.reduce((a, b) => a + b, 0)).toBe(160_000);
    expect(big.slice(1).every((x) => x % 500 === 0)).toBe(true);
  });

  it('rounds to the step only when every place still pays and the order holds', () => {
    const s = { name: 'x', roundTo: 500, ranges: [{ minEntries: 2, maxEntries: 10, percents: [70, 30] }] };
    expect(placePrizes(6200, s, 6)).toEqual([4200, 2000]);
    // $1.86 for 2nd would round to nothing, so the plain split is used.
    expect(placePrizes(620, s, 6)).toEqual([434, 186]);
    expect(validatePayoutStructure({ ...s, roundTo: 0 }, 10)).toEqual(['Prize rounding must be a whole amount from 1 cent to $1,000']);
  });

  it('two-place curve is about 65/35', () => {
    expect(curvePercents(2, 0.9)).toEqual([65.11, 34.89]);
  });

  it('rounds each place down and gives the remainder to 1st', () => {
    const s = { name: 'x', ranges: [{ minEntries: 2, maxEntries: 10, percents: [50, 30, 20] }] };
    expect(placePrizes(1001, s, 9)).toEqual([501, 300, 200]);
    // The last range carries on past its end (re-entries can take an event past its max entrants).
    expect(placePrizes(1001, s, 11)).toEqual([501, 300, 200]);
    expect(placePrizes(1001, s, 1)).toEqual([]);
  });

  it('refuses ranges that are not shaped like ranges instead of throwing', () => {
    const bad = (ranges: unknown[]) => validatePayoutStructure({ name: 'bad', ranges } as never, 10);
    expect(bad([null])).toEqual(['Range 1 is not a payout range']);
    expect(bad([{ minEntries: 2, maxEntries: 10, percents: null }])).toEqual(['Range 1 is not a payout range']);
    expect(bad([{ minEntries: 2, maxEntries: 10, percents: [100] }, { minEntries: 11, maxEntries: 20, percents: ['50', '50'] }])).toEqual([
      'Range 2 is not a payout range',
    ]);
  });

  it('caps how many ranges a table has and how many places a range pays', () => {
    // 2-3, 4-5, ... each paying 1st only: as many ranges as asked for.
    const ranges = (n: number) => Array.from({ length: n }, (_, i) => ({ minEntries: 2 + 2 * i, maxEntries: 3 + 2 * i, percents: [100] }));
    expect(validatePayoutStructure({ name: 'x', ranges: ranges(MAX_PAYOUT_RANGES) }, 10)).toEqual([]);
    expect(validatePayoutStructure({ name: 'x', ranges: ranges(MAX_PAYOUT_RANGES + 1) }, 10)).toEqual([`At most ${MAX_PAYOUT_RANGES} ranges`]);
    const paying = (places: number) => ({ name: 'x', ranges: [{ minEntries: 2, maxEntries: 600, percents: [100] }, { minEntries: 601, maxEntries: 1000, percents: curvePercents(places, 0) }] });
    expect(validatePayoutStructure(paying(MAX_PAID_PLACES), 600)).toEqual([]);
    expect(validatePayoutStructure(paying(MAX_PAID_PLACES + 1), 600)).toEqual([`Range 601-1000: pays more than ${MAX_PAID_PLACES} places`]);
    // Every preset stays inside both caps at the most entrants an event can have.
    for (const name of ['rsdp', 'winner-take-all', 'top-two', 'top-three', 'standard', 'flat'] as const) {
      const s = payoutPreset(name, 600);
      expect(s.ranges.length).toBeLessThanOrEqual(MAX_PAYOUT_RANGES);
      expect(Math.max(...s.ranges.map((r) => r.percents.length))).toBeLessThanOrEqual(MAX_PAID_PLACES);
    }
  });

  it('validates ranges', () => {
    const errors = validatePayoutStructure(
      {
        name: 'bad',
        ranges: [
          { minEntries: 2, maxEntries: 5, percents: [60, 30, 20] },
          { minEntries: 7, maxEntries: 9, percents: [40, 50, 10] },
        ],
      },
      20,
    );
    expect(errors).toEqual([
      'Range 2-5: pays more places than 2 entries',
      'Range 2-5: percents add up to 110, not 100',
      'Range 7-9: must start at 6 (no gaps or overlaps)',
      'Range 7-9: a lower place pays more than a higher one',
      'Ranges stop at 9 entries; they must reach 20',
    ]);
  });

  it('prize pool from display-only money', () => {
    expect(prizePool({ buyIn: 2000, rebuy: 2000, addOn: 1000, feePercent: 10, added: 500 }, { entries: 10, rebuys: 3, addOns: 5 })).toBe(
      Math.floor(((20000 + 6000 + 5000) * 90) / 100) + 500,
    );
  });

  it('tied places split the places they cover', () => {
    expect(prizesForPlaces({ a: 1, b: 2, c: 2, d: 4 }, [500, 300, 201, 0])).toEqual({ a: 500, b: 251, c: 250, d: 0 });
  });

  it('ICM: equal stacks split evenly, and totals match', () => {
    expect(icm([100, 100, 100], [50, 30, 20])).toEqual([34, 33, 33]);
    const eq = icm([5000, 3000, 2000], [500, 300, 200]);
    expect(eq.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(eq[0]).toBeGreaterThan(eq[1]);
    expect(eq[0]).toBeLessThan(500);
    // Heads-up ICM is the floor plus a chip-proportional share of the rest.
    expect(icm([3000, 1000], [700, 300])).toEqual([600, 400]);
  });

  it('chip chop gives everyone the lowest prize plus a chip share', () => {
    expect(chipChop([3000, 1000], [700, 300])).toEqual([600, 400]);
    expect(chipChop([1, 1, 2], [500, 300, 200]).reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe('payouts with re-entries', () => {
  const T0 = Date.parse('2026-10-31T00:00:00Z');
  /** One hand at the first table: `winner` takes the stacks of everyone in `bust`. */
  function bustHand(s: TournamentState, winner: string, bust: string[]): TournamentState {
    const t = s.tables[0];
    const seated = t.seats.filter((x): x is string => !!x).map((id) => s.entries.find((e) => e.id === id)!);
    const start = Object.fromEntries(seated.map((e) => [e.playerId, e.stack]));
    const end = { ...start };
    for (const b of bust) {
      end[winner] += end[b];
      end[b] = 0;
    }
    const handNumber = t.lastHandNumber + 1;
    s = apply(s, { type: 'handStarted', tableId: t.id, handNumber }, T0).state;
    const knockedOutBy = Object.fromEntries(bust.map((b) => [b, [winner]]));
    return apply(s, { type: 'handResult', result: { tableId: t.id, handNumber, startStacks: start, endStacks: end, knockedOutBy } }, T0).state;
  }
  const event = (maxEntrants: number, players: number, reEntryMax: number | null) => {
    const settings = defaultSettings({
      name: 'Re-entry',
      maxEntrants,
      startingStack: 1000,
      lateRegistration: { enabled: false, throughLevel: null },
      reEntry: { enabled: true, throughLevel: 1, max: reEntryMax, approval: false },
      // What the create form sends: the preset trimmed to this event's max entrants.
      payouts: { structure: payoutPreset('rsdp', maxEntrants), money: { buyIn: 2000 } },
    });
    let s = createTournament({ id: 'T', hostId: 'host', settings, now: T0, seed: 1 });
    const run = (c: Command) => (s = apply(s, c, T0).state);
    for (let i = 0; i < players; i++) run({ type: 'register', playerId: `p${i}`, displayName: `P${i}` });
    run({ type: 'startNow', by: 'host' });
    return { get: () => s, set: (next: TournamentState) => (s = next), run };
  };

  it('the last range carries on when re-entries take an event past its max entrants', () => {
    expect(rangeFor(payoutPreset('rsdp', 6), 7)).toEqual(rangeFor(payoutPreset('rsdp', 6), 6));
    expect(rangeFor(payoutPreset('rsdp', 6), 1)).toBeNull();
    const e = event(6, 6, 1);
    e.set(bustHand(e.get(), 'p0', ['p1']));
    e.run({ type: 'reEnter', playerId: 'p1' });
    expect(e.get().entries).toHaveLength(7);
    expect(paidPlaces(e.get())).toBe(2);
    e.set(bustHand(e.get(), 'p0', ['p1', 'p2', 'p3', 'p4', 'p5']));
    e.set(tick(e.get(), T0 + 6 * 3600_000).state);
    expect(e.get().status).toBe('finished');
    const st = standings(e.get());
    // 1st, and the five who busted together share 2nd's prize.
    expect(st.find((x) => x.place === 1)!.prize).toBe(7 * 2000 - st.filter((x) => x.place === 2).reduce((a, x) => a + x.prize, 0));
    expect(st.every((x) => x.prize > 0)).toBe(true);
    expect(st.reduce((a, x) => a + x.prize, 0)).toBe(7 * 2000);
  });

  it('prizes for places nobody can finish in go to 1st, so every buy-in is paid out', () => {
    const e = event(100, 3, null);
    for (let k = 0; k < 13; k++) {
      const who = k % 2 ? 'p2' : 'p1';
      e.set(bustHand(e.get(), 'p0', [who]));
      e.run({ type: 'reEnter', playerId: who });
    }
    expect(e.get().entries).toHaveLength(16);
    // RSDP pays 4 places at 16 entries, but only three people are playing: the lobby's list and count say 3.
    expect(paidPlaces(e.get())).toBe(3);
    expect(finishPrizes(e.get())).toEqual([16500, 9500, 6000]);
    e.set(bustHand(e.get(), 'p0', ['p2']));
    e.set(bustHand(e.get(), 'p0', ['p1']));
    e.set(tick(e.get(), T0 + 6 * 3600_000).state);
    expect(e.get().status).toBe('finished');
    const st = standings(e.get());
    // $145 / $95 / $60 / $20 at 16 entries: 4th's $20 goes to 1st.
    expect(st.map((x) => [x.playerId, x.place, x.prize])).toEqual([['p0', 1, 16500], ['p1', 2, 9500], ['p2', 3, 6000]]);
    expect(st.reduce((a, x) => a + x.prize, 0)).toBe(16 * 2000);
  });
});
