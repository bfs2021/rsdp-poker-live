import type { Award, HandEvent } from '@rsdp/engine/core';
import { getVariant } from '@rsdp/engine/variants';
import type { BotNote, HandRecordView, HandView, SeatView, SharedHandView, TableView, WireCard } from '@rsdp/engine/wire';
import { defaultSettings } from '@rsdp/engine/settings';
import { eventLines, type Fmt } from './format';

/** One step of a replay: the table as it stood, and what just happened. */
export interface Frame {
  seats: Map<number, ReplaySeat>;
  boards: string[][][];
  /** Chips gathered into the middle (excludes bets in front of players). */
  pot: number;
  street: number;
  /** Seat about to act, for the highlight. */
  toAct: number | null;
  awards: Award[];
  done: boolean;
  caption: string;
  /** How many of the hand's events this frame has played. */
  upTo: number;
  /** The bots' reasons for the moves this frame plays (hands that came with them). */
  why: BotNote[];
}

interface ReplaySeat {
  name: string;
  playerId: string;
  stack: number;
  bet: number;
  folded: boolean;
  allIn: boolean;
  cards: { card: string; up: boolean; shown: boolean }[];
  action: string | null;
}

const POST_LABEL: Record<string, string> = {
  ante: 'Ante',
  'big-blind-ante': 'BB ante',
  'small-blind': 'Small blind',
  'big-blind': 'Big blind',
  'dead-small-blind': 'Dead blind',
  'missed-big-blind': 'Missed blind',
  straddle: 'Straddle',
  'bomb-pot': 'Bomb pot',
  'bring-in': 'Bring-in',
};
const ACTION_LABEL: Record<string, string> = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', 'bring-in': 'Bring-in', complete: 'Complete' };

function clone(f: Frame): Frame {
  const seats = new Map<number, ReplaySeat>();
  for (const [k, s] of f.seats) seats.set(k, { ...s, cards: s.cards.map((c) => ({ ...c })) });
  return { ...f, seats, boards: f.boards.map((run) => run.map((b) => [...b])), awards: [...f.awards] };
}

/**
 * How a shared hand link plays back. Whoever opens it is nobody at that table,
 * so nothing calls them "you" or shows the sharer's result as theirs. When the
 * sharer kept their own cards in the link, those are face up from the deal,
 * seen from the sharer's chair; otherwise only shown cards are face up.
 */
export function sharedHandViewer(shared: Pick<SharedHandView, 'hand' | 'sharerSeat'>): { myId: null; sharerSeat: number | null } {
  return { myId: null, sharerSeat: shared.sharerSeat ?? sharerSeatFromCards(shared.hand) };
}

/**
 * The sharer's seat in a link made before links said which it was. A link
 * holds no hidden card but the sharer's own and ones that were shown, so a
 * known card nobody showed is the sharer's. Null when there is none (they hid
 * their cards, or showed every one).
 */
function sharerSeatFromCards(hand: HandRecordView): number | null {
  const shown = new Set(hand.events.flatMap((e) => (e.t === 'show' ? e.cards.map((c) => `${e.seat} ${c}`) : [])));
  const deal = hand.events.find((e) => e.t === 'deal' && e.cards.some((c) => !c.up && c.card !== '??' && !shown.has(`${e.seat} ${c.card}`)));
  return deal?.t === 'deal' ? deal.seat : null;
}

/**
 * Plays a hand's events into frames. Other players' cards stay face down until
 * they are shown, as at the table; your own are face up from the deal, and so
 * are a shared link's sharer's (`sharerSeat`) when someone else watches it.
 */
