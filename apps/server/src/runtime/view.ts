import { engine, HIDDEN_CARD, variants, type HandState, type PlayerId, type Viewer } from '@rsdp/engine/core';
import { rakeSchema } from '@rsdp/engine/modifiers';
import type { FairRecordView, HandRecordView, HandView, SeatView, TableView } from '@rsdp/engine/wire';
import { cashHandStakes, fairRevealsAt, rabbitCards, type TableRuntime } from './table';
import type { HandRecord, PastHand, RuntimeState } from './types';
import { gameCode, gameTitle } from '@rsdp/engine/variants';
import { spectatorsSeeCards } from '@rsdp/engine/settings';

const CHAT_SHOWN = 100;
const LOG_SHOWN = 60;

/** Everything one person at (or watching) a table may see. */
export function tableView(
  rt: TableRuntime,
  playerId: PlayerId,
  now: number,
  tournamentId: string | null = null,
  /** Everyone with the table open, seated or not. */
  audience: { playerId: PlayerId; name: string }[] = [],
  /** Each player's picture, as SeatView.avatar has it. */
  avatarOf: (playerId: PlayerId) => string | null = () => null,
): TableView {
  const s = rt.state;
  const mySeat = rt.seatOf(playerId);
  const isHost = rt.isHost(playerId);
  const hand = s.hand;
  // The host keeps the live table whether seated or not; everyone else unseated is a spectator.
  const staff = rt.isStaff(playerId);
  const isSpectator = !mySeat && !staff;
  const blocked = isSpectator && !s.settings.spectators.allowed;
  // Only hands dealt since it was turned on: the cards of an earlier one, mucked ones included, stay hidden.
  const seeAll = spectatorsSeeCards(s.settings) && (!hand || hand.input.handNumber >= (s.seeAll?.since ?? 0));
  // Cards follow the player, not the chair: after a seat shuffle or move, or once someone new sits where a player of
  // the last hand sat, the hand still on the table shows each person only the cards they were dealt themselves.
  const myDealtSeat = hand?.seats.find((x) => x.playerId === playerId)?.seat ?? null;
  const viewer: Viewer = { seat: myDealtSeat, seeAll: isSpectator && seeAll };
  const handSeats = new Map((hand?.seats ?? []).map((x) => [x.seat, x]));
  const won = new Map<number, number>();
  const handNames = new Map<number, string>();
  if (hand?.phase === 'complete') {
    for (const a of hand.awards) {
      won.set(a.seat, (won.get(a.seat) ?? 0) + a.amount);
      if (a.handName && !handNames.has(a.seat)) handNames.set(a.seat, a.handName);
    }
  }
  const live = !!hand && hand.phase !== 'complete';
  // While paused the clocks stand still: each one shows what resuming now would give.
  const shift = rt.pausedFor(now);
  const waiting = new Set<number>();
  if (live) for (const seat of s.seats) if (seat && !handSeats.has(seat.seat) && !seat.sittingOut && seat.stack > 0) waiting.add(seat.seat);

  const nitRound = s.sideGames?.nit ?? null;
  const rake = rakeSchema.get(s.settings);
  const seats: (SeatView | null)[] = s.seats.map((seat) => {
    if (!seat) return null;
    const hs = hand ? handSeats.get(seat.seat) : undefined;
    // A seat taken by someone new since the hand began has no part in it.
    const inThisHand = !!hs && hs.playerId === seat.playerId;
    const cards = inThisHand && !blocked ? hs!.cards.map((c, i) => visibleCard(hand!, viewer, seat.seat, c.card, c.up, hs!.shown.includes(i))) : [];
    return {
      seat: seat.seat,
      playerId: seat.playerId,
      name: seat.name,
      stack: inThisHand ? hs!.stack : seat.stack,
      sittingOut: seat.sittingOut,
      sitOutReason: seat.sitOutReason,
      online: rt.isOnline(seat.playerId),
      inHand: inThisHand,
      folded: inThisHand && hs!.folded,
      allIn: inThisHand && hs!.allIn && live,
      bet: inThisHand ? hs!.bet : 0,
      cards,
      lastAction: inThisHand ? hs!.lastAction : null,
      timeBank: seat.timeBank,
      leaving: seat.leaveAfterHand,
      owesBlinds: seat.missedBigBlind || seat.missedSmallBlind,
      waiting: waiting.has(seat.seat) || (seat.isNew && !inThisHand),
      waitForBigBlind: seat.waitForBigBlind,
      straddle: seat.straddle,
      nitOptIn: !!seat.nitOptIn,
      nit: nitRound?.participants.includes(seat.playerId) ? (nitRound.holders.includes(seat.playerId) ? 'holder' : 'clear') : null,
      won: inThisHand ? (won.get(seat.seat) ?? 0) : 0,
      handName: inThisHand ? (handNames.get(seat.seat) ?? null) : null,
      avatar: avatarOf(seat.playerId),
      mood: seat.mood ?? null,
      ...botTag(rt, seat.playerId),
    };
  });

  const myHandSeat = mySeat && hand ? handSeats.get(mySeat.seat) : undefined;
  const mine = myHandSeat && myHandSeat.playerId === playerId ? myHandSeat : undefined;
  const myTurn = live && !s.paused && !!mine && hand!.toAct === mine.seat;
  // Coach tips and the bots' reasons: the server decides (TableRuntime.soloPersonOf at the deal, and again at every
  // request), so all the browser does is show or hide the button. It stays on after the hand, until the next deal.
  const tips = !!hand && !!mine && s.coach?.handNumber === hand.input.handNumber && s.coach.person === playerId;
  const settings = s.settings;
  let upcoming: TableView['upcoming'] = null;
  if (!live && !rt.tournament) {
    try {
      const setup = previewSetup(rt);
      upcoming = setup;
    } catch {
      upcoming = null;
    }
  }

  return {
    id: s.id,
    name: settings.table.name,
    mode: settings.table.mode,
    tournamentId,
    hostId: s.hostId,
    isHost,
    realGame: !!s.realGame,
    powers: rt.powersOf(playerId),
    coHosts: (s.coHosts ?? []).map((c) => ({ ...c, powers: [...c.powers] })),
    me: { playerId, seat: mySeat?.seat ?? null, canSitIn: rt.canSitIn(playerId) },
    settings,
    pendingSettings: s.pendingSettings,
    started: s.started,
    paused: s.paused,
    stopAfterHand: s.stopAfterHand,
    recordsLocked: rt.recordsLocked(playerId),
    seats,
    hand: hand && !blocked ? handView(rt, hand, viewer, now) : null,
    legal: myTurn && hand!.phase === 'betting' ? engine.legalActions(hand!, mine!.seat) : null,
    canDraw: myTurn && hand!.phase === 'drawing' ? { max: hand!.input.game.streets[hand!.street].drawMaxDiscard ?? 0 } : null,
    canVoteRunItTwice: live && !s.paused && hand!.phase === 'rit-vote' && !!mine && !mine.folded && mine.ritVote === null,
    canShow: hand?.phase === 'complete' && mine ? showable(hand, mine.seat) : [],
    ...(tips ? { tips: true } : {}),
    turn: live && s.turn ? { seat: s.turn.seat, startedAt: s.turn.startedAt + shift, deadline: rt.turnDeadline(now), usingBank: s.turn.usingBank } : null,
    nextHandAt: s.nextHandAt,
    serverNow: now,
    bombPotNext: !!s.sideGames?.bombPotNext,
    rabbit: rabbitView(rt, playerId),
    nit: nitRound ? { prize: nitRound.prize, participants: nitRound.participants.length, holders: nitRound.holders.length } : null,
    rakeTotal: rake.enabled || s.sideGames?.rakeTotal ? (staff || rake.visibleTo === 'everyone' ? (s.sideGames?.rakeTotal ?? 0) : null) : null,
    upcoming,
    level: levelView(rt, now),
    // Besides their own, a player sees the requests of bots they added, so they can take them back.
    requests: (rt.can(playerId, 'approve') ? s.requests : s.requests.filter((r) => r.playerId === playerId || rt.botInfo(r.playerId)?.ownerId === playerId)).map((r) => {
      const bot = rt.botInfo(r.playerId);
      return { ...r, ...(bot ? { bot: { ownerId: bot.ownerId, ownerName: bot.ownerName, level: bot.level ?? 'normal' } } : {}) };
    }),
    // Bot rows are flagged: they play for nothing, so settle-up pays only between people.
    ledger: Object.values(s.ledger).map((row) => {
      const seat = rt.seatOf(row.playerId);
      const stack = seat ? seat.stack + seat.pendingChips : 0;
      return { ...row, stack, net: stack + row.cashOut - row.buyIn };
    }),
    chat: s.chat.slice(-CHAT_SHOWN),
    log: s.log.slice(-LOG_SHOWN),
    settingsLog: s.settingsLog.slice(-20).map((e) => ({ ...e, by: rt.nameOf(e.by) })),
    history: s.history.map((h) => ({ handNumber: h.handNumber, endedAt: h.endedAt, gameName: gameTitle(h.hand.input.game.id, h.hand.input.betting) })),
    watchers: audience.filter((a) => !rt.seatOf(a.playerId)),
    waitlist: (s.waitlist ?? []).map((w) => ({ playerId: w.playerId, name: w.name })),
    offers: (s.offers ?? []).map((o) => ({ ...o, name: s.waitlist?.find((w) => w.playerId === o.playerId)?.name ?? rt.nameOf(o.playerId) })),
    muted: [...(s.muted ?? [])],
    cardsWatched: spectatorsSeeCards(settings)
      ? {
          delaySeconds: settings.spectators.delaySeconds,
          at: s.seeAll?.at ?? 0,
          watchers: audience.filter((a) => !rt.seatOf(a.playerId) && !rt.isStaff(a.playerId)).length,
        }
      : null,
    spectator: isSpectator ? { delaySeconds: s.settings.spectators.delaySeconds, seeAll: viewer.seeAll, blocked } : null,
    fair: { nextCommit: rt.nextCommit(), handCommit: hand?.input.fair?.commit ?? null, openThrough: rt.fairOpenThrough() },
  };
}

