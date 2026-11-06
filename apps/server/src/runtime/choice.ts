/**
 * Dealer's choice (D31): players take turns choosing the game.
 *
 * A Pick chip, separate from the dealer button, sits with the next chooser.
 * Each pick lasts one orbit (as many hands as were dealt into its first hand,
 * fewer if players leave) or a set number of hands. Once the last hand of a
 * pick is dealt, the chooser may pick the next game at any time. The pick
 * clock starts when the next hand is due and the table waits for it; when it
 * runs out the current game carries on (or the first game on the menu that
 * fits). A bot holding the chip picks at random from the games that fit.
 *
 * While a game is picked or being played, the table seats nobody beyond that
 * game's limit (seatCap), so a pick never has more players than it can deal.
 *
 * The table runtime owns the state (RuntimeState.choice) and calls in from
 * dealHand (gate, dealt), step (tick), the seating paths (seatCap) and the
 * view (view).
 */
import { variants, type BettingKind, type PlayerId } from '@rsdp/engine/core';
import type { DealersChoiceSettings, TableSettings } from '@rsdp/engine/settings';
import { gameTitle } from '@rsdp/engine/variants';
import type { ChoicePickView, ChoiceView } from '@rsdp/engine/wire';
import type { ChoiceState, ChoicePick, RuntimeState, SeatState } from './types';

/** How long a bot holding the Pick chip waits before it picks, so people see it happen. */
export const BOT_PICK_MS = 1500;

/** What the runtime lends Dealer's choice. */
export interface ChoiceHost {
  readonly state: RuntimeState;
  now(): number;
  rng(n: number): number;
  isBot(playerId: PlayerId): boolean;
  /** Seated, not sitting out, with chips (or a bot) and not offline past the grace time. */
  canPick(seat: SeatState): boolean;
  /** Seated players plus seats held for someone (a waitlist offer, a seat request). */
  tableCount(): number;
  log(text: string): void;
}

/** The menu of a cash table playing Dealer's choice, or null when it isn't. */
export function choiceMenu(settings: TableSettings): DealersChoiceSettings | null {
  const dc = settings.game.dealersChoice;
  if (!dc?.enabled || settings.table.mode !== 'cash' || dc.games.length < 2) return null;
  if (settings.game.rotation.enabled) return null;
  return dc;
}

/** Most players a game seats (0 for an unknown game, which then never fits). */
export function seatsOf(gameId: string): number {
  try {
    return variants.get(gameId).spec.maxPlayers;
  } catch {
    return 0;
  }
}

const same = (a: { gameId: string; betting: BettingKind }, b: { gameId: string; betting: BettingKind }) => a.gameId === b.gameId && a.betting === b.betting;

export class DealersChoice {
  constructor(private readonly host: ChoiceHost) {}

  private get s() {
    return this.host.state;
  }

  get menu() {
    return choiceMenu(this.s.settings);
  }

  /** The state, made on first use. The chip starts with the next button, or with a random player at a fresh table. */
  private ensure(candidates: SeatState[]): ChoiceState {
    const s = this.s;
    if (s.choice) return s.choice;
    let chip: number;
    let firstButton: number | null = null;
    if (s.positions) chip = this.seatAfter(s.positions.button);
    else {
      chip = candidates[this.host.rng(candidates.length)].seat;
      firstButton = chip;
    }
    s.choice = { chip, firstButton, current: null, hands: 0, length: 0, next: null, deadline: null, clockFor: null, botAt: null };
    return s.choice;
  }

  /** At a table that hasn't dealt yet: where the first hand's button goes (on the first chooser). */
  firstButton(candidates: SeatState[]): number | null {
    if (!this.menu || this.s.positions) return null;
    const c = this.ensure(candidates);
    return c.firstButton !== null && candidates.some((x) => x.seat === c.firstButton) ? c.firstButton : null;
  }

  /** The next seat round from `seat` (to the left) with somebody in it, or `seat + 1` at an empty table. */
  private seatAfter(seat: number): number {
    const n = this.s.seats.length;
    for (let i = 1; i <= n; i++) {
      const at = (seat + i) % n;
      if (this.s.seats[at]) return at;
    }
    return (seat + 1) % n;
  }