export function replayFrames(hand: HandRecordView, myId: string | null, fmt: Fmt, sharerSeat: number | null = null): Frame[] {
  const names = new Map(hand.seats.map((s) => [s.seat, s.name]));
  const mySeat = hand.seats.find((s) => s.playerId === myId)?.seat ?? null;
  // The seat whose cards are face up from the deal.
  const ownSeat = mySeat ?? sharerSeat;
  let f: Frame = {
    seats: new Map(
      hand.seats.map((s) => [s.seat, { name: s.name, playerId: s.playerId, stack: s.stack, bet: 0, folded: false, allIn: false, cards: [], action: null }]),
    ),
    boards: [[[]]],
    pot: 0,
    street: 0,
    toAct: null,
    awards: [],
    done: false,
    caption: '',
    upTo: 0,
    why: [],
  };
  const lines = (upTo: number) => eventLines(hand.events.slice(0, upTo), (seat) => names.get(seat) ?? `Seat ${seat + 1}`, fmt, mySeat, sharerSeat);
  const gather = () => {
    for (const s of f.seats.values()) {
      f.pot += s.bet;
      s.bet = 0;
    }
  };
  const frames: Frame[] = [];
  let lineCount = 0;
  hand.events.forEach((e, i) => {
    const prev = hand.events[i - 1];
    // Deals to every seat show as one step.
    const merge = e.t === 'deal' && prev?.t === 'deal' && frames.length > 0;
    f = merge ? f : clone(f);
    apply(f, e, gather, ownSeat);
    f.upTo = i + 1;
    const all = lines(i + 1);
    const fresh = all.slice(lineCount).map((l) => l.replace(/^--- /, ''));
    lineCount = all.length;
    const next = hand.events[i + 1];
    f.toAct = next?.t === 'action' || next?.t === 'draw' ? next.seat : null;
    if (merge) {
      f.caption = [f.caption, ...fresh].filter(Boolean).join(' · ');
      frames[frames.length - 1] = f;
    } else {
      f.caption = fresh.join(' · ');
      frames.push(f);
    }
  });
  // Nothing to see in a frame that changed nothing visible and says nothing.
  const shown = frames.filter((fr, i) => i === 0 || fr.caption || fr.done);
  // Each reason goes on the frame that plays its move, or the next one shown if that one was left out.
  const notes = [...(hand.botNotes ?? [])].sort((a, b) => a.seq - b.seq);
  let from = 0;
  for (const fr of shown) {
    fr.why = notes.filter((n) => n.seq >= from && n.seq < fr.upTo);
    from = fr.upTo;
  }
  return shown;
}

function apply(f: Frame, e: HandEvent, gather: () => void, ownSeat: number | null) {
  const seat = 'seat' in e && typeof e.seat === 'number' ? f.seats.get(e.seat) : undefined;
  switch (e.t) {
    case 'hand-start':
      f.boards = Array.from({ length: 1 }, () => Array.from({ length: e.boards }, () => []));
      break;
    case 'post':
      if (!seat) break;
      seat.stack -= e.amount;
      if (e.live) seat.bet += e.amount;
      else f.pot += e.amount;
      seat.allIn = e.allIn;
      seat.action = POST_LABEL[e.kind] ?? null;
      break;
    case 'deal':
      if (!seat) break;
      for (const c of e.cards) seat.cards.push({ card: c.card, up: c.up, shown: c.up || e.seat === ownSeat });
      break;
    case 'street':
      gather();
      f.street = e.street;
      for (const s of f.seats.values()) if (!s.folded && !s.allIn) s.action = null;
      break;
    case 'run-it':
      // The second run starts from the cards the boards had in common.
      if (e.times === 2 && f.boards.length === 1) f.boards.push(f.boards[0].map((b) => [...b]));
      break;
    case 'board': {
      gather();
      while (f.boards.length <= e.run) f.boards.push(f.boards[0].map((b) => [...b]));
      f.boards[e.run][e.board].push(...e.cards);
      break;
    }
    case 'action':
      if (!seat) break;
      seat.stack -= e.amount;
      if (e.action !== 'check' && e.action !== 'fold') seat.bet = e.to;
      if (e.action === 'fold') seat.folded = true;
      seat.allIn = e.allIn;
      seat.action = e.allIn ? 'All in' : ACTION_LABEL[e.action];
      break;
    case 'draw':
      if (!seat) break;
      if (e.positions) for (const p of e.positions) seat.cards.splice(p, 1);
      else discardUnknown(seat, e.discarded);
      for (const c of e.cards) seat.cards.push({ card: c, up: false, shown: e.seat === ownSeat });
      seat.action = e.discarded ? `Draw ${e.discarded}` : 'Stand pat';
      break;
    case 'uncalled':
      if (!seat) break;
      if (seat.bet >= e.amount) seat.bet -= e.amount;
      else f.pot -= e.amount;
      seat.stack += e.amount;
      break;
    case 'show':
      if (!seat) break;
      for (const c of seat.cards) if (e.cards.includes(c.card)) c.shown = true;
      break;
    case 'muck':
      if (seat) seat.action = 'Muck';
      break;
    case 'award':
      gather();
      if (seat) seat.stack += e.amount;
      f.pot -= e.amount;
      f.awards.push({ seat: e.seat, amount: e.amount, pot: e.pot, run: e.run, board: e.board, half: e.half, handName: e.handName, cards: e.cards } as Award);
      break;
    case 'transfer': {
      const from = e.from === 'house' ? undefined : f.seats.get(e.from);
      const to = e.to === 'house' ? undefined : f.seats.get(e.to);
      if (from) from.stack -= e.amount;
      if (to) to.stack += e.amount;
      // The house's cut comes out of the middle.
      if (e.kind === 'rake' && e.from === 'house') f.pot -= e.amount;
      break;
    }
    case 'hand-end':
      gather();
      for (const [k, v] of Object.entries(e.stacks)) {
        const s = f.seats.get(Number(k));
        if (s) s.stack = v;
      }
      f.pot = 0;
      f.done = true;
      break;
    default:
      break;
  }
}

