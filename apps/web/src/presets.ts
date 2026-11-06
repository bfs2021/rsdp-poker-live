import { exportPreset, importPreset, type TableSettings } from '@rsdp/engine/settings';
import type { SavedSetup } from '@rsdp/engine/wire';
import { setupList } from './savedSetups';
import { seatsThatFit } from './components/settings/withPreset';

/**
 * Table presets: whole table setups under a name, kept as preset files (the
 * same JSON that Export downloads), so they load through the settings
 * migration even after the settings change shape. On the account when signed
 * in, else in this browser.
 */
export type SavedPreset = SavedSetup;

export const tablePresets = setupList('table', 'rsdp.presets', ({ name, json }) => ({ name, json: exportPreset(importPreset(json).settings, name) }));

export const usePresets = tablePresets.use;

/** Saves settings under a name, replacing a preset of the same name, with seats every game can deal. Rejects with a SettingsError when they don't validate. */
export function savePreset(name: string, settings: TableSettings) {
  return tablePresets.save(name, exportPreset(seatsThatFit(settings), 'Preset'));
}

/** Adds a preset file someone shared. Rejects with a SettingsError for anything that isn't one. */
export async function addPresetFile(json: string) {
  const { name, settings } = importPreset(json);
  return savePreset(name, settings);
}

/** A saved preset's settings, upgraded to the current layout, with seats every game can deal (one saved before that could have more). */
export function presetSettings(preset: SavedPreset): TableSettings {
  return seatsThatFit(importPreset(preset.json).settings);
}