  /** Who picks next: the chip's seat, or the first player to its left who can pick. Null if nobody can. */
  chooser(): SeatState | null {
    const c = this.s.choice;
    if (!c) return null;
    const n = this.s.seats.length;
    for (let i = 0; i < n; i++) {
      const seat = this.s.seats[(c.chip + i) % n];
      if (seat && this.host.canPick(seat)) return seat;
    }
    return null;
  }

  /** The game being played: the current pick, or the table's own game before the first. */
  private currentGame(): { gameId: string; betting: BettingKind } {
    return this.s.choice?.current ?? { gameId: this.s.settings.game.gameId, betting: this.s.settings.game.betting };
  }

  /**
   * The game a missed pick can keep: the current pick, or at a table that was already playing when Dealer's choice
   * was turned on, the game it was playing. Null at a new table, where the first pick has nothing to keep.
   */
  private keepable(): { gameId: string; betting: BettingKind } | null {
    return this.s.choice?.current ?? (this.s.handNumber > 0 ? this.currentGame() : null);
  }

  /** A game fits when everyone sitting down, and anyone a seat is held for, can be dealt in. */
  fits(gameId: string, count = this.host.tableCount()): boolean {
    return seatsOf(gameId) >= count;
  }

  /** Index of the menu entry a missed pick deals: the current game if it's on the menu and fits, else the first that fits. */
  defaultIndex(): number {
    const menu = this.menu!;
    const count = this.host.tableCount();
    const cur = this.keepable();
    const kept = cur ? menu.games.findIndex((g) => same(g, cur) && this.fits(g.gameId, count)) : -1;
    if (kept >= 0) return kept;
    const first = menu.games.findIndex((g) => this.fits(g.gameId, count));
    // The table never has more seats than the menu's biggest game (checkSettings), so one fits; if not, the biggest.
    if (first >= 0) return first;
    return menu.games.reduce((best, g, i) => (seatsOf(g.gameId) > seatsOf(menu.games[best].gameId) ? i : best), 0);
  }

  /** The current game can be kept on purpose ("Keep playing"): it is on the menu and fits. */
  canKeep(): boolean {
    const menu = this.menu;
    const cur = this.keepable();
    if (!menu || !cur) return false;
    return menu.games.some((g) => same(g, cur) && this.fits(g.gameId));
  }

  /** The current pick has had all its hands. A pick that hasn't dealt yet hasn't. */
  private pickDone(dealtIn: number | null): boolean {
    const c = this.s.choice;
    if (!c || !c.current) return true;
    if (c.hands === 0) return false;
    const length = dealtIn === null || this.menu?.hands ? c.length : Math.min(c.length, dealtIn);
    return c.hands >= length;
  }

  /**
   * The chooser may pick now: the last hand of the current pick has been dealt (or the pick is over), and
   * nobody has picked the next game yet.
   */
  pickOpen(): boolean {
    const c = this.s.choice;
    if (!this.menu || !c || c.next) return false;
    return this.pickDone(null);
  }

  /**
   * Before a hand is dealt. 'go': deal the current game. 'changed': a new pick starts with this hand, so plan
   * again. 'wait': the chooser is still picking (s.nextHandAt is set to when their clock runs out).
   */
  gate(candidates: SeatState[], dealtIn: number): 'go' | 'changed' | 'wait' {
    const menu = this.menu;
    const s = this.s;
    // Turned off: forget the chip, so turning it on again starts afresh.
    if (!menu) {
      if (s.choice) s.choice = undefined;
      return 'go';
    }
    const now = this.host.now();
    const c = this.ensure(candidates);
    if (!this.pickDone(dealtIn)) return 'go';
    if (c.next) {
      this.start(c.next);
      return 'changed';
    }
    const chooser = this.chooser();
    if (!chooser) {
      // Nobody can pick: the current game carries on and the chip stays for when they're back.
      const g = menu.games[this.defaultIndex()];
      const cur = this.keepable();
      const kept = !!cur && same(g, cur);
      this.host.log(`Nobody can pick the next game, so ${gameTitle(g.gameId, g.betting)} ${kept ? 'carries on' : 'is dealt'}`);
      this.start({ gameId: g.gameId, betting: g.betting, by: null, seat: null, how: kept ? 'kept' : 'default' });
      return 'changed';
    }
    if (c.deadline === null || c.clockFor !== chooser.playerId) {
      this.startClock(chooser);
      s.nextHandAt = c.deadline;
      return 'wait';
    }
    if (now < c.deadline) {
      s.nextHandAt = c.deadline;
      return 'wait';
    }
    // Out of time: the current game carries on, or the first on the menu that fits.
    const g = menu.games[this.defaultIndex()];
    const cur = this.keepable();
    const kept = !!cur && same(g, cur);
    this.host.log(`${chooser.name} didn't pick in time, so ${gameTitle(g.gameId, g.betting)} ${kept ? 'carries on' : 'is dealt'}`);
    this.passChip(chooser.seat);
    this.start({ gameId: g.gameId, betting: g.betting, by: chooser.name, seat: chooser.seat, how: kept ? 'kept' : 'default' });
    return 'changed';
  }