/**
 * Another player's draw, where only the count is known. At a showdown every
 * card they kept is shown, so the ones still face down are the ones they
 * threw: take those first, then the newest cards.
 */
function discardUnknown(seat: ReplaySeat, count: number) {
  for (let i = seat.cards.length - 1; i >= 0 && count > 0; i--) {
    if (seat.cards[i].card === '??') {
      seat.cards.splice(i, 1);
      count--;
    }
  }
  if (count > 0) seat.cards.splice(seat.cards.length - count, count);
}

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isSeat = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 10;

/**
 * Whether a hand read from a file has the shape the replayer draws from.
 * Files are hand-editable, so this checks before anything renders (and
 * drops any bots' reasons, which a download never has).
 */
export function isReplayable(h: unknown, fmt: Fmt): h is HandRecordView {
  const x = h as HandRecordView;
  if (!x || typeof x !== 'object' || !isNum(x.handNumber) || !isNum(x.startedAt) || typeof x.gameName !== 'string') return false;
  // The bots' reasons are only ever sent to the one person in the hand, and the download leaves them out, so any in a
  // file were written by someone else: never show them as the bots' own.
  delete x.botNotes;
  if (!x.stakes || typeof x.stakes !== 'object' || !Object.values(x.stakes).every((v) => isNum(v) || typeof v === 'boolean' || typeof v === 'string')) return false;
  if (!isSeat(x.button) || !Array.isArray(x.seats) || !x.seats.length || x.seats.length > 10) return false;
  if (!x.seats.every((s) => s && isSeat(s.seat) && typeof s.playerId === 'string' && typeof s.name === 'string' && isNum(s.stack))) return false;
  if (!Array.isArray(x.events) || !x.events.every((e) => e && typeof e === 'object' && typeof e.t === 'string' && (!('seat' in e) || isSeat(e.seat))))
    return false;
  try {
    const frames = replayFrames(x, null, fmt);
    for (const f of frames) frameView('', 0, x, f, null);
    return frames.length > 0;
  } catch {
    return false;
  }
}

