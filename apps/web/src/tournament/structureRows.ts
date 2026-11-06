import { levelDeal, MAX_CHIPS, MAX_LEVELS, type LevelRow, type StructureRow, type TournamentSettings } from '@rsdp/tournament';
import { chips } from './format';

/** What decides each level's game: the tournament's rotation. */
export type Rotation = Pick<TournamentSettings, 'games' | 'gameBetting' | 'stopRotationAtLevel'>;

/**
 * For the host: a level with a big-blind ante that deals a stud game, where it becomes everyone's smaller ante.
 * The example is the first such level's own amounts. Null when no level does that.
 */
export function studBigBlindAnteNote(rows: readonly StructureRow[], rotation: Rotation): string | null {
  let n = 0;
  for (const r of rows) {
    if (r.kind !== 'level') continue;
    n++;
    if (r.anteType !== 'big-blind' || r.ante <= 0) continue;
    const dealt = levelDeal(rotation, n, r);
    if (dealt.anteType === 'per-player') return `In stud games a big-blind ante is paid by everyone as a smaller ante: about an eighth of it (${chips(r.ante)} becomes ${chips(dealt.ante)} each).`;
  }
  return null;
}

/** Whether "+ Add level" may add another level: the server takes at most MAX_LEVELS levels (breaks don't count). */
export const canAddStructureLevel = (rows: readonly StructureRow[]) => rows.filter((r) => r.kind === 'level').length < MAX_LEVELS;

/** The level "+ Add level" adds: the last level's blinds and ante doubled, but never past MAX_CHIPS, which the server refuses. */
export function nextStructureLevel(rows: readonly StructureRow[]): LevelRow {
  const last = [...rows].reverse().find((r): r is LevelRow => r.kind === 'level');
  const double = (v: number) => Math.min(v * 2, MAX_CHIPS);
  const sb = last ? double(last.sb) : 25;
  return { kind: 'level', sb, bb: double(sb), ante: last?.anteType === 'none' ? 0 : double(last?.ante ?? 0), anteType: last?.anteType ?? 'none', minutes: last?.minutes ?? 15, ...(last?.rebuy ? { rebuy: true } : {}) };
}

/**
 * New levels from "Replace levels", keeping the host's rebuy and add-on choices:
 * level N allows rebuys if level N did before, and an add-on break stays after
 * the same level (a break already there gets the add-ons, else a 5-minute one is
 * added). So replacing the levels never turns rebuys or add-ons on or off.
 */
export function keepRebuysAndAddOns(old: readonly StructureRow[], fresh: readonly StructureRow[]): StructureRow[] {
  const oldLevels = old.filter((r): r is LevelRow => r.kind === 'level');
  let n = 0;
  const out: StructureRow[] = fresh.map((r) => {
    if (r.kind === 'break') {
      const { addOn: _a, ...rest } = r;
      return rest;
    }
    const { rebuy: _r, ...rest } = r;
    return oldLevels[n++]?.rebuy ? { ...rest, rebuy: true } : rest;
  });
  const addOnAt = old.findIndex((r) => r.kind === 'break' && r.addOn);
  if (addOnAt < 0) return out;
  const levelsBefore = old.slice(0, addOnAt).filter((r) => r.kind === 'level').length;
  const freshLevels = out.filter((r) => r.kind === 'level').length;
  // After the same level, but never last: a break can't end the structure.
  const after = Math.max(1, Math.min(levelsBefore, freshLevels - 1));
  if (freshLevels < 2) return out;
  let seen = 0;
  const at = out.findIndex((r) => r.kind === 'level' && ++seen === after) + 1;
  if (out[at]?.kind === 'break') out[at] = { ...out[at], addOn: true };
  else out.splice(at, 0, { kind: 'break', minutes: 5, addOn: true });
  return out;
}
