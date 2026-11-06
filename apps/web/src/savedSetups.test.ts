import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, exportPreset, importPreset } from '@rsdp/engine/settings';
import { SETUPS_PER_KIND } from '@rsdp/engine/wire';
import { MAX_SAVED_STRUCTURE_LENGTH } from '@rsdp/tournament';

vi.mock('./socket', () => ({ socket: { on: () => {} }, call: () => Promise.reject(new Error('offline')), currentSession: () => null, onSession: () => {} }));

/** A browser storage stub, kept in a map. */
function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal('window', { addEventListener: () => {} });
  return store;
}

/** A guest's table presets, kept in a stubbed browser storage. */
async function guestPresets() {
  stubStorage();
  const { setupList } = await import('./savedSetups');
  return setupList('table', 'rsdp.presets', ({ name, json }) => ({ name, json: exportPreset(importPreset(json).settings, name) }));
}

/** A guest's tournament structures (kept as given), in a stubbed browser storage. */
async function guestStructures(store = stubStorage()) {
  const { setupList } = await import('./savedSetups');
  return { store, list: setupList('tournament', 'test.structures', (s) => s) };
}

afterEach(() => vi.unstubAllGlobals());

describe('saved setup names', () => {
  it('count an emoji as two, like the preset inside, so a long one gets the names message and not a preset error', async () => {
    const presets = await guestPresets();
    const json = exportPreset(defaultSettings('cash'), 'x');
    expect(await presets.save('🂡'.repeat(30), json)).toBe('🂡'.repeat(30));
    await expect(presets.save('🂡'.repeat(31), json)).rejects.toThrow(/^Names can be up to 60 characters$/);
    await expect(presets.rename('🂡'.repeat(30), '🂡'.repeat(31))).rejects.toThrow(/^Names can be up to 60 characters$/);
  });
});

describe("a guest's saved setups keep to what an account takes", () => {
  /** JSON text exactly `length` characters long. */
  const sized = (length: number) => JSON.stringify({ pad: 'x'.repeat(length - JSON.stringify({ pad: '' }).length) });

  it('refuses one too big for an account, so all it keeps can be brought over at sign-in', async () => {
    const { store, list } = await guestStructures();
    expect(await list.save('Biggest', sized(MAX_SAVED_STRUCTURE_LENGTH))).toBe('Biggest');
    await expect(list.save('Too big', sized(MAX_SAVED_STRUCTURE_LENGTH + 1))).rejects.toThrow(/^That setup is too big to save$/);
    expect(list.list().map((s) => s.name)).toEqual(['Biggest']);
    expect(JSON.parse(store.get('test.structures') ?? '[]')).toHaveLength(1);
  });

  it(`keeps up to ${SETUPS_PER_KIND}, still replacing one by name once full`, async () => {
    const { list } = await guestStructures();
    for (let i = 0; i < SETUPS_PER_KIND; i++) await list.save(`S${i}`, '{}');
    await expect(list.save('One more', '{}')).rejects.toThrow(`You can keep up to ${SETUPS_PER_KIND} of these; delete some first`);
    expect(await list.save('S0', '{"a":1}')).toBe('S0');
    expect(list.list()).toHaveLength(SETUPS_PER_KIND);
    expect(list.list().find((s) => s.name === 'S0')?.json).toBe('{"a":1}');
  });

  it('still shows a list saved before these limits, even one over them, and lets it be tidied', async () => {
    const store = stubStorage();
    const old = Array.from({ length: SETUPS_PER_KIND + 5 }, (_, i) => ({ name: `Old ${i}`, json: i ? '{}' : sized(MAX_SAVED_STRUCTURE_LENGTH + 10) }));
    store.set('test.structures', JSON.stringify(old));
    const { list } = await guestStructures(store);
    expect(list.list()).toHaveLength(SETUPS_PER_KIND + 5);
    expect(await list.rename('Old 0', 'Renamed')).toBe('Renamed');
    await list.remove('Old 1');
    expect(list.list()).toHaveLength(SETUPS_PER_KIND + 4);
  });
});

describe('a preset with more seats than one of its games deals', () => {
  it('is saved, and started from, with seats that fit', async () => {
    stubStorage();
    const { presetSettings, savePreset, tablePresets } = await import('./presets');
    const s = defaultSettings('cash');
    const step = (gameId: string, betting: 'no-limit' | 'fixed-limit') => ({ gameId, betting, length: 1, unit: 'orbits' as const });
    // A draft whose rotation gained Badugi (at most 6) without the seats coming down.
    const mixed = { ...s, table: { ...s.table, maxSeats: 10 }, game: { ...s.game, rotation: { enabled: true, steps: [step('nlhe', 'no-limit'), step('badugi', 'fixed-limit')] } } };
    await savePreset('Mixed', mixed);
    expect(importPreset(tablePresets.list()[0].json).settings.table.maxSeats).toBe(6);
    // One saved before this, still with 10 seats, starts a table of 6.
    expect(presetSettings({ name: 'Old', json: exportPreset(mixed, 'Old') }).table.maxSeats).toBe(6);
  });
});
