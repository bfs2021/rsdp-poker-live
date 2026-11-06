import { useState } from 'react';
import {
  MAX_LEVELS,
  generateStructure,
  isRsdpLevels,
  levelDeal,
  plannedMinutes,
  presetStructure,
  rsdpStructure,
  validateStructure,
  MAX_CHIPS,
  type AnteType,
  type LevelRow,
  type PresetName,
  type StructureRow,
} from '@rsdp/tournament';
import { GAMES, chips, gameName } from './format';
import { canAddStructureLevel, keepRebuysAndAddOns, nextStructureLevel, studBigBlindAnteNote, type Rotation } from './structureRows';

interface Props {
  rows: StructureRow[];
  onChange: (rows: StructureRow[]) => void;
  startingStack: number;
  expectedEntrants: number;
  maxRebuys: number;
  /** Rows up to and including this index are locked (already played). */
  lockedThrough?: number;
  /** Highlight this row (the current level). */
  currentRow?: number;
  /** Show the per-level game column (mixed games). */
  showGames?: boolean;
  /** The tournament's games, to say how a big-blind ante works in the stud games. */
  rotation?: Rotation;
}

const PRESET_LABELS: Record<PresetName | 'rsdp', string> = {
  rsdp: 'RSDP (28 levels of 8 min, no antes)',
  hyper: 'Hyper (25 BB, 4 min)',
  turbo: 'Turbo (50 BB, 8 min)',
  regular: 'Regular (100 BB, 15 min)',
  deep: 'Deep (200 BB, 20 min)',
};

const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
/** A typed blind or ante: the server refuses anything above MAX_CHIPS, so stop there. */
const chipNum = (v: string) => Math.min(MAX_CHIPS, num(v));