/** The part of a spectator's view that runs behind the table. */
export type DelayedPart = Pick<TableView, 'seats' | 'hand' | 'turn' | 'ledger' | 'history' | 'nextHandAt' | 'upcoming' | 'paused' | 'serverNow' | 'fair' | 'bombPotNext' | 'nit' | 'rakeTotal' | 'started' | 'stopAfterHand'>;

/**
 * The ledger, hand list, next-hand countdown and fair-dealing commits run behind too, or they would give away
 * how (and when) a hand ends: a new commit shows up the moment the live hand finishes.
 */
export const delayedPart = (view: TableView): DelayedPart => ({
  seats: view.seats,
  hand: view.hand,
  turn: view.turn,
  ledger: view.ledger,
  history: view.history,
  nextHandAt: view.nextHandAt,
  upcoming: view.upcoming,
  paused: view.paused,
  serverNow: view.serverNow,
  fair: view.fair,
  // These change as the live hand ends or the next is dealt, so they would tell how it went too.
  bombPotNext: view.bombPotNext,
  nit: view.nit,
  rakeTotal: view.rakeTotal,
  started: view.started,
  stopAfterHand: view.stopAfterHand,
});

/** What a spectator on a delay sees of the next hand's commit before anything is old enough to show. */
const NO_FAIR: TableView['fair'] = { nextCommit: '', handCommit: null, openThrough: 0 };
/** Spectators on a delay can't rabbit hunt: the button would show when the live hand ended (app.ts refuses it too). */
const NO_RABBIT: TableView['rabbit'] = { available: false, cards: null };

