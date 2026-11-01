// Payouts (TRN-30, TRN-42): display-only prize pool, payout structures with
// player-count ranges, built-in presets, prize calculation, and final-table
// deals by chip chop or ICM. Money is whole units of the smallest currency
// unit (cents); nothing here moves real balances.

export interface PayoutRange {
  /** Inclusive entry-count range. */
  minEntries: number;
  maxEntries: number;
  /** Percent of the pool for 1st, 2nd, ... Up to two decimals; sums to 100. */
  percents: number[];
}

export interface PayoutStructure {
  name: string;
  ranges: PayoutRange[];
  /** Round each place below 1st to the nearest multiple of this (cents), leftover to 1st. */
  roundTo?: number;
}

/** Largest rounding step a structure may ask for: $1,000. */
export const MAX_ROUND_TO = 100_000;

/**
 * Most ranges in a table, and most places one range pays. Every preset fits at 600 entrants (Flat has the
 * most: 120 ranges, up to 120 places), and the caps keep a table to a size the settings can carry.
 */
export const MAX_PAYOUT_RANGES = 150;
export const MAX_PAID_PLACES = 200;

/**
 * Highest entry count a range may reach. Re-entries count as entries, so ranges may run past max entrants (and
 * the last one carries on past its end anyway); this only stops a slip of the keyboard reaching millions.
 */
export const MAX_PAYOUT_ENTRIES = 10_000;

/**
 * Largest buy-in, rebuy, add-on, added money or bounty: $100,000. Pools and prizes stay safe integers well past
 * any field this site can hold (placePrizes multiplies the pool by up to 10,000).
 */
export const MAX_PRIZE_AMOUNT = 10_000_000;

/** Optional display-only money values. All amounts in the smallest unit. */
export interface PrizeMoney {
  buyIn: number;
  rebuy?: number;
  addOn?: number;
  /** Percent of buy-ins, rebuys and add-ons kept back, 0-100. */
  feePercent?: number;
  /** Added money on top. */
  added?: number;
}

export interface PrizeCounts {
  entries: number;
  rebuys?: number;
  addOns?: number;
}

export function prizePool(money: PrizeMoney, counts: PrizeCounts): number {
  const gross = counts.entries * money.buyIn + (counts.rebuys ?? 0) * (money.rebuy ?? 0) + (counts.addOns ?? 0) * (money.addOn ?? 0);
  const fee = Math.min(100, Math.max(0, money.feePercent ?? 0));
  return Math.floor((gross * (100 - fee)) / 100) + (money.added ?? 0);
}

const cents = (n: number) => Math.round(n * 100);

/**
 * Checks a structure. Ranges must be in order with no gaps or overlaps and
 * cover 2 up to `maxEntries` (ending by MAX_PAYOUT_ENTRIES); each range must pay no more places than its
 * smallest entry count, percents must not increase, and each range sums to 100.
 * At most MAX_PAYOUT_RANGES ranges, each paying at most MAX_PAID_PLACES places.
 */
