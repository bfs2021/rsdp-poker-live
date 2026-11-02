import type { TableView } from '@rsdp/engine/wire';
import { socket } from './socket';

// Provably fair dealing (docs/FAIRNESS.md): while seated, this browser adds its
// own random seed to every hand, answering the commitment the table published
// for it. It remembers the seeds the server accepted, and the hole cards it was
// dealt, so it can tell later if either was tampered with.

const SEEDS = 'rsdp.fairSeeds';
const SENT = 'rsdp.fairSent';
/**
 * Every seed this browser made, one storage key each (`<prefix><commit>:<seed>`): two tabs can each make one for the
 * same commitment at the same moment, and separate keys can't overwrite each other the way one shared map could.
 */
const MADE = 'rsdp.fairMade:';

function noteMade(commit: string, seed: string) {
  try {
    localStorage.setItem(`${MADE}${commit}:${seed}`, String(Date.now()));
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(MADE)) keys.push(k);
    }
    if (keys.length <= KEEP) return;
    keys.sort((a, b) => Number(localStorage.getItem(a)) - Number(localStorage.getItem(b)));
    for (const k of keys.slice(0, keys.length - KEEP)) localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
}

function madeHere(commit: string, seed: string): boolean {
  try {
    return localStorage.getItem(`${MADE}${commit}:${seed}`) !== null;
  } catch {
    return false;
  }
}
const LIVE = 'rsdp.fairLive';
const NEXT = 'rsdp.fairNextSeen';
const SWAPPED = 'rsdp.fairSwapped';
const KEEP = 300;
/** A seed sent this long before the deal had plenty of time to arrive; leaving it out is not an accident. */
const IN_TIME_MS = 1500;
/** The server waits 2.5 s between showing a commitment and dealing from it (FAIR_LEAD_MS); this leaves room for lag. */
const LEAD_MS = 2000;
/** A page that went this long without running (a frozen tab, a sleeping laptop) may get a backlog of views at once. */
const STALL_MS = 1500;

type Store = Record<string, string>;

function load(key: string): Store {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Store;
  } catch {
    return {};
  }
}

function save(key: string, commit: string, value: string) {
  const all = load(key);
  if (all[commit] === value) return;
  all[commit] = value;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete all[k];
  try {
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* storage blocked: the seed still counts, we just can't point it out later */
  }
}

/** The seed the server accepted from this browser against a commitment, if any. */
export function mySeedFor(commit: string): string | null {
  return load(SEEDS)[commit] ?? null;
}

/** A seed this browser sent against a commitment, and when, whether or not the server answered. */
interface Sent {
  seed: string;
  at: number;
  /** The table it was sent at (older records have none). */
  table?: string;
  /** Who sent it (older records have none). */
  player?: string;
  /** The server turned it down this long after it was sent. */
  rejected?: { after: number };
}

function sentFor(commit: string): Sent | null {
  const raw = load(SENT)[commit];
  return raw ? (JSON.parse(raw) as Sent) : null;
}

/** What this browser saw at the table during the hand dealt from a commitment. */
export interface LiveRecord {
  /** First seen dealt, by this browser's clock. */
  at: number;
  button: number;
  /** Seats dealt in. */
  seats: number[];
  /** Board cards, every run and board. */
  board: string[];
  /** Face-up and shown cards by seat, my own hole cards included. */
  cards: Record<number, string[]>;
  /** Who was dealt in, by seat, as far as this browser saw them still seated (older records have none). */
  players?: Record<number, string>;
  /** Which of them were practice bots (older records have none). */
  bots?: string[];
}

export function liveRecordFor(commit: string): LiveRecord | null {
  const raw = load(LIVE)[commit];
  return raw ? (JSON.parse(raw) as LiveRecord) : null;
}

