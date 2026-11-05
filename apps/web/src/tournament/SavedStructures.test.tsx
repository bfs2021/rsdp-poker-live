// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyStarter, defaultSettings, isRsdpLevels, type TournamentSettings } from '@rsdp/tournament';
import { SavedStructures } from './SavedStructures';

vi.mock('./structures', () => ({
  tournamentStructures: { use: () => [], useOnAccount: () => false, ready: () => true },
  saveStructure: vi.fn(),
  structureSettings: vi.fn(),
}));

afterEach(cleanup);

/** A new tournament's form: the RSDP starter, here with a mixed game picked. */
const rsdp = applyStarter(defaultSettings({ name: 'Friday', games: ['nlhe', 'plo4', 'plo8'] }), 'rsdp');

function show(current: TournamentSettings) {
  const onLoad = vi.fn<(settings: TournamentSettings, note: string) => void>();
  render(<SavedStructures current={current} onLoad={onLoad} />);
  return onLoad;
}

describe('Start from', () => {
  it('shows that a new tournament is set to RSDP, and that the games are the host\'s', () => {
    show(rsdp);
    expect(screen.getByRole('button', { name: 'RSDP', pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turbo', pressed: false })).toBeTruthy();
    expect(screen.getByText(/63,000 chips, 28 levels of 8 minutes, no antes, late registration through level 5, 10-second clock\. Your games, start time and everything else are up to you\./)).toBeTruthy();
  });

  it('shows no starter as picked once the levels are changed', () => {
    show({ ...rsdp, structure: rsdp.structure.slice(0, 20) });
    for (const name of ['RSDP', 'Turbo', 'Standard', 'Deep stack']) expect(screen.getByRole('button', { name, pressed: false })).toBeTruthy();
    expect(screen.getByText(/Starters set the stack, blind levels and late registration, and keep your games\./)).toBeTruthy();
  });

  it('puts the RSDP levels back and keeps a mixed game', () => {
    const onLoad = show({ ...rsdp, startingStack: 10_000, structure: rsdp.structure.slice(0, 20) });
    fireEvent.click(screen.getByRole('button', { name: 'RSDP' }));
    const [loaded] = onLoad.mock.lastCall!;
    expect(loaded.games).toEqual(['nlhe', 'plo4', 'plo8']);
    expect(loaded.startingStack).toBe(63_000);
    expect(isRsdpLevels(loaded.structure)).toBe(true);
  });
});
