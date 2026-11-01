// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { payoutPreset, type PayoutStructure } from '@rsdp/tournament';
import { PayoutEditor } from './PayoutEditor';

afterEach(cleanup);

/** A custom table built for 600 entrants: the host lowered max entrants afterwards. */
const builtFor600: PayoutStructure = {
  name: 'custom',
  ranges: [
    { minEntries: 2, maxEntries: 50, percents: [60, 40] },
    { minEntries: 51, maxEntries: 200, percents: [50, 30, 20] },
    { minEntries: 201, maxEntries: 600, percents: [40, 30, 20, 10] },
  ],
};

const show = (value: PayoutStructure, maxEntrants: number, reEntry: boolean) =>
  render(<PayoutEditor value={value} onChange={() => {}} maxEntrants={maxEntrants} pool={0} reEntry={reEntry} />);

describe('PayoutEditor ranges past max entrants', () => {
  // Payouts count re-entries, so these ranges are allowed, but the host should know when they can come into play.
  it('says ranges past max entrants are only used through re-entries', () => {
    show(builtFor600, 100, true);
    expect(screen.getByText(/Ranges from 201 entries up are only used if re-entries take the field past max entrants \(100\)/)).toBeTruthy();
  });

  it('says they cannot be reached when re-entry is off', () => {
    show(builtFor600, 100, false);
    expect(screen.getByText(/Ranges from 201 entries up can't be reached: max entrants is 100 and re-entry is off/)).toBeTruthy();
  });

  it('says nothing when every range starts within max entrants', () => {
    show(builtFor600, 300, false);
    expect(screen.queryByText(/Ranges from/)).toBeNull();
    cleanup();
    show(payoutPreset('rsdp', 40), 40, false);
    expect(screen.queryByText(/Ranges from/)).toBeNull();
  });
});