function recordLive(view: TableView) {
  const hand = view.hand;
  if (!hand?.fair || view.spectator) return;
  const old = liveRecordFor(hand.fair.commit);
  const cards: Record<number, string[]> = { ...old?.cards };
  // Who sat in each seat when dealt in, kept from first sight: a seat taken over later is no longer in the hand.
  const players: Record<number, string> = { ...old?.players };
  const bots = new Set(old?.bots);
  for (const seat of view.seats) {
    if (!seat?.inHand) continue;
    if (!(seat.seat in players) && seat.seat in hand.names) {
      players[seat.seat] = seat.playerId;
      if (seat.bot) bots.add(seat.playerId);
    }
    const seen = seat.cards.map((c) => c.card).filter((c) => c !== '??');
    // Cards only accumulate: a draw replaces some, a mucked hand turns them over.
    cards[seat.seat] = [...new Set([...(cards[seat.seat] ?? []), ...seen])];
  }
  const record: LiveRecord = {
    at: old?.at ?? Date.now(),
    button: hand.button,
    seats: Object.keys(hand.names).map(Number),
    board: [...new Set([...(old?.board ?? []), ...hand.boards.flat(2)])],
    cards,
    players,
    bots: [...bots],
  };
  save(LIVE, hand.fair.commit, JSON.stringify(record));
}

let sent = '';
let sending = '';
/**
 * Notes when this browser saw each commitment appear as a table's next hand's, seated or watching: the deal from it
 * should come well after (seedProblem's "too soon"). That is only known when this page was already showing the table
 * on the same connection, and kept running, before it appeared. A page that opens the table (including after a
 * tournament move) or reconnects with a commitment already up can't tell how long it has been up, and an honest server
 * may deal from it at once, so nothing is noted; nor after the page itself stalled, when views pile up and arrive
 * together. Noted per table, so a commitment shown early at another table can't vouch for this one. One per table
 * page, like watchCommitments; call stop() when done.
 */
export function watchNextSeen(
  socketId: () => string | undefined = () => socket.id,
  now: () => number = Date.now,
  every: (tick: () => void) => () => void = (tick) => {
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  },
) {
  let last: { table: string; socket: string; commit: string } | null = null;
  // A local heartbeat the server can't touch: a gap in it means this page didn't run for a while.
  let beat = now();
  const awake = () => {
    if (now() - beat > STALL_MS) last = null;
    beat = now();
  };
  const stop = every(awake);
  const onView = (view: TableView) => {
    awake();
    const commit = view.fair?.nextCommit;
    const sock = socketId();
    if (!commit || !sock) return;
    const watching = last && last.table === view.id && last.socket === sock;
    const key = `${view.id}#${commit}`;
    if (watching && last!.commit !== commit && !load(NEXT)[key]) save(NEXT, key, String(now()));
    last = { table: view.id, socket: sock, commit };
  };
  return Object.assign(onView, { stop });
}

/** Call with every table view: sends a fresh seed once per published commitment while seated, and notes what the hand showed. */
export function contributeSeed(view: TableView) {
  recordLive(view);
  const commit = view.fair?.nextCommit;
  // Offline, the seed would go out late on reconnecting and could miss its hand through no one's fault.
  if (!commit || view.me.seat === null || commit === sent || commit === sending || !socket.connected) return;
  // Another tab of this browser, or this page before a reload, already made a seed for this commitment: send that
  // same one again (harmless if it got there) rather than a second one the server would keep instead. A refused seed
  // stays refused: a fresh one after a refusal would let a server pick and choose.
  const before = sentFor(commit);
  // Records from before players were noted are taken as mine: a second seed would give the server two to choose from.
  const again = before && (before.player ?? view.me.playerId) === view.me.playerId ? before : null;
  if (again?.rejected) {
    sent = commit;
    return;
  }
  sending = commit;
  const seed = again?.seed ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  if (!again) noteMade(commit, seed);
  // Noted before the answer: a server that holds back its answer and then drops the seed still gets caught. A repeat
  // keeps the first send's time: the server can choose when a second tab sees the commitment.
  const at = Math.min(again?.at ?? Infinity, Date.now());
  const record: Sent = { seed, at, table: view.id, player: view.me.playerId };
  save(SENT, commit, JSON.stringify(record));
  socket.emit('fair:seed', { commit, seed }, (res) => {
    if (sending === commit) sending = '';
    sent = commit;
    if (!res.ok) {
      // A repeat turned down says nothing: the first may have got there in time and been used.
      if (!again) save(SENT, commit, JSON.stringify({ ...record, rejected: { after: Date.now() - at } } satisfies Sent));
      return;
    }
    save(SEEDS, commit, seed);
  });
}

// What a watch noted, recorded against the hands dealt after it: a commitment that was dropped, or one of these.
/** A hand dealt from a commitment this browser never saw offered as the next one. */
const UNSEEN = 'unseen';
/** A hand shown at the table without its commitment. */
const NO_COMMIT = 'no-commit';
/** A hand number shown again from a second commitment (followed by the first one). */
const AGAIN = 'again:';