  /** A hand was dealt (bomb pots included): counts it toward the pick, and opens picking on its last hand. */
  dealt(dealtIn: number) {
    const c = this.s.choice;
    if (!this.menu || !c || !c.current) return;
    c.hands++;
    const fixed = this.menu.hands;
    if (c.hands === 1) c.length = fixed || dealtIn;
    else if (!fixed) c.length = Math.min(c.length, dealtIn);
    if (c.hands >= c.length) this.openPick();
  }

  /** Picking opens: a bot holding the chip picks after a moment. */
  private openPick() {
    const c = this.s.choice!;
    const chooser = this.chooser();
    c.botAt = chooser && this.host.isBot(chooser.playerId) ? this.host.now() + BOT_PICK_MS : null;
  }

  private startClock(chooser: SeatState) {
    const c = this.s.choice!;
    const now = this.host.now();
    c.deadline = now + this.menu!.pickSeconds * 1000;
    c.clockFor = chooser.playerId;
    c.botAt = this.host.isBot(chooser.playerId) ? now + BOT_PICK_MS : null;
  }

  private start(pick: ChoicePick) {
    const c = this.s.choice!;
    c.current = pick;
    c.hands = 0;
    c.length = 0;
    c.next = null;
    c.deadline = null;
    c.clockFor = null;
    c.botAt = null;
  }

  /** After a pick (or a missed one) the chip goes to the next player on the left. */
  private passChip(seat: number) {
    this.s.choice!.chip = this.seatAfter(seat);
  }

  /** The chooser picks menu entry `index` (a person, or a bot through tick). */
  pick(playerId: PlayerId, index: number): string | null {
    const menu = this.menu;
    if (!menu) return "this table isn't playing Dealer's choice";
    if (!this.pickOpen()) return "it isn't time to pick the next game yet";
    const chooser = this.chooser();
    if (!chooser || chooser.playerId !== playerId) return "it isn't your pick";
    if (!Number.isInteger(index) || index < 0 || index >= menu.games.length) return 'no such game on the menu';
    const g = menu.games[index];
    if (!this.fits(g.gameId)) return `${gameTitle(g.gameId, g.betting)} seats at most ${seatsOf(g.gameId)} players, and ${this.host.tableCount()} are sitting down`;
    const c = this.s.choice!;
    const cur = this.keepable();
    const kept = !!cur && same(g, cur);
    const bot = this.host.isBot(playerId);
    c.next = { gameId: g.gameId, betting: g.betting, by: chooser.name, seat: chooser.seat, how: bot ? 'bot' : kept ? 'kept' : 'picked' };
    const waiting = c.deadline !== null;
    c.deadline = null;
    c.clockFor = null;
    c.botAt = null;
    this.passChip(chooser.seat);
    const title = gameTitle(g.gameId, g.betting);
    this.host.log(kept ? `${chooser.name} kept ${title} going` : `${chooser.name} picked ${title}`);
    // The table was waiting for this: deal as soon as the clocks allow.
    if (waiting) this.s.nextHandAt = this.host.now();
    return null;
  }

