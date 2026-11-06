// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHIPS, isRsdpLevels, rsdpStructure, validateStructure, type LevelRow, type StructureRow } from '@rsdp/tournament';
import type { BettingKind } from '@rsdp/engine/core';
import { StructureEditor, StructureTable } from './StructureEditor';

afterEach(cleanup);

const level: LevelRow = { kind: 'level', sb: 25, bb: 50, ante: 5, anteType: 'per-player', minutes: 15 };

function setup() {
  const onChange = vi.fn<(rows: StructureRow[]) => void>();
  render(<StructureEditor rows={[level]} onChange={onChange} startingStack={10_000} expectedEntrants={9} maxRebuys={0} />);
  return onChange;
}

describe('StructureEditor typed blinds and ante', () => {
  // The server refuses any amount above MAX_CHIPS, so a typed amount stops there instead of failing on save.
  it.each([
    ['Small blind', 'sb'],
    ['Big blind', 'bb'],
    ['Ante', 'ante'],
  ] as const)('%s stops at the maximum chip amount', (label, field) => {
    const onChange = setup();
    const input = screen.getByRole('spinbutton', { name: label }) as HTMLInputElement;
    expect(input.max).toBe(String(MAX_CHIPS));
    fireEvent.change(input, { target: { value: String(MAX_CHIPS * 10) } });
    const row = onChange.mock.lastCall![0][0] as LevelRow;
    expect(row[field]).toBe(MAX_CHIPS);
  });

  it('a level typed up to the maximum still passes the structure check', () => {
    const onChange = setup();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Big blind' }), { target: { value: '9'.repeat(16) } });
    const rows = onChange.mock.lastCall![0];
    expect((rows[0] as LevelRow).bb).toBe(MAX_CHIPS);
    expect(validateStructure(rows, { maxRebuys: 0 }).errors).toEqual([]);
  });
});

describe('StructureEditor says what the levels are', () => {
  const show = (rows: StructureRow[], maxRebuys = 0) => {
    const onChange = vi.fn<(rows: StructureRow[]) => void>();
    render(<StructureEditor rows={rows} onChange={onChange} startingStack={63_000} expectedEntrants={9} maxRebuys={maxRebuys} />);
    return onChange;
  };

  it('names the RSDP levels, and keeps the tool that replaces them out of the way', () => {
    const onChange = show(rsdpStructure());
    expect(screen.getByText('RSDP blind levels:')).toBeTruthy();
    expect(screen.getByText(/28 levels of 8 minutes, starting at 100\/200, no antes\. About 3\.6 h/)).toBeTruthy();
    // The replace tool sits in a closed "Use different blind levels" section and names what it does.
    const replace = screen.getByText('Use different blind levels').closest('details')!;
    expect(replace.open).toBe(false);
    expect(screen.queryByRole('button', { name: 'Load' })).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Replace the levels with' }) as HTMLSelectElement).value).toBe('regular');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says how many levels and breaks other levels have', () => {
    show([level, { kind: 'break', minutes: 10 }, { ...level, sb: 50, bb: 100 }]);
    expect(screen.queryByText('RSDP blind levels:')).toBeNull();
    expect(screen.getByText(/^2 levels, 1 break\. About/)).toBeTruthy();
  });

  it('can put the RSDP levels back, with no antes to pick', () => {
    const onChange = show([level]);
    const pick = screen.getByRole('combobox', { name: 'Replace the levels with' }) as HTMLSelectElement;
    expect(pick.value).toBe('rsdp');
    expect(screen.queryByRole('combobox', { name: 'Antes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace levels' }));
    expect(isRsdpLevels(onChange.mock.lastCall![0])).toBe(true);
  });

  it('replaces the levels with another kind only when asked, keeping rebuy levels when rebuys are on', () => {
    const onChange = show(rsdpStructure({ rebuyThroughLevel: 4 }), 1);
    fireEvent.change(screen.getByRole('combobox', { name: 'Antes' }), { target: { value: 'none' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace levels' }));
    const rows = onChange.mock.lastCall![0];
    expect(isRsdpLevels(rows)).toBe(false);
    expect(rows[0]).toMatchObject({ kind: 'level', minutes: 15, anteType: 'none' });
    expect(rows.filter((r) => r.kind === 'level' && r.rebuy)).toHaveLength(4);
    expect(validateStructure(rows, { maxRebuys: 1 }).errors).toEqual([]);
  });
});

describe('Replace levels keeps add-ons', () => {
  it('keeps the add-on break when the RSDP levels are put back', () => {
    const onChange = vi.fn<(rows: StructureRow[]) => void>();
    const rows: StructureRow[] = [level, { ...level, sb: 50, bb: 100 }, { kind: 'break', minutes: 5, addOn: true }, { ...level, sb: 100, bb: 200 }];
    render(<StructureEditor rows={rows} onChange={onChange} startingStack={63_000} expectedEntrants={9} maxRebuys={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Replace levels' }));
    const out = onChange.mock.lastCall![0];
    expect(isRsdpLevels(out)).toBe(true);
    expect(out[2]).toEqual({ kind: 'break', minutes: 5, addOn: true });
  });
});

describe('a big-blind ante in the stud games', () => {
  const horse = { games: ['nlhe', 'plo8', 'razz', 'stud', 'stud8'], gameBetting: Array<BettingKind>(5).fill('fixed-limit') };
  const bbAnte = (n: number): LevelRow => ({ kind: 'level', sb: 50 * n, bb: 100 * n, ante: 100 * n, anteType: 'big-blind', minutes: 10 });
  const rows: StructureRow[] = [bbAnte(1), bbAnte(2), bbAnte(3), bbAnte(4)];
  const note = /^In stud games a big-blind ante is paid by everyone as a smaller ante: about an eighth of it \(300 becomes 40 each\)\.$/;

  it('tells the host what the stud levels post, from the first stud level with one', () => {
    render(<StructureEditor rows={rows} onChange={vi.fn()} startingStack={10_000} expectedEntrants={9} maxRebuys={0} rotation={horse} />);
    expect(screen.getByText(note)).toBeTruthy();
  });

  it('says nothing without a stud game, or without a big-blind ante', () => {
    render(<StructureEditor rows={rows} onChange={vi.fn()} startingStack={10_000} expectedEntrants={9} maxRebuys={0} rotation={{ games: ['nlhe', 'plo4'] }} />);
    render(<StructureEditor rows={[level]} onChange={vi.fn()} startingStack={10_000} expectedEntrants={9} maxRebuys={0} rotation={horse} />);
    expect(screen.queryByText(/big-blind ante is paid by everyone/)).toBeNull();
  });

  it('the structure table shows each level\'s game and the ante it deals', () => {
    render(<StructureTable rows={rows} rotation={horse} />);
    const cells = screen.getAllByRole('row').slice(1).map((r) => [...r.querySelectorAll('td')].slice(1, 3).map((td) => td.textContent));
    expect(cells).toEqual([
      // In a mix with stud the blind games post no ante (D29).
      ["50 / 100 · Limit Hold'em", '–'],
      ['100 / 200 · Limit Omaha Hi-Lo (8 or better)', '–'],
      ['150 / 300 · Razz', '40'],
      ['200 / 400 · Seven Card Stud', '50'],
    ]);
  });
});
