import { useState } from 'react';
import { payoutPreset, placePrizes, validatePayoutStructure, type PayoutPresetName, type PayoutStructure } from '@rsdp/tournament';
import { money, ordinal } from './format';

const PRESETS: Record<PayoutPresetName, string> = {
  rsdp: 'RSDP (our payout table)',
  standard: 'Standard (about 15% paid)',
  flat: 'Flat (about 20% paid)',
  'top-three': 'Top 3',
  'top-two': 'Top 2',
  'winner-take-all': 'Winner takes all',
};

/**
 * Payout ranges by entry count, with a tester. Percents are typed as "50, 30, 20". `reEntry` says whether the
 * event allows re-entries, which can take the entry count past max entrants.
 */
export function PayoutEditor({
  value: given,
  onChange,
  maxEntrants,
  pool,
  reEntry,
}: {
  value: PayoutStructure;
  onChange: (s: PayoutStructure) => void;
  maxEntrants: number;
  pool: number;
  reEntry: boolean;
}) {
  // A named preset is built for this event's size when the event is created (TournamentCreate), so it is checked,
  // tried and edited that way here too: one picked at a smaller max entrants is not out of date.
  const value = given.name in PRESETS ? payoutPreset(given.name as PayoutPresetName, maxEntrants) : given;
  const [entries, setEntries] = useState(Math.min(maxEntrants, 20));
  const [testPool, setTestPool] = useState(pool || 20_000);
  const errors = validatePayoutStructure(value, maxEntrants);
  // Payouts count every entry, re-entries too, so ranges past max entrants are allowed (a custom table built for a
  // bigger field keeps them when max entrants is lowered). Say when they can come into play.
  const pastMax = value.ranges.find((r) => r.minEntries > maxEntrants);
  // Typed text per range, so "50, 3" can be typed without being reformatted mid-edit.
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const setRange = (i: number, patch: Partial<PayoutStructure['ranges'][number]>) => {
    const ranges = value.ranges.map((r, j) => (j === i ? { ...r, ...patch } : r));
    // Keep ranges contiguous: each starts right after the previous one.
    for (let j = 1; j < ranges.length; j++) ranges[j] = { ...ranges[j], minEntries: ranges[j - 1].maxEntries + 1 };
    onChange({ ...value, name: 'custom', ranges });
  };

  const parse = (text: string) =>
    text
      .split(/[,\s]+/)
      .map((x) => Number(x))
      .filter((x) => x > 0);

  const prizes = placePrizes(testPool, value, entries);

  return (
    <div className="tn-payouts">
      <label>
        Preset
        <select
          value={value.name in PRESETS ? value.name : ''}
          onChange={(e) => {
            setDrafts({});
            onChange(payoutPreset(e.target.value as PayoutPresetName, maxEntrants));
          }}
        >
          <option value="" disabled>
            Custom
          </option>
          {(Object.keys(PRESETS) as PayoutPresetName[]).map((p) => (
            <option key={p} value={p}>
              {PRESETS[p]}
            </option>
          ))}
        </select>
      </label>
      <details className="tn-details">
        <summary>Edit ranges ({value.ranges.length})</summary>
        {value.ranges.map((r, i) => (
          <div className="tn-range" key={i}>
            <span className="tn-range-entries">
              {r.minEntries}–
              <input
                type="number"
                min={r.minEntries}
                value={r.maxEntries}
                aria-label="Up to entries"
                onChange={(e) => setRange(i, { maxEntries: Math.max(r.minEntries, Math.floor(Number(e.target.value) || 0)) })}
              />
              entries
            </span>
            <input
              className="tn-range-pct"
              value={drafts[i] ?? r.percents.join(', ')}
              aria-label="Percent per place"
              onChange={(e) => {
                setDrafts({ ...drafts, [i]: e.target.value });
                setRange(i, { percents: parse(e.target.value) });
              }}
            />
            <button type="button" aria-label="Remove range" disabled={value.ranges.length === 1} onClick={() => onChange({ ...value, name: 'custom', ranges: value.ranges.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const last = value.ranges[value.ranges.length - 1];
            onChange({ ...value, name: 'custom', ranges: [...value.ranges, { minEntries: last.maxEntries + 1, maxEntries: maxEntrants, percents: last.percents }] });
          }}
        >
          + Add range
        </button>
      </details>
      {value.roundTo ? <p className="muted">Prizes below 1st are rounded to the nearest {money(value.roundTo)}; anything left over goes to 1st.</p> : null}
      {pastMax && (
        <p className="muted">
          {reEntry
            ? `Ranges from ${pastMax.minEntries} entries up are only used if re-entries take the field past max entrants (${maxEntrants}).`
            : `Ranges from ${pastMax.minEntries} entries up can't be reached: max entrants is ${maxEntrants} and re-entry is off.`}
        </p>
      )}
      {errors.map((e) => (
        <p className="error" key={e}>
          {e}
        </p>
      ))}
      <div className="tn-tester">
        <b>Try it</b>
        <div className="row">
          <label>
            Entries
            <input type="number" min={2} max={maxEntrants} value={entries} onChange={(e) => setEntries(Math.floor(Number(e.target.value) || 2))} />
          </label>
          <label>
            Prize pool ($)
            <input type="number" min={0} value={testPool / 100} onChange={(e) => setTestPool(Math.round(Number(e.target.value) * 100))} />
          </label>
        </div>
        <PrizeList prizes={prizes} />
      </div>
    </div>
  );
}

export function PrizeList({ prizes }: { prizes: number[] }) {
  if (!prizes.length) return <p className="muted">No payout for this many entries.</p>;
  return (
    <ol className="tn-prizes">
      {prizes.map((p, i) => (
        <li key={i}>
          <span>{ordinal(i + 1)}</span>
          <b>{money(p)}</b>
        </li>
      ))}
    </ol>
  );
}