/** Edit blind levels and breaks. Cards on phones, a grid on wider screens. */
export function StructureEditor({ rows, onChange, startingStack, expectedEntrants, maxRebuys, lockedThrough = -1, currentRow, showGames, rotation }: Props) {
  const rsdp = isRsdpLevels(rows);
  // What "Use different blind levels" offers first: something other than what's there now.
  const [preset, setPreset] = useState<PresetName | 'rsdp' | 'target'>(() => (rsdp ? 'regular' : 'rsdp'));
  const [target, setTarget] = useState(180);
  const [anteType, setAnteType] = useState<AnteType>('per-player');
  // Collapsed by default on phones, where 20+ level cards make a very long page.
  // Closed to start with: the summary line above says what's in it, and 20-odd rows make the form very long.
  const [open, setOpen] = useState(false);
  const { errors, warnings } = validateStructure(rows, { maxRebuys });
  const studNote = rotation ? studBigBlindAnteNote(rows, rotation) : null;
  const editable = (i: number) => i > lockedThrough;
  const levelCount = rows.filter((r) => r.kind === 'level').length;
  const breakCount = rows.length - levelCount;

  const load = () => {
    const opts = { startingStack, expectedEntrants, anteType };
    const fresh = preset === 'rsdp' ? rsdpStructure() : preset === 'target' ? generateStructure({ ...opts, targetMinutes: target }) : presetStructure(preset, opts);
    // Rebuy levels and the add-on break stay where the host had them.
    const kept = keepRebuysAndAddOns(rows, fresh);
    onChange([...rows.slice(0, lockedThrough + 1), ...kept.slice(lockedThrough + 1)]);
  };

  const update = (i: number, patch: Partial<LevelRow> | { minutes: number } | { addOn: boolean }) => {
    const next = rows.map((r, j) => (j === i ? ({ ...r, ...patch } as StructureRow) : r));
    onChange(next);
  };

  const setAnte = (i: number, row: LevelRow, ante: number, type: AnteType) => {
    if (type === 'none') update(i, { ante: 0, anteType: 'none' });
    else update(i, { ante: ante || (type === 'big-blind' ? row.bb : Math.max(1, Math.round(row.bb / 8))), anteType: type });
  };

  const insert = (i: number, row: StructureRow) => onChange([...rows.slice(0, i), row, ...rows.slice(i)]);
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));


  let levelNo = 0;
  return (
    <div className="tn-structure">
      <p className="tn-structure-summary">
        {rsdp ? (
          <>
            <b>RSDP blind levels:</b> 28 levels of 8 minutes, starting at 100/200, no antes
          </>
        ) : (
          `${levelCount} ${levelCount === 1 ? 'level' : 'levels'}`
        )}
        {breakCount > 0 ? `, ${rsdp ? 'plus ' : ''}${breakCount} ${breakCount === 1 ? 'break' : 'breaks'}` : ''}. About {Math.round(plannedMinutes(rows) / 6) / 10} h until the last level, which runs until the end.
      </p>

      <details className="tn-details tn-replace">
        <summary>Use different blind levels</summary>
        <div className="tn-preset-bar">
          <label>
            Replace the levels with
            <select value={preset} onChange={(e) => setPreset(e.target.value as PresetName | 'rsdp' | 'target')}>
              {(Object.keys(PRESET_LABELS) as (PresetName | 'rsdp')[]).map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABELS[p]}
                </option>
              ))}
              <option value="target">Fit a target length…</option>
            </select>
          </label>
          {preset === 'target' && (
            <label>
              Minutes
              <input type="number" min={30} max={1440} value={target} onChange={(e) => setTarget(num(e.target.value))} />
            </label>
          )}
          {preset !== 'rsdp' && (
            <label>
              Antes
              <select value={anteType} onChange={(e) => setAnteType(e.target.value as AnteType)}>
                <option value="per-player">Per player</option>
                <option value="big-blind">Big blind ante</option>
                <option value="none">None</option>
              </select>
            </label>
          )}
          <button type="button" onClick={load}>
            Replace levels
          </button>
        </div>
        <p className="muted">
          Nothing changes until you press Replace levels. It swaps the levels {lockedThrough >= 0 ? 'still to come' : 'below'} for new ones.
        </p>
      </details>

      <details className="tn-details" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{open ? 'Hide levels' : `Edit levels (${rows.length} rows)`}</summary>
      <div className="tn-rows" role="table">
        <div className="tn-row tn-row-head" role="row">
          <span>#</span>
          <span>Small</span>
          <span>Big</span>
          <span>Ante</span>
          <span>Min</span>
          <span>{maxRebuys > 0 ? 'Rebuy' : ''}</span>
          <span />
        </div>
        {rows.map((r, i) => {
          const locked = !editable(i);
          const cls = `tn-row ${r.kind === 'break' ? 'tn-break' : ''} ${i === currentRow ? 'tn-current' : ''} ${locked ? 'tn-locked' : ''}`;
          if (r.kind === 'break') {
            return (
              <div className={cls} role="row" key={i}>
                <span className="tn-break-label">Break</span>
                <label className="tn-cell tn-span">
                  <span className="tn-cell-label">Minutes</span>
                  <input type="number" min={1} max={240} disabled={locked} value={r.minutes} onChange={(e) => update(i, { minutes: num(e.target.value) })} />
                </label>
                <label className="tn-check tn-span">
                  <input type="checkbox" disabled={locked} checked={!!r.addOn} onChange={(e) => update(i, { addOn: e.target.checked })} /> Add-ons
                </label>
                <span className="tn-row-actions">{!locked && <button type="button" aria-label="Remove break" onClick={() => remove(i)}>✕</button>}</span>
              </div>
            );
          }
          levelNo++;
          return (
            <div className={cls} role="row" key={i}>
              <span className="tn-level-no">{levelNo}</span>
              <label className="tn-cell">
                <span className="tn-cell-label">Small blind</span>
                <input type="number" min={0} max={MAX_CHIPS} disabled={locked} value={r.sb} onChange={(e) => update(i, { sb: chipNum(e.target.value) })} />
              </label>
              <label className="tn-cell">
                <span className="tn-cell-label">Big blind</span>
                <input type="number" min={1} max={MAX_CHIPS} disabled={locked} value={r.bb} onChange={(e) => update(i, { bb: chipNum(e.target.value) })} />
              </label>
              <label className="tn-cell tn-ante">
                <span className="tn-cell-label">Ante</span>
                <span className="tn-ante-inputs">
                  <select disabled={locked} value={r.anteType} onChange={(e) => setAnte(i, r, r.ante, e.target.value as AnteType)} aria-label="Ante type">
                    <option value="none">–</option>
                    <option value="per-player">Each</option>
                    <option value="big-blind">BB</option>
                  </select>
                  {r.anteType !== 'none' && (
                    <input type="number" min={1} max={MAX_CHIPS} disabled={locked} value={r.ante} onChange={(e) => setAnte(i, r, chipNum(e.target.value), r.anteType)} aria-label="Ante" />
                  )}
                </span>
              </label>
              <label className="tn-cell">
                <span className="tn-cell-label">Minutes</span>
                <input type="number" min={1} max={240} disabled={locked} value={r.minutes} onChange={(e) => update(i, { minutes: num(e.target.value) })} />
              </label>
              <span className="tn-cell tn-extra">
                {maxRebuys > 0 && (
                  <label className="tn-check">
                    <input type="checkbox" disabled={locked} checked={!!r.rebuy} onChange={(e) => update(i, { rebuy: e.target.checked })} />
                    <span className="tn-cell-label-inline">Rebuys</span>
                  </label>
                )}
                {showGames && (
                  <select disabled={locked} value={r.gameId ?? ''} onChange={(e) => update(i, { gameId: e.target.value || undefined })} aria-label="Game">
                    <option value="">Rotation</option>
                    {GAMES.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                )}
              </span>
              <span className="tn-row-actions">
                {!locked && (
                  <>
                    <button type="button" title="Add a break after this level" onClick={() => insert(i + 1, { kind: 'break', minutes: 10 })}>
                      ☕
                    </button>
                    <button type="button" aria-label={`Remove level ${levelNo}`} onClick={() => remove(i)}>
                      ✕
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        disabled={!canAddStructureLevel(rows)}
        title={canAddStructureLevel(rows) ? undefined : `A structure holds up to ${MAX_LEVELS} levels`}
        onClick={() => insert(rows.length, nextStructureLevel(rows))}
      >
        + Add level
      </button>
      </details>
      {errors.map((e) => (
        <p className="error" key={e}>
          {e}
        </p>
      ))}
      {warnings.map((w) => (
        <p className="tn-warning" key={w}>
          {w}
        </p>
      ))}
      {studNote && <p className="muted">{studNote}</p>}
      <p className="muted">Starting stack {chips(startingStack)} = {Math.round(startingStack / ((rows.find((r) => r.kind === 'level') as LevelRow | undefined)?.bb || 1))} big blinds at level 1.</p>
    </div>
  );
}

/**
 * Read-only structure table with the current level highlighted. Given the rotation, each level shows its game
 * when there is more than one, and the ante that game posts, as the tables deal it.
 */
export function StructureTable({ rows, currentRow, rotation }: { rows: StructureRow[]; currentRow?: number; rotation?: Rotation }) {
  let n = 0;
  const dealt = rows.map((r) => (r.kind === 'level' && rotation ? levelDeal(rotation, ++n, r) : null));
  const mixed = !!rotation && rotation.games.length > 1;
  let levelNo = 0;
  return (
    <table className="tn-table">
      <thead>
        <tr>
          <th>Level</th>
          <th>Blinds</th>
          <th>Ante</th>
          <th>Min</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) =>
          r.kind === 'break' ? (
            <tr key={i} className={`tn-break ${i === currentRow ? 'tn-current' : ''}`}>
              <td colSpan={3}>Break{r.addOn ? ' · add-ons' : ''}</td>
              <td>{r.minutes}</td>
            </tr>
          ) : (
            <tr key={i} className={i === currentRow ? 'tn-current' : ''}>
              <td>
                {++levelNo}
                {r.rebuy ? <span className="tn-tag">R</span> : null}
              </td>
              <td>
                {chips(r.sb)} / {chips(r.bb)}
                {mixed || r.gameId ? <span className="muted"> · {dealt[i] ? gameName(dealt[i].gameId, dealt[i].betting) : r.gameId}</span> : null}
              </td>
              <td>{anteText(dealt[i] ?? r)}</td>
              <td>{i === rows.map((x) => x.kind).lastIndexOf('level') ? '∞' : r.minutes}</td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

const anteText = (a: { ante: number; anteType: AnteType }) => (a.anteType === 'none' || a.ante === 0 ? '–' : `${chips(a.ante)}${a.anteType === 'big-blind' ? ' BB' : ''}`);