/**
 * A spectator's view with the table as it was `delayMs` ago: seats, cards,
 * bets and the clock come from `past` (null when nothing is that old yet,
 * which shows the seats with no hand). Clocks move forward by the delay so
 * they count down in step with the live server clock. Chat, the log and
 * everything else stay live.
 */
export function behind(live: TableView, past: DelayedPart | null, delayMs: number): TableView {
  // The table log runs behind too: "X left with 2350" would tell how the hand went.
  const log = live.log.filter((l) => l.at <= live.serverNow - delayMs);
  if (!past) {
    const seats = live.seats.map((x) => x && { ...x, cards: [], bet: 0, inHand: false, folded: false, allIn: false, lastAction: null, won: 0, handName: null });
    return { ...live, seats, hand: null, turn: null, log, nextHandAt: null, upcoming: null, history: [], ledger: [], fair: NO_FAIR, rabbit: NO_RABBIT };
  }
  // A paused snapshot's clocks stand still: they move on with the time shown, not by the delay.
  const move = past.paused ? live.serverNow - past.serverNow : delayMs;
  const later = (t: number | null) => (t === null ? null : t + move);
  const turn = past.turn && { ...past.turn, startedAt: past.turn.startedAt + move, deadline: later(past.turn.deadline) };
  const hand = past.hand && { ...past.hand, runItTwice: { ...past.hand.runItTwice, deadline: later(past.hand.runItTwice.deadline) } };
  // Whoever has sat down since still shows in their seat, without cards. A seat emptied since still shows who sat
  // there then: players who bust, are knocked out or leave go when the live hand ends, which would give it away.
  const seats = live.seats.map((x, i) => {
    const then = past.seats[i];
    if (!x) return then;
    return then && then.playerId === x.playerId ? then : { ...x, cards: [], bet: 0, inHand: false, folded: false, allIn: false, lastAction: null, won: 0, handName: null };
  });
  return {
    ...live,
    seats,
    hand,
    turn,
    log,
    ledger: past.ledger,
    history: past.history,
    nextHandAt: later(past.nextHandAt),
    upcoming: past.upcoming,
    paused: past.paused,
    fair: past.fair,
    bombPotNext: past.bombPotNext,
    nit: past.nit,
    rakeTotal: past.rakeTotal,
    started: past.started,
    stopAfterHand: past.stopAfterHand,
    rabbit: NO_RABBIT,
  };
}

