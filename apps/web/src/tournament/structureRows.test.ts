import { describe, expect, it } from 'vitest';
import { MAX_CHIPS, MAX_LEVELS, rsdpStructure, validateStructure, type LevelRow, type StructureRow } from '@rsdp/tournament';
import { canAddStructureLevel, keepRebuysAndAddOns, nextStructureLevel } from './structureRows';

/** Presses "+ Add level" until the editor stops offering it (or well past the limit, should it never stop). */
function addAllLevels(rows: StructureRow[]) {
  const out = [...rows];
  while (canAddStructureLevel(out) && out.length < 4 * MAX_LEVELS) out.push(nextStructureLevel(out));
  return out;
}

describe('the tournament structure editor\'s "+ Add level"', () => {
  it('stops at the most levels the server accepts, never passes the chip maximum, and that structure saves', () => {
    const first: LevelRow = { kind: 'level', sb: 25, bb: 50, ante: 5, anteType: 'per-player', minutes: 15 };
    const rows = addAllLevels([first, { kind: 'break', minutes: 10 }]);
    expect(rows.filter((r) => r.kind === 'level')).toHaveLength(MAX_LEVELS);
    expect(rows[rows.length - 1]).toMatchObject({ sb: MAX_CHIPS, bb: MAX_CHIPS, ante: MAX_CHIPS });
    expect(validateStructure(rows).errors).toEqual([]);
  });

  it('counts only levels, not breaks, against the limit', () => {
    const level: LevelRow = { kind: 'level', sb: 25, bb: 50, ante: 0, anteType: 'none', minutes: 15 };
    const rows: StructureRow[] = [];
    for (let i = 0; i < MAX_LEVELS - 1; i++) rows.push(level, { kind: 'break', minutes: 5 });
    rows.push(level);
    expect(canAddStructureLevel(rows)).toBe(false);
    expect(canAddStructureLevel(rows.slice(0, -1))).toBe(true);
  });

  it('doubles the last level and keeps its ante type, length and rebuys', () => {
    expect(nextStructureLevel([{ kind: 'level', sb: 100, bb: 200, ante: 25, anteType: 'big-blind', minutes: 12, rebuy: true }, { kind: 'break', minutes: 10 }])).toEqual({
      kind: 'level', sb: 200, bb: 400, ante: 50, anteType: 'big-blind', minutes: 12, rebuy: true,
    });
    expect(nextStructureLevel([])).toEqual({ kind: 'level', sb: 25, bb: 50, ante: 0, anteType: 'none', minutes: 15 });
  });
});

describe('keepRebuysAndAddOns', () => {
  const lv = (bb: number, extra: object = {}): StructureRow => ({ kind: 'level', sb: bb / 2, bb, ante: 0, anteType: 'none', minutes: 10, ...extra });

  it('keeps the same rebuy levels, never more or fewer', () => {
    const old = [lv(100, { rebuy: true }), lv(200, { rebuy: true }), lv(400)];
    const fresh = [lv(10, { rebuy: true }), lv(20, { rebuy: true }), lv(30, { rebuy: true }), lv(40, { rebuy: true })];
    expect(keepRebuysAndAddOns(old, fresh).map((r) => r.kind === 'level' && !!r.rebuy)).toEqual([true, true, false, false]);
    expect(keepRebuysAndAddOns([lv(100)], fresh).some((r) => r.kind === 'level' && r.rebuy)).toBe(false);
  });

  it('keeps the add-on break after the same level: on RSDP levels, which have no breaks, it adds one', () => {
    const old = [...rsdpStructure().slice(0, 4), { kind: 'break', minutes: 5, addOn: true } as StructureRow, ...rsdpStructure().slice(4)];
    const out = keepRebuysAndAddOns(old, rsdpStructure());
    expect(out).toEqual(old);
    expect(validateStructure(out).errors).toEqual([]);
  });

  it('puts the add-ons on a break already there, and never adds one at the end', () => {
    const old = [lv(100), lv(200), { kind: 'break', minutes: 10, addOn: true } as StructureRow, lv(400)];
    const fresh = [lv(10), lv(20), { kind: 'break', minutes: 5 } as StructureRow, lv(40)];
    expect(keepRebuysAndAddOns(old, fresh)[2]).toEqual({ kind: 'break', minutes: 5, addOn: true });
    const short = keepRebuysAndAddOns(old, [lv(10), lv(20)]);
    expect(short.map((r) => r.kind)).toEqual(['level', 'break', 'level']);
    // A break the old levels had without add-ons doesn't bring add-ons in.
    expect(keepRebuysAndAddOns([lv(1), lv(2)], [lv(10), { kind: 'break', minutes: 5, addOn: true }, lv(20)])[1]).toEqual({ kind: 'break', minutes: 5 });
  });
});