/** The commitment each hand was shown under at the table, by table and hand number ("Check this hand" compares the record with it). */
const SHOWN = 'rsdp.fairShownAs';

/**
 * Watches one table's commitments while this browser sees it live (seated, or
 * as a spectator with no delay and watching allowed). An honest server
 * publishes each hand's commitment before the hand, deals the hands in the
 * order it published them, and never changes a hand's commitment once shown. A
 * server that dropped a commitment without dealing from it could look at the
 * deck the seeds made and try again; a hand dealt from a commitment never
 * offered, shown without one, or a hand number shown with a second one, would
 * hide the same thing. Each is noted against the hand dealt, and every later
 * hand in the same watch is marked too. The watch is judged from the hands
 * shown, not from any summary field.
 *
 * A server restart honestly starts a fresh commitment but drops every
 * connection, so the watch starts over after a reconnect, on another table,
 * with each new watcher (a page left and opened again, when an idle table may
 * have been put away and reloaded), and when a view that hid the hands (a
 * delayed spectator, or watching turned off) turns live.
 */
export function watchCommitments(socketId: () => string | undefined = () => socket.id) {
  type Watch = { table: string; socket: string; offered: string[]; dealt: Set<string>; shown: Map<number, string>; tainted: string | null; first: number | null };
  let w: Watch | null = null;
  let wasLive = false;
  return (view: TableView) => {
    const live = !view.spectator || (view.spectator.delaySeconds === 0 && !view.spectator.blocked);
    const sock = socketId();
    if (!sock) {
      w = null;
      return;
    }
    if (!w || w.table !== view.id || w.socket !== sock || (live && !wasLive)) {
      w = { table: view.id, socket: sock, offered: [], dealt: new Set(), shown: new Map(), tainted: null, first: view.hand?.handNumber ?? null };
    }
    wasLive = live;
    if (!live) return;
    const watch = w;
    const fresh = watch.offered.length === 0 && watch.dealt.size === 0;
    const flag = (commit: string, from: string) => {
      watch.tainted ??= from;
      save(SWAPPED, commit, watch.tainted);
    };
    const hand = view.hand;
    const commit = hand?.fair?.commit;
    if (hand) {
      // The first commitment a hand number was shown under stays for "Check this hand", never written over. Within one
      // watch a second one is flagged here; across a reconnect it can honestly happen (a crash that lost the save of a
      // deal), so it is left to "Check this hand", which says so.
      const key = `${view.id}#${hand.handNumber}`;
      if (!load(SHOWN)[key]) save(SHOWN, key, commit ?? NO_COMMIT);
      const here = watch.shown.get(hand.handNumber);
      if (here === undefined) watch.shown.set(hand.handNumber, commit ?? NO_COMMIT);
      else if (commit && here !== commit) flag(commit, AGAIN + here);
    }
    // Only a hand dealt before provably fair dealing has none, and it can only be the one in play when the watch began.
    if (hand && !commit && hand.handNumber !== watch.first) watch.tainted ??= NO_COMMIT;
    if (hand && commit) {
      if (!watch.dealt.has(commit)) {
        watch.dealt.add(commit);
        const at = watch.offered.indexOf(commit);
        // Joining mid-hand, the first hand seen was offered before this browser looked.
        if (at < 0 && !fresh) flag(commit, UNSEEN);
        const skipped = watch.offered.slice(0, at < 0 ? watch.offered.length : at).find((c) => !watch.dealt.has(c));
        if (skipped) flag(commit, skipped);
        if (watch.tainted) flag(commit, watch.tainted);
      }
    }
    const next = view.fair?.nextCommit;
    if (next && !watch.offered.includes(next)) watch.offered.push(next);
  };
}

/** What a watch noted against this hand's commitment, if anything (see watchCommitments). */
export function swappedFrom(commit: string): string | null {
  return load(SWAPPED)[commit] ?? null;
}

/** The commitment hand `handNumber` of a table was shown under while this browser watched it live, if it did. */
export function shownAs(tableId: string, handNumber: number): string | null {
  const c = load(SHOWN)[`${tableId}#${handNumber}`];
  return c ? (c === NO_COMMIT ? 'none' : c) : null;
}

