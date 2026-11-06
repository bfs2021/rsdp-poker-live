/**
 * Table settings: one typed, versioned schema shared by server and web.
 *
 * - parseSettings validates a complete object (unknown keys rejected).
 * - migrateSettings loads stored or imported data of any version (unknown keys
 *   dropped, missing ones filled from defaults, then validated).
 * - Host edits are patches: applyImmediate applies IMMEDIATE_FIELDS now and
 *   queues the rest; applyAtNextHand applies the queue between hands.
 * - Feature modules add sections under `modifiers` with registerModifierSchema.
 */

export {
  ANTE_TYPES,
  BETTING_KINDS,
  LEVEL_COUNTDOWNS,
  MAX_CHIPS,
  ROTATION_UNITS,
  RUN_IT_TWICE_OPTIONS,
  SETTINGS_LIMITS,
  SETTINGS_VERSION,
  SHOWDOWN_SECONDS,
  FELTS,
  STRADDLE_OPTIONS,
  TABLE_MODES,
  TableSettingsSchema,
  type BlindLevel,
  type ChoiceGame,
  type DealersChoiceSettings,
  type RotationStep,
  type TableMode,
  type TableSettings,
} from './schema';
export { SettingsError, defaultSettings, issuesFromZod, parseSettings, type SettingsIssue } from './parse';
export { settingsErrorMap } from './messages';
export { migrateSettings, type MigrateOptions } from './migrate';
export {
  IMMEDIATE_FIELDS,
  applyAtNextHand,
  applyImmediate,
  diffSettings,
  isImmediateField,
  mergePatches,
  type DeepPartial,
  type SettingsChange,
  type SettingsPatch,
  type SettingsUpdate,
} from './changes';
export { PRESET_FORMAT, PRESET_VERSION, exportPreset, importPreset, type SettingsPreset } from './preset';
export {
  enabledModifiers,
  getModifierSchema,
  listModifierSchemas,
  registerModifierSchema,
  unregisterModifierSchema,
  type ModifierSchemaOptions,
  type ModifierSection,
  type RegisteredModifier,
} from './modifiers';
export { behindText, delayText, settingsNotices, spectatorsSeeCards, type SettingsNotice } from './notices';
export { CHIP_AMOUNT_PATHS, amountText, newCashSettings, scaleChipAmounts } from './money';