/** Stacks once the hand is fully settled, including bounties claimed by showing after it ended. */
export function finalStacks(h: HandRecordView): Record<number, number> | null {
  let end: Record<number, number> | null = null;
  for (const e of h.events) {
    if (e.t === 'hand-end') end = { ...e.stacks };
    else if (e.t === 'transfer' && end) {
      if (e.from !== 'house' && end[e.from] !== undefined) end[e.from] -= e.amount;
      if (e.to !== 'house' && end[e.to] !== undefined) end[e.to] += e.amount;
    }
  }
  return end;
}

/** What a player's stack did over one hand. */
export function handNet(h: HandRecordView, playerId: string): number | null {
  const seat = h.seats.find((s) => s.playerId === playerId);
  const end = finalStacks(h);
  if (!seat || !end || end[seat.seat] === undefined) return null;
  return end[seat.seat] - seat.stack;
}

/**
 * A practice bot keeps its robot in replays. Only the hand's own `bot` mark says who is one (the server sends it for
 * every bot), never the 'bot-' id prefix: a person's id can start with it too.
 */
function replayBot(seat: HandRecordView['seats'][number] | undefined): Pick<SeatView, 'bot'> {
  const b = seat?.bot as { ownerName?: unknown; look?: unknown } | undefined;
  if (!b || typeof b !== 'object') return {};
  return { bot: { ownerId: '', ownerName: typeof b.ownerName === 'string' ? b.ownerName : '', look: Number.isInteger(b.look) ? (b.look as number) : 0 } };
}

/** A TableView for one frame, so the replay is drawn by the same table as live play. */
export function frameView(
  tableName: string,
  seatCount: number,
  hand: HandRecordView,
  frame: Frame,
  myId: string | null,
  felt?: TableView['settings']['table']['felt'],
  /** A shared link's sharer, when someone else watches it: the table is seen from their chair. */
  sharerSeat: number | null = null,
): TableView {
  const n = Math.max(seatCount, ...hand.seats.map((s) => s.seat + 1));
  // The chair the table is seen from: mine, or a shared link's sharer's.
  const chair = hand.seats.find((s) => s.playerId === myId)?.seat ?? sharerSeat;
  const start = hand.events.find((e): e is Extract<HandEvent, { t: 'hand-start' }> => e.t === 'hand-start');
  const gameId = start?.gameId ?? 'nlhe';
  let family: HandView['family'] = 'flop';
  try {
    family = getVariant(gameId).family;
  } catch {
    /* unknown game */
  }
  const seats: (SeatView | null)[] = Array.from({ length: n }, () => null);
  for (const [i, s] of frame.seats) {
    const cards: WireCard[] = s.cards.map((c) => ({ card: c.shown || c.up ? c.card : '??', up: c.up }));
    seats[i] = {
      seat: i,
      playerId: s.playerId,
      name: s.name,
      nitOptIn: false,
      nit: null,
      stack: s.stack,
      sittingOut: false,
      sitOutReason: null,
      online: true,
      inHand: true,
      folded: s.folded,
      allIn: s.allIn && !frame.done,
      bet: s.bet,
      cards,
      lastAction: s.action,
      timeBank: 0,
      leaving: false,
      owesBlinds: false,
      waiting: false,
      waitForBigBlind: false,
      straddle: false,
      won: 0,
      handName: null,
      avatar: null,
      mood: null,
      ...replayBot(hand.seats.find((x) => x.seat === i && x.playerId === s.playerId)),
    };
  }
  const potTotal = frame.pot + [...frame.seats.values()].reduce((a, s) => a + s.bet, 0);
  const settings = defaultSettings('cash');
  if (felt) settings.table.felt = felt;
  return {
    id: 'replay',
    name: tableName,
    mode: 'cash',
    tournamentId: null,
    isHost: false,
    realGame: true,
    powers: [],
    coHosts: [],
    settings,
    pendingSettings: null,
    serverNow: Date.now(),
    ledger: [],
    chat: [],
    log: [],
    settingsLog: [],
    history: [],
    watchers: [],
    waitlist: [],
    offers: [],
    muted: [],
    spectator: null,
    cardsWatched: null,
    fair: { nextCommit: '', handCommit: null, openThrough: 0 },
    bombPotNext: false,
    rabbit: { available: false, cards: null },
    nit: null,
    rakeTotal: null,
    me: { playerId: myId ?? '', seat: chair },
    hostId: '',
    seats,
    started: true,
    paused: false,
    stopAfterHand: false,
    recordsLocked: false,
    legal: null,
    canDraw: null,
    canVoteRunItTwice: false,
    canShow: [],
    turn: null,
    nextHandAt: null,
    upcoming: null,
    level: null,
    requests: [],
    hand: {
      handNumber: hand.handNumber,
      gameId,
      gameName: hand.gameName,
      shortName: hand.gameName,
      family,
      betting: hand.betting,
      stakes: hand.stakes,
      names: Object.fromEntries(hand.seats.map((s) => [s.seat, s.name])),
      phase: frame.done ? 'complete' : 'betting',
      street: frame.street,
      streetName: '',
      button: hand.button,
      buttonDead: false,
      smallBlind: null,
      bigBlind: null,
      boards: frame.boards,
      pots: frame.pot > 0 ? [{ amount: frame.pot, eligible: [] }] : [],
      potTotal,
      toAct: frame.toAct,
      currentBet: 0,
      drawMax: null,
      runItTwice: { offered: false, votes: {}, deadline: null, times: null },
      showdown: frame.done,
      awards: frame.done ? frame.awards : [],
      // Played so far, so the table can tell what has happened (the equity waits for the hands to be shown).
      events: hand.events.slice(0, frame.upTo),
      bombPot: !!start?.bombPot,
    },
  } satisfies TableView;
}