function botTag(rt: TableRuntime, playerId: PlayerId): Pick<SeatView, 'bot'> {
  const bot = rt.botInfo(playerId);
  return bot ? { bot: { ownerId: bot.ownerId, ownerName: bot.ownerName, look: bot.look ?? 0, level: bot.level ?? 'normal' } } : {};
}

function rabbitView(rt: TableRuntime, playerId: PlayerId): TableView['rabbit'] {
  const s = rt.state;
  const cards = s.hand ? rabbitCards(s.hand, s.settings.play.rabbitHunt) : null;
  if (!cards) return { available: false, cards: null };
  const asked = s.rabbit?.handNumber === s.hand!.input.handNumber && s.rabbit.playerIds.includes(playerId);
  return { available: true, cards: asked ? cards : null };
}

function visibleCard(hand: HandState, viewer: Viewer, seat: number, card: string, up: boolean, shown: boolean) {
  const visible = up || shown || viewer.seeAll || viewer.seat === seat;
  return { card: visible ? card : HIDDEN_CARD, up };
}

function showable(hand: HandState, seat: number) {
  const hs = hand.seats.find((x) => x.seat === seat);
  if (!hs) return [];
  if (hs.folded && hand.input.game.family === 'draw') return [];
  return hs.cards.map((_, i) => i).filter((i) => !hs.shown.includes(i) && !hs.cards[i].up);
}