  /**
   * Between and during hands: a bot whose moment has come picks, and a chooser who can't pick any more passes
   * the chip on (the next player gets a fresh clock). True when something changed.
   */
  tick(): boolean {
    const menu = this.menu;
    const c = this.s.choice;
    if (!menu || !c || !this.pickOpen()) return false;
    const now = this.host.now();
    const chooser = this.chooser();
    if (c.deadline !== null && chooser && c.clockFor !== chooser.playerId) {
      this.startClock(chooser);
      this.s.nextHandAt = c.deadline;
      return true;
    }
    // Waiting for a chooser who has gone, with nobody left to pick: deal now (the gate deals the default).
    if (c.deadline !== null && !chooser && this.s.nextHandAt !== now) {
      this.s.nextHandAt = now;
      return true;
    }
    if (!chooser || !this.host.isBot(chooser.playerId)) {
      if (c.botAt !== null) c.botAt = null;
      return false;
    }
    if (c.botAt === null) {
      c.botAt = now + BOT_PICK_MS;
      return true;
    }
    if (now < c.botAt) return false;
    const fitting = menu.games.flatMap((g, i) => (this.fits(g.gameId) ? [i] : []));
    const index = fitting.length ? fitting[this.host.rng(fitting.length)] : this.defaultIndex();
    return this.pick(chooser.playerId, index) === null;
  }

  /** When something here next needs doing (a bot's pick or the clock running out), for the table's timers. */
  due(): number | null {
    const c = this.s.choice;
    if (!this.menu || !c) return null;
    const times = [c.botAt, c.deadline].filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : null;
  }

  /**
   * While a game is picked or being played the table seats nobody beyond its limit: the smaller of the current
   * and the next game. Null for no limit.
   */
  seatCap(): { cap: number; gameId: string; betting: BettingKind } | null {
    const c = this.s.choice;
    if (!this.menu || !c) return null;
    const games = [c.current, c.next].filter((g): g is ChoicePick => !!g);
    if (!games.length) return null;
    const g = games.reduce((a, b) => (seatsOf(b.gameId) < seatsOf(a.gameId) ? b : a));
    return { cap: seatsOf(g.gameId), gameId: g.gameId, betting: g.betting };
  }

  /** The game, betting and who picked it for the hand about to be dealt. */
  setup(): { gameId: string; betting: BettingKind } | null {
    if (!this.menu) return null;
    return this.currentGame();
  }

  /** The game the next hand deals, as far as is known: the current pick, the next one, or what a missed pick deals. */
  upcoming(): { gameId: string; betting: BettingKind } | null {
    const menu = this.menu;
    if (!menu) return null;
    const c = this.s.choice;
    if (c && !this.pickDone(null)) return this.currentGame();
    if (c?.next) return c.next;
    return menu.games[this.defaultIndex()];
  }

  view(): ChoiceView | null {
    if (!this.menu) return null;
    const s = this.s;
    const c = s.choice ?? null;
    const now = this.host.now();
    const pickView = (g: ChoicePick | null): ChoicePickView | null => g && { gameId: g.gameId, betting: g.betting, gameName: gameTitle(g.gameId, g.betting), by: g.by, how: g.how };
    // While paused the clock stands still: it shows what resuming now would give.
    const deadline = s.paused && s.pausedLeft?.pick != null ? now + s.pausedLeft.pick : (c?.deadline ?? null);
    return {
      chip: c ? (this.chooser()?.seat ?? null) : null,
      current: pickView(c?.current ?? null),
      handsLeft: c?.current && c.hands > 0 ? Math.max(0, c.length - c.hands) : null,
      next: pickView(c?.next ?? null),
      open: this.pickOpen(),
      deadline,
      count: this.host.tableCount(),
      cap: this.seatCap()?.cap ?? null,
      defaultIndex: this.defaultIndex(),
      canKeep: this.canKeep(),
    };
  }

  /** Paused: the pick clock stops. The time left (at least `min`) is kept in pausedLeft.pick. */
  pause(min: number): number | null {
    const c = this.s.choice;
    return c?.deadline != null ? Math.max(min, c.deadline - this.host.now()) : null;
  }

  /** Resumed: the chooser gets the time that was left. */
  resume(left: number | null | undefined) {
    const c = this.s.choice;
    if (!c || c.deadline === null || left == null) return;
    c.deadline = this.host.now() + left;
    if (c.botAt !== null) c.botAt = Math.min(c.botAt, c.deadline);
    this.s.nextHandAt = c.deadline;
  }

  /** After a restart nobody could pick while the server was down: a fresh clock. */
  restart() {
    const c = this.s.choice;
    if (!c || c.deadline === null || this.s.paused || !this.menu) return;
    c.deadline = this.host.now() + this.menu.pickSeconds * 1000;
    if (c.botAt !== null) c.botAt = this.host.now() + BOT_PICK_MS;
    this.s.nextHandAt = c.deadline;
  }
}