const short = (c: string) => `${c.slice(0, 12)}…`;

/** The warning for a hand dealt during or after something a watch noted. */
function swapWarning(commit: string, from: string): string {
  const after = `A server that does that can look at a deck and try again`;
  if (from === UNSEEN) return `this hand (${short(commit)}), or one before it at this table, was dealt from a commitment the table never showed as the next hand's. ${after}`;
  if (from === NO_COMMIT) return `a hand at this table was shown without its commitment, and this hand (${short(commit)}) came after it. ${after}`;
  if (from.startsWith(AGAIN)) return `a hand number at this table was shown again from a different commitment (first ${short(from.slice(AGAIN.length))}, then this hand's or an earlier one's). ${after}`;
  return `the table showed a commitment (${short(from)}) that was never dealt from, and this hand (${short(commit)}) came after it. ${after}`;
}

/**
 * What's wrong with the seed listed under my name for a hand, if anything: a
 * seed this browser sent in good time was left out, or one it never sent was
 * listed (either would let a server steer the deck). Null when all is well.
 * `dealtAt` is when the hand was dealt, by this browser's clock if known.
 */
export function seedProblem(commit: string, listed: { playerId: string; seed: string }[], myId: string, dealtIn: boolean, dealtAt: number | null): string | null {
  const swapped = swappedFrom(commit);
  if (swapped) return swapWarning(commit, swapped);
  const accepted = mySeedFor(commit);
  const sentSeed = sentFor(commit);
  // Every seed listed under my name, not just the first. The table keeps one per player, even with two devices: a
  // second one, even a copy of mine, changes the deck and could be picked after seeing the rest, so it can steer it.
  const mine = listed.filter((c) => c.playerId === myId).map((c) => c.seed);
  if (mine.length > 1) {
    return `${mine.length} seeds were listed under your name (${mine.join(', ')}). The table keeps only one seed per player, even from two devices, so an extra one could have been picked to steer the deck`;
  }
  const under = mine[0];
  const rejected = sentSeed?.rejected;
  if (under && under !== accepted && under !== sentSeed?.seed && !madeHere(commit, under)) {
    // Expected when one player is on two devices (#209): the table keeps only the newest seed. Still shown, as from
    // here a dishonest server would look the same; the wording says which case is harmless.
    return `a seed (${under}) was listed under your name that this browser didn't send. If you're also at this table on another device (a phone and a laptop, say), that's expected and you can ignore it: the table uses only the newest seed from either one. If you aren't, the deck may have been steered`;
  }
  // Another tab's copy of the same seed may have got in first and been accepted.
  if (rejected && under === sentSeed!.seed && under !== accepted) return `the server turned down your browser's seed (${under}) but used it anyway`;
  // Whatever the server answered, it saw the seed: an honest server only refuses one that arrived after the deal, and
  // then this browser sees the hand at about the time it sent it. Seen much later means the seed was there in time.
  const inTime = !!sentSeed && dealtAt !== null && dealtAt - sentSeed.at > IN_TIME_MS;
  if (!under && dealtIn && (accepted || inTime)) {
    return `your browser sent its seed (${accepted ?? sentSeed!.seed}) in good time, but the hand was dealt without it`;
  }
  // Nor may the server show a commitment only at the last moment, so that every seed is "late".
  const nextSeen = sentSeed?.table ? Number(load(NEXT)[`${sentSeed.table}#${commit}`] ?? NaN) : NaN;
  if (!under && dealtIn && sentSeed && dealtAt !== null && dealtAt - nextSeen < LEAD_MS) {
    return `the hand was dealt too soon after its commitment appeared for your browser's seed (${sentSeed.seed}) to count`;
  }
  return null;
}

/** The live warning for the hand in progress, if the seeds listed for it don't add up for me. */
export function liveSeedProblem(view: TableView): string | null {
  const fair = view.hand?.fair;
  if (!fair || view.me.seat === null) return null;
  const live = liveRecordFor(fair.commit);
  const mine = seedProblem(fair.commit, fair.clientSeeds, view.me.playerId, view.me.seat in view.hand!.names, live?.at ?? Date.now());
  // Who was dealt in is known once this browser has seen every seat dealt in still taken (a player may leave mid-hand).
  const seen = Object.keys(live?.players ?? {});
  const dealt = seen.length === Object.keys(view.hand!.names).length ? Object.values(live!.players!) : undefined;
  const bots = [...view.seats.flatMap((s) => (s?.bot ? [s.playerId] : [])), ...(live?.bots ?? [])];
  return mine ?? seedListProblem(fair.clientSeeds, { bots, dealt });
}