function handView(rt: TableRuntime, hand: HandState, viewer: Viewer, now: number): HandView {
  const s = rt.state;
  const { input } = hand;
  const runItTwiceEvent = [...hand.events].reverse().find((e) => e.t === 'run-it');
  const offered = hand.events.some((e) => e.t === 'rit-offer');
  const street = input.game.streets[hand.street];
  return {
    handNumber: input.handNumber,
    ...(input.fair ? { fair: { commit: input.fair.commit, clientSeeds: input.fair.clientSeeds.map((c) => ({ ...c })) } } : {}),
    gameId: input.game.id,
    gameName: gameTitle(input.game.id, input.betting),
    shortName: gameCode(input.game.id, input.betting),
    family: input.game.family,
    betting: input.betting,
    stakes: input.stakes,
    names: Object.fromEntries(hand.seats.map((x) => [x.seat, rt.nameOf(x.playerId)])),
    phase: hand.phase,
    street: hand.street,
    streetName: street?.name ?? '',
    button: input.button,
    buttonDead: input.buttonDead,
    smallBlind: s.positions?.smallBlind ?? null,
    bigBlind: s.positions?.bigBlind ?? null,
    boards: hand.runs.map((run) => run.map((b) => [...b])),
    pots: engine.pots({ ...hand, seats: hand.seats.map((x) => ({ ...x, total: x.total - x.bet })) }),
    potTotal: hand.seats.reduce((a, x) => a + x.total, 0),
    toAct: hand.phase === 'complete' ? null : hand.toAct,
    currentBet: hand.currentBet,
    drawMax: hand.phase === 'drawing' ? (street?.drawMaxDiscard ?? null) : null,
    runItTwice: {
      offered,
      votes: Object.fromEntries(hand.seats.filter((x) => !x.folded).map((x) => [x.seat, x.ritVote])),
      deadline: rt.ritDeadlineShown(now),
      times: runItTwiceEvent && runItTwiceEvent.t === 'run-it' ? runItTwiceEvent.times : null,
    },
    showdown: hand.showdown,
    bombPot: input.options.bombPot,
    awards: hand.phase === 'complete' ? hand.awards : [],
    events: engine.visibleEvents(hand, viewer),
  };
}

/** Game and stakes of the next cash hand, without moving the blind schedule. */
function previewSetup(rt: TableRuntime): TableView['upcoming'] {
  const settings = rt.state.settings;
  const rot = settings.game.rotation;
  const step = rot.enabled && rot.steps.length ? rot.steps[rt.previewRotationStep() % rot.steps.length] : null;
  const game = variants.get(step?.gameId ?? settings.game.gameId).spec;
  const stakes = cashHandStakes(settings, Math.min(rt.state.level.index, settings.blindSchedule.levels.length - 1), game);
  const betting = step?.betting ?? settings.game.betting;
  return { gameId: game.id, gameName: gameTitle(game.id, betting), betting, stakes };
}

function levelView(rt: TableRuntime, now: number): TableView['level'] {
  const s = rt.state;
  const sched = s.settings.blindSchedule;
  if (!sched.enabled || !sched.levels.length) return null;
  const index = Math.min(s.level.index, sched.levels.length - 1);
  const level = sched.levels[index];
  const last = index === sched.levels.length - 1;
  if (sched.countdown === 'hands') return { index, count: sched.levels.length, endsAt: null, handsLeft: last ? null : Math.max(0, level.hands - s.level.hands) };
  const elapsed = s.level.elapsedMs + (s.level.runningSince !== null ? now - s.level.runningSince : 0);
  const endsAt = last || s.level.runningSince === null ? null : now + Math.max(0, level.minutes * 60_000 - elapsed);
  return { index, count: sched.levels.length, endsAt, handsLeft: null };
}

/** The parts of a finished hand that history keeps. */
export function pastHand(record: HandRecord): PastHand {
  const { hand } = record;
  return {
    handNumber: record.handNumber,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    gameName: gameTitle(hand.input.game.id, hand.input.betting),
    betting: hand.input.betting,
    stakes: hand.input.stakes,
    button: hand.input.button,
    seats: hand.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, startStack: x.startStack })),
    events: hand.events,
    handId: hand.input.handId,
    fair: hand.input.fair,
    ...(record.coach ? { coach: { person: record.coach.person, notes: record.coach.notes.map((n) => ({ ...n })) } } : {}),
  };
}