export function validatePayoutStructure(s: PayoutStructure, maxEntries: number): string[] {
  const errors: string[] = [];
  if (!Array.isArray(s?.ranges) || !s.ranges.length) return ['Add at least one range'];
  if (s.ranges.length > MAX_PAYOUT_RANGES) return [`At most ${MAX_PAYOUT_RANGES} ranges`];
  let expectedMin = 2;
  for (const [i, r] of s.ranges.entries()) {
    // Settings arrive from browsers, so a range may not be shaped like one.
    if (r === null || typeof r !== 'object' || !Array.isArray(r.percents) || !r.percents.every((p) => typeof p === 'number')) {
      errors.push(`Range ${i + 1} is not a payout range`);
      return errors;
    }
    const label = `Range ${r.minEntries}-${r.maxEntries}`;
    if (!Number.isInteger(r.minEntries) || !Number.isInteger(r.maxEntries) || r.maxEntries < r.minEntries)
      errors.push(`${label}: invalid entry counts`);
    if (r.minEntries !== expectedMin)
      errors.push(i === 0 ? 'The first range must start at 2 entries' : `${label}: must start at ${expectedMin} (no gaps or overlaps)`);
    if (r.maxEntries > MAX_PAYOUT_ENTRIES) errors.push(`${label}: must end by ${MAX_PAYOUT_ENTRIES.toLocaleString('en-US')} entries`);
    expectedMin = r.maxEntries + 1;
    if (!r.percents.length) errors.push(`${label}: pays nobody`);
    if (r.percents.length > r.minEntries) errors.push(`${label}: pays more places than ${r.minEntries} entries`);
    if (r.percents.length > MAX_PAID_PLACES) errors.push(`${label}: pays more than ${MAX_PAID_PLACES} places`);
    if (r.percents.some((p) => !(p > 0) || Math.abs(p * 100 - cents(p)) > 1e-6))
      errors.push(`${label}: percents must be above 0 with at most two decimals`);
    if (r.percents.some((p, j) => j > 0 && p > r.percents[j - 1])) errors.push(`${label}: a lower place pays more than a higher one`);
    const sum = r.percents.reduce((a, p) => a + cents(p), 0);
    if (sum !== 10000) errors.push(`${label}: percents add up to ${sum / 100}, not 100`);
  }
  if (expectedMin - 1 < maxEntries) errors.push(`Ranges stop at ${expectedMin - 1} entries; they must reach ${maxEntries}`);
  if (s.roundTo !== undefined && !(Number.isInteger(s.roundTo) && s.roundTo >= 1 && s.roundTo <= MAX_ROUND_TO))
    errors.push('Prize rounding must be a whole amount from 1 cent to $1,000');
  return errors;
}

/**
 * The range that pays out for `entries`. The last range carries on past its end: re-entries can take an event
 * past the max entrants its payouts were built for, and that must not leave it paying nobody.
 */
export function rangeFor(s: PayoutStructure, entries: number): PayoutRange | null {
  const found = s.ranges.find((r) => entries >= r.minEntries && entries <= r.maxEntries);
  if (found) return found;
  const last = s.ranges[s.ranges.length - 1];
  return last && entries > last.maxEntries ? last : null;
}

/**
 * Prize for each place (index 0 = 1st). Each place is rounded down and the
 * remainder goes to 1st. With `roundTo`, places below 1st are rounded to the
 * nearest step instead, unless that would leave a place with nothing or pay
 * a place more than the one above it.
 */
export function placePrizes(pool: number, s: PayoutStructure, entries: number): number[] {
  const range = rangeFor(s, entries);
  if (!range || pool <= 0) return [];
  const toFirst = (prizes: number[]) => {
    prizes[0] += pool - prizes.reduce((a, b) => a + b, 0);
    return prizes;
  };
  const step = s.roundTo ?? 0;
  if (step > 0 && range.percents.length > 1) {
    const rounded = toFirst(range.percents.map((p, i) => (i === 0 ? 0 : Math.round((pool * cents(p)) / 10000 / step) * step)));
    if (rounded.every((x, i) => x > 0 && (i === 0 || x <= rounded[i - 1]))) return rounded;
  }
  return toFirst(range.percents.map((p) => Math.floor((pool * cents(p)) / 10000)));
}

/**
 * Prizes for finished places when players can tie (equal places). Tied
 * players split the prizes of every place they occupy; the odd unit goes to
 * the first listed. `places` maps an id to its place (1 = winner).
 */