/**
 * What "Check this hand" says when the seed list passes. It only says none came from a bot when this browser's own
 * table note backs that: without one, the record's own list of who was dealt in and who is a bot is all there is.
 */
export function seedListPassed(count: number, live: LiveRecord | null): string {
  const seeds = `${count} ${count === 1 ? 'seed' : 'seeds'}`;
  return live?.players
    ? `${seeds}, one per person your browser saw dealt in, none from a bot`
    : `${seeds}, one per person the record shows dealt in, none it marks as a bot (your browser has no note of who was dealt in, so this goes by the record's own list)`;
}

/**
 * seedListProblem for a hand's record, checking first that the record's list of who was dealt in, and which were
 * bots, agrees with what this browser saw at the table, if it was there: otherwise the record could pass off a seed
 * of the server's own as a person's who was never dealt in, or as a bot's it no longer marks as a bot.
 */
export function recordSeedProblem(listed: { playerId: string; seed: string }[], seats: { seat: number; playerId: string; bot?: unknown }[], live: LiveRecord | null): string | null {
  if (live && [...live.seats].sort().join() !== seats.map((s) => s.seat).sort().join()) {
    return "the record's seats dealt in differ from the ones your browser saw at the table, so its list of who should have seeds can't be trusted";
  }
  for (const [seat, id] of Object.entries(live?.players ?? {})) {
    const there = seats.find((s) => s.seat === +seat);
    if (there && there.playerId !== id) return `the record lists someone else in seat ${+seat + 1} than the player your browser saw dealt in there, so its list of who should have seeds can't be trusted`;
  }
  const bots = [...seats.filter((s) => s.bot).map((s) => s.playerId), ...(live?.bots ?? [])];
  return seedListProblem(listed, { bots, dealt: seats.map((s) => s.playerId) });
}

/**
 * Whose each seed is, for the proof file: who the record shows dealt in, marking as bots those it marks and those this
 * browser saw as bots at the table, so scripts/verify-hand.mjs can run the same check as seedListProblem on its own.
 * `seedOwners` is in the order of the proof's `clientSeeds`, which stay bare strings so older copies of the script can
 * still read the file.
 */
export function proofSeeds(listed: { playerId: string; seed: string }[], seats: { seat: number; playerId: string; bot?: unknown }[], live: LiveRecord | null) {
  return {
    clientSeeds: listed.map((c) => c.seed),
    seedOwners: listed.map((c) => c.playerId),
    players: seats.map((s) => ({ seat: s.seat, playerId: s.playerId, ...(s.bot || live?.bots?.includes(s.playerId) ? { bot: true } : {}) })),
  };
}

/**
 * What's wrong with a hand's list of seeds as a whole, whoever's they are, if anything. An honest server lists at most
 * one seed for each person dealt in, none for a practice bot (bots never send one), and fresh random seeds never
 * match. Anything else is an extra seed that nobody's browser checks, so it could have been picked to steer the deck.
 * `dealt` is everyone dealt in, when known.
 */
export function seedListProblem(listed: { playerId: string; seed: string }[], who: { bots: string[]; dealt?: string[] }): string | null {
  const ids = new Set<string>();
  const seeds = new Set<string>();
  for (const c of listed) {
    if (who.bots.includes(c.playerId)) return `a seed (${c.seed}) was listed for a practice bot, but bots don't send seeds, so it could have been picked to steer the deck`;
    if (who.dealt && !who.dealt.includes(c.playerId)) return `a seed (${c.seed}) was listed for someone who wasn't dealt in, so nobody checks it and it could have been picked to steer the deck`;
    if (ids.has(c.playerId)) return `more than one seed was listed for the same player, but the table keeps only one each, so an extra one could have been picked to steer the deck`;
    if (seeds.has(c.seed)) return `the same seed (${c.seed}) was listed twice, which fresh random seeds never do; a copy changes the deck, so it could have been added to steer it`;
    ids.add(c.playerId);
    seeds.add(c.seed);
  }
  return null;
}