/** A finished hand as one person may see it (their own cards, and whatever was shown). */
export function handRecordView(rt: TableRuntime, record: HandRecord | PastHand, playerId: PlayerId, opts: { hideMine?: boolean; notes?: boolean } = {}): HandRecordView {
  const past = 'hand' in record ? pastHand(record) : record;
  // hideMine: as someone who wasn't in the hand sees it, so only shown cards are face up.
  const seat = opts.hideMine ? null : (past.seats.find((x) => x.playerId === playerId)?.seat ?? null);
  // Why the bots played as they did, for the one person in the hand, and only where the caller asks: a caller that
  // doesn't (a share link, a full-log download) shows none.
  const notes = opts.notes && !opts.hideMine && past.coach?.person === playerId ? past.coach.notes : [];
  return {
    handNumber: past.handNumber,
    startedAt: past.startedAt,
    endedAt: past.endedAt,
    gameName: past.gameName,
    betting: past.betting,
    stakes: past.stakes,
    button: past.button,
    seats: past.seats.map((x) => {
      const bot = rt.botBadge(x.playerId);
      return { seat: x.seat, playerId: x.playerId, name: rt.nameOf(x.playerId), stack: x.startStack, ...(bot ? { bot } : {}) };
    }),
    // Only events matter for what a viewer may see; the rest of the hand state is not kept.
    events: engine.visibleEvents({ events: past.events } as HandState, { seat, seeAll: false }),
    // Hiding my cards would be undone by the seeds, which rebuild the whole deck.
    fair: opts.hideMine ? null : fairRecordView(past, rt.fairRevealsAt(past.handNumber, past.endedAt), rt.now(), (id) => rt.nameOf(id)),
    ...(notes.length ? { botNotes: notes.map((n) => ({ ...n })) } : {}),
  };
}

function fairRecordView(past: PastHand, revealsAt: number, now: number, nameOf: (id: PlayerId) => string): FairRecordView | null {
  const { fair, handId } = past;
  if (!fair || !handId) return null;
  const revealed = now >= revealsAt;
  return {
    version: fair.version,
    handId,
    commit: fair.commit,
    clientSeeds: fair.clientSeeds.map((c) => ({ ...c, name: nameOf(c.playerId) })),
    serverSeed: revealed ? fair.serverSeed : null,
    handSeed: revealed ? fair.handSeed : null,
    revealsAt: revealed ? null : revealsAt,
    events: revealed ? past.events : null,
  };
}

/**
 * A saved hand as one player may see it, from the table's saved state rather
 * than a running table (hand search reads many tables). Names and bots come
 * from the snapshot. With `now`, the fairness record comes too (revealed as
 * the table would reveal it); a share link never carries it.
 */
export function savedHandView(
  state: Partial<Pick<RuntimeState, 'seats' | 'ledger' | 'handNames' | 'bots' | 'fair'>> | undefined,
  past: PastHand,
  playerId: PlayerId,
  opts: { hideMine?: boolean; now?: number } = {},
): HandRecordView {
  const nameOf = (id: PlayerId) => state?.seats?.find((x) => x?.playerId === id)?.name ?? state?.ledger?.[id]?.name ?? state?.handNames?.[id] ?? 'Guest';
  const botOf = (id: PlayerId) => {
    const bot = state?.bots?.[id];
    if (bot) return { ownerName: bot.ownerName, look: bot.look ?? 0 };
    // As TableRuntime.botBadge: the table's bots and the ledger rows bots keep for good (bots have had flagged rows
    // since they came), never the 'bot-' prefix, which a person's id may have too.
    const row = state?.ledger?.[id];
    return row?.bot ? { ownerName: row.owner ?? '', look: row.look ?? 0 } : null;
  };
  const seat = opts.hideMine ? null : (past.seats.find((x) => x.playerId === playerId)?.seat ?? null);
  return {
    handNumber: past.handNumber,
    startedAt: past.startedAt,
    endedAt: past.endedAt,
    gameName: past.gameName,
    betting: past.betting,
    stakes: past.stakes,
    button: past.button,
    seats: past.seats.map((x) => {
      const bot = botOf(x.playerId);
      return { seat: x.seat, playerId: x.playerId, name: nameOf(x.playerId), stack: x.startStack, ...(bot ? { bot } : {}) };
    }),
    events: engine.visibleEvents({ events: past.events } as HandState, { seat, seeAll: false }),
    fair:
      opts.now === undefined || opts.hideMine
        ? null
        : fairRecordView(past, fairRevealsAt(state?.fair, past.handNumber, past.endedAt), opts.now, nameOf),
  };
}