export function prizesForPlaces(places: Record<string, number>, prizes: number[]): Record<string, number> {
  const byPlace = new Map<number, string[]>();
  for (const [id, place] of Object.entries(places)) byPlace.set(place, [...(byPlace.get(place) ?? []), id]);
  const out: Record<string, number> = {};
  for (const [place, ids] of byPlace) {
    let total = 0;
    for (let k = 0; k < ids.length; k++) total += prizes[place - 1 + k] ?? 0;
    const share = Math.floor(total / ids.length);
    ids.forEach((id, k) => (out[id] = share + (k === 0 ? total - share * ids.length : 0)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presets

/** Percents for `paid` places with weights 1 / place^exponent, rounded to 0.01, remainder to 1st. */
export function curvePercents(paid: number, exponent: number): number[] {
  const weights = Array.from({ length: paid }, (_, i) => 1 / (i + 1) ** exponent);
  const total = weights.reduce((a, b) => a + b, 0);
  const c = weights.map((w) => Math.floor((w / total) * 10000));
  c[0] += 10000 - c.reduce((a, b) => a + b, 0);
  return c.map((x) => x / 100);
}

function fromPaidCounts(name: string, maxEntries: number, paidFor: (entries: number) => number, exponent: number): PayoutStructure {
  const ranges: PayoutRange[] = [];
  for (let n = 2; n <= maxEntries; n++) {
    const paid = Math.min(n, paidFor(n));
    const last = ranges[ranges.length - 1];
    if (last && last.percents.length === paid) last.maxEntries = n;
    else ranges.push({ minEntries: n, maxEntries: n, percents: curvePercents(paid, exponent) });
  }
  return { name, ranges };
}

export type PayoutPresetName = 'rsdp' | 'winner-take-all' | 'top-two' | 'top-three' | 'standard' | 'flat';

/**
 * The group's own payout table (the Payouts tab of the RSDP results sheet):
 * dollars per place for 2 to 50 players at a $20 buy-in. Winner takes all up
 * to 5 players; one more place is paid every 5 players after that.
 */
export const RSDP_PAYOUTS_20: Record<number, number[]> = {
  2: [40], 3: [60], 4: [80], 5: [100],
  6: [85, 35], 7: [95, 45], 8: [105, 55], 9: [115, 65], 10: [125, 75],
  11: [125, 75, 20], 12: [130, 80, 30], 13: [135, 85, 40], 14: [140, 90, 50], 15: [145, 95, 60],
  16: [145, 95, 60, 20], 17: [150, 95, 65, 30], 18: [155, 100, 70, 35], 19: [165, 100, 70, 45], 20: [170, 105, 75, 50],
  21: [170, 105, 75, 50, 20], 22: [175, 105, 80, 50, 30], 23: [180, 110, 80, 55, 35], 24: [185, 115, 80, 60, 40], 25: [195, 115, 85, 60, 45],
  26: [195, 115, 85, 60, 45, 20], 27: [200, 120, 85, 60, 45, 30], 28: [205, 125, 85, 60, 50, 35], 29: [210, 130, 85, 65, 50, 40], 30: [220, 135, 85, 65, 55, 40],
  31: [220, 135, 85, 65, 55, 40, 20], 32: [225, 135, 85, 65, 55, 45, 30], 33: [230, 140, 90, 65, 55, 45, 35], 34: [235, 145, 90, 65, 55, 50, 40], 35: [240, 150, 90, 70, 60, 50, 40],
  36: [240, 150, 90, 70, 60, 50, 40, 20], 37: [250, 155, 90, 70, 60, 50, 40, 25], 38: [255, 155, 95, 70, 60, 50, 45, 30], 39: [265, 155, 95, 70, 65, 55, 45, 30], 40: [270, 160, 95, 75, 65, 55, 45, 35],
  41: [270, 160, 95, 75, 65, 55, 45, 35, 20], 42: [275, 160, 95, 75, 65, 60, 45, 40, 25], 43: [280, 160, 95, 75, 70, 60, 50, 40, 30], 44: [285, 165, 95, 80, 70, 60, 50, 40, 35], 45: [290, 175, 95, 80, 70, 65, 50, 40, 35],
  46: [290, 175, 95, 80, 70, 65, 50, 40, 35, 20], 47: [295, 180, 95, 80, 75, 65, 50, 40, 35, 25], 48: [295, 185, 95, 85, 75, 65, 55, 45, 35, 25], 49: [300, 190, 100, 85, 75, 65, 55, 45, 35, 30], 50: [305, 195, 100, 90, 80, 65, 55, 45, 35, 30],
};

/**
 * The RSDP table as percents (two decimals, adding up to 100), rounded to
 * $5 so a $20 buy-in pays exactly the sheet's amounts. Above 50 entries the
 * 50-player split carries on.
 */
function rsdpPreset(maxEntries: number): PayoutStructure {
  const ranges: PayoutRange[] = [];
  const top = Math.max(...Object.keys(RSDP_PAYOUTS_20).map(Number));
  for (let n = 2; n <= Math.min(maxEntries, top); n++) {
    const amounts = RSDP_PAYOUTS_20[n];
    const c = amounts.map((a) => Math.round((a * 10000) / (n * 20)));
    c[0] += 10000 - c.reduce((a, b) => a + b, 0);
    const percents = c.map((x) => x / 100);
    const last = ranges[ranges.length - 1];
    if (last && last.percents.join() === percents.join()) last.maxEntries = n;
    else ranges.push({ minEntries: n, maxEntries: n, percents });
  }
  ranges[ranges.length - 1].maxEntries = Math.max(ranges[ranges.length - 1].maxEntries, maxEntries);
  return { name: 'rsdp', ranges, roundTo: 500 };
}

/** Standard paid places: 1 up to 4 entries, 2 up to 7, 3 up to 10, then about 15% of the field. */
function standardPaid(n: number): number {
  if (n <= 4) return 1;
  if (n <= 7) return 2;
  if (n <= 10) return 3;
  return Math.max(4, Math.round(n * 0.15));
}

export function payoutPreset(name: PayoutPresetName, maxEntries = 600): PayoutStructure {
  switch (name) {
    case 'rsdp':
      return rsdpPreset(maxEntries);
    case 'winner-take-all':
      return { name, ranges: [{ minEntries: 2, maxEntries, percents: [100] }] };
    case 'top-two':
      return fromPaidCounts(name, maxEntries, (n) => (n < 4 ? 1 : 2), 0.9);
    case 'top-three':
      return fromPaidCounts(name, maxEntries, (n) => (n < 4 ? 1 : n < 6 ? 2 : 3), 0.9);
    case 'standard':
      return fromPaidCounts(name, maxEntries, standardPaid, 0.9);
    case 'flat':
      // About 20% paid, flatter curve.
      return fromPaidCounts(name, maxEntries, (n) => (n <= 4 ? 1 : n <= 6 ? 2 : Math.max(3, Math.round(n * 0.2))), 0.6);
  }
}

// ---------------------------------------------------------------------------
// Final-table deals (TRN-42 improvement)

/** Splits `total` by `weights` into integers that add up exactly (largest remainder). */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

/**
 * Chip chop: each remaining player is guaranteed the lowest remaining prize,
 * and the rest is split by chip count. `prizes` are the prizes still to be
 * paid, best first, one per remaining player.
 */
export function chipChop(stacks: number[], prizes: number[]): number[] {
  const n = stacks.length;
  const remaining = prizes.slice(0, n);
  while (remaining.length < n) remaining.push(0);
  const floor = remaining[n - 1];
  const total = remaining.reduce((a, b) => a + b, 0);
  return apportion(total - floor * n, stacks).map((x) => x + floor);
}

export const MAX_ICM_PLAYERS = 12;

/**
 * Independent Chip Model (Malmuth-Harville) equity per player. Exact, so it
 * is limited to MAX_ICM_PLAYERS (a final table). Results add up to the sum of
 * the prizes paid to the remaining places.
 */
export function icm(stacks: number[], prizes: number[]): number[] {
  const n = stacks.length;
  if (n > MAX_ICM_PLAYERS) throw new Error(`ICM supports at most ${MAX_ICM_PLAYERS} players`);
  const paid = prizes.slice(0, n);
  const equity = new Array<number>(n).fill(0);
  const reach = new Float64Array(1 << n);
  reach[0] = 1;
  for (let mask = 0; mask < 1 << n; mask++) {
    const p = reach[mask];
    if (!p) continue;
    let place = 0;
    let left = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) place++;
      else left += stacks[i];
    }
    if (place >= n) continue;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;
      // Players with no chips can only finish behind everyone with chips.
      const q = left > 0 ? stacks[i] / left : 1 / (n - place);
      if (!q) continue;
      equity[i] += p * q * (paid[place] ?? 0);
      reach[mask | (1 << i)] += p * q;
    }
  }
  return apportion(Math.round(equity.reduce((a, b) => a + b, 0)), equity);
}