export interface PlayerStats {
  playerId: string;
  name: string;
  hands: number;
  /** Hands with a normal first betting round (bomb pots have none): what VPIP and PFR count over. */
  counted: number;
  /** Put money in voluntarily on the first betting round. */
  vpip: number;
  /** Raised (or bet, or completed) on the first betting round. */
  pfr: number;
  won: number;
  net: number;
  biggestPot: number;
}

/** Per-player numbers over a set of hands: hands dealt, VPIP, PFR, pots won, net. */
export function playerStats(hands: HandRecordView[]): PlayerStats[] {
  const by = new Map<string, PlayerStats>();
  for (const h of hands) {
    const start = new Map(h.seats.map((s) => [s.seat, s.stack]));
    const voluntary = new Set<number>();
    const raised = new Set<number>();
    const winners = new Map<number, number>();
    const bomb = h.events.some((e) => e.t === 'hand-start' && e.bombPot);
    let street = 0;
    for (const e of h.events) {
      if (e.t === 'street') street = e.street;
      if (e.t === 'action' && street === 0 && !bomb) {
        if (e.action === 'call' || e.action === 'bet' || e.action === 'raise' || e.action === 'complete') voluntary.add(e.seat);
        if (e.action === 'bet' || e.action === 'raise' || e.action === 'complete') raised.add(e.seat);
      }
      if (e.t === 'award') winners.set(e.seat, (winners.get(e.seat) ?? 0) + e.amount);
    }
    const end = finalStacks(h);
    for (const s of h.seats) {
      const row = by.get(s.playerId) ?? { playerId: s.playerId, name: s.name, hands: 0, counted: 0, vpip: 0, pfr: 0, won: 0, net: 0, biggestPot: 0 };
      row.name = s.name;
      row.hands++;
      if (!bomb) row.counted++;
      if (voluntary.has(s.seat)) row.vpip++;
      if (raised.has(s.seat)) row.pfr++;
      const w = winners.get(s.seat) ?? 0;
      if (w > 0) {
        row.won++;
        row.biggestPot = Math.max(row.biggestPot, w);
      }
      if (end && end[s.seat] !== undefined) row.net += end[s.seat] - (start.get(s.seat) ?? 0);
      by.set(s.playerId, row);
    }
  }
  return [...by.values()].sort((a, b) => b.net - a.net);
}
