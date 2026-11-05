// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useRef, type ComponentProps } from 'react';
import type { LegalActions, Stakes } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import type { HandView, SeatView, TableView } from '@rsdp/engine/wire';
import { ActionBar } from './ActionBar';

// The bar reaches the server only through call(): a spy here that answers at once, unless a test holds the answer back.
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../socket', () => ({
  call,
  // Modules the bar pulls in start listening on the socket when they load; nothing is ever sent on it.
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));

// ---------------------------------------------------------------- the table as Ann (seat 0) sees it

const STAKES: Stakes = { smallBlind: 10, bigBlind: 20, ante: 0, anteType: 'none', bringIn: 5, smallBet: 20, bigBet: 40 };
const NAMES = ['Ann', 'Bo', 'Cy'];
const fmt = (n: number) => String(n);

function seatView(seat: number, over: Partial<SeatView> = {}): SeatView {
  return {
    seat,
    playerId: `p${seat}`,
    name: NAMES[seat],
    stack: 1000,
    sittingOut: false,
    sitOutReason: null,
    online: true,
    inHand: true,
    folded: false,
    allIn: false,
    bet: 0,
    cards: [
      { card: '??', up: false },
      { card: '??', up: false },
    ],
    lastAction: null,
    timeBank: 30,
    leaving: false,
    owesBlinds: false,
    waiting: false,
    waitForBigBlind: false,
    straddle: false,
    nitOptIn: false,
    nit: null,
    won: 0,
    handName: null,
    avatar: null,
    mood: null,
    ...over,
  };
}

/** Hand 7 of no-limit hold'em at 10/20, on the flop with 200 in the middle. Ann has the button, so Bo acts first, then Cy, then Ann. */
function handView(over: Partial<HandView> = {}): HandView {
  return {
    handNumber: 7,
    gameId: 'nlhe',
    gameName: "No Limit Hold'em",
    shortName: 'NLH',
    family: 'flop',
    betting: 'no-limit',
    stakes: STAKES,
    names: { 0: 'Ann', 1: 'Bo', 2: 'Cy' },
    phase: 'betting',
    street: 1,
    streetName: 'Flop',
    button: 0,
    buttonDead: false,
    smallBlind: 1,
    bigBlind: 2,
    boards: [[['2c', '7d', 'Jh']]],
    pots: [{ amount: 200, eligible: [0, 1, 2] }],
    potTotal: 200,
    toAct: 1,
    currentBet: 0,
    drawMax: null,
    runItTwice: { offered: false, votes: {}, deadline: null, times: null },
    showdown: false,
    bombPot: false,
    awards: [],
    events: [],
    ...over,
  };
}

interface Spot {
  hand?: Partial<HandView> | null;
  /** What Ann may do now: null while it is someone else's turn. */
  legal?: LegalActions | null;
  /** Ann's seat. */
  me?: Partial<SeatView>;
  /** Bo's and Cy's seats. */
  others?: { 1?: Partial<SeatView>; 2?: Partial<SeatView> };
  view?: Partial<TableView>;
}

function tableView({ hand = {}, legal = null, me, others = {}, view }: Spot = {}): TableView {
  const settings = defaultSettings('cash');
  settings.stakes = { ...STAKES, centsMode: false };
  const mine = [
    { card: 'As', up: false },
    { card: 'Kh', up: false },
  ];
  return {
    id: 't1',
    name: 'Poker night',
    mode: 'cash',
    tournamentId: null,
    hostId: 'p1',
    isHost: false,
    realGame: true,
    powers: [],
    coHosts: [],
    me: { playerId: 'p0', seat: 0 },
    settings,
    pendingSettings: null,
    started: true,
    paused: false,
    stopAfterHand: false,
    recordsLocked: true,
    seats: [seatView(0, { cards: mine, ...me }), seatView(1, others[1]), seatView(2, others[2])],
    hand: hand && handView(hand),
    legal,
    canDraw: null,
    canVoteRunItTwice: false,
    canShow: [],
    turn: null,
    nextHandAt: null,
    serverNow: 0,
    rabbit: { available: false, cards: null },
    nit: null,
    rakeTotal: null,
    bombPotNext: false,
    upcoming: null,
    level: null,
    requests: [],
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
    ...view,
  };
}

// The spots below give Ann the moves the engine's computeLegal gives at 10/20 no limit.

/** Ann's turn after Bo and Cy checked. */
function checkedToMe(over: Partial<HandView> = {}): TableView {
  return tableView({
    hand: { toAct: 0, ...over },
    legal: { canFold: true, canCheck: true, callAmount: 0, canRaise: true, raiseKind: 'bet', minTo: 20, maxTo: 1000, canBringIn: false },
  });
}

/** Ann's turn after Bo bet `bet` and Cy called; Ann has `stack` behind. */
function facingBet(bet: number, stack = 1000): TableView {
  const canRaise = stack > bet;
  return tableView({
    hand: { toAct: 0, currentBet: bet, potTotal: 200 + 2 * bet },
    me: { stack },
    others: { 1: { bet }, 2: { bet } },
    legal: {
      canFold: true,
      canCheck: false,
      callAmount: Math.min(bet, stack),
      canRaise,
      raiseKind: 'raise',
      minTo: canRaise ? Math.min(2 * bet, stack) : 0,
      maxTo: canRaise ? stack : 0,
      canBringIn: false,
    },
  });
}

/** Cy's turn, Ann acts after him; Bo has bet `bet` (0: he checked). */
function waitingOn(bet = 0, street = 1): TableView {
  return tableView({ hand: { toAct: 2, currentBet: bet, potTotal: 200 + bet, street }, others: { 1: { bet } } });
}

// ---------------------------------------------------------------- driving the bar

type Props = Omit<ComponentProps<typeof ActionBar>, 'view'>;

function renderBar(view: TableView, props: Partial<Props> = {}) {
  const all: Props = { fmt, skew: 0, discard: [], clearDiscard: () => {}, ...props };
  const r = render(<ActionBar view={view} {...all} />);
  return { update: (next: TableView, more: Partial<Props> = {}) => r.rerender(<ActionBar view={next} {...all} {...more} />) };
}

/**
 * The bar inside a page that, like TablePage, keeps what onPreAction last said in a ref and reads it in its own
 * effect on each new view. That effect runs after the bar's, in the same commit, and is where TablePage decides
 * on the your-turn sound, so `queuedPerView` holds what the page knew on each view it was given.
 */
function renderInPage(view: TableView) {
  const queuedPerView: boolean[] = [];
  function Page({ view }: { view: TableView }) {
    const queued = useRef(false);
    useEffect(() => {
      queuedPerView.push(queued.current);
    }, [view]);
    return <ActionBar view={view} fmt={fmt} skew={0} discard={[]} clearDiscard={() => {}} onPreAction={(q) => (queued.current = q)} />;
  }
  const r = render(<Page view={view} />);
  return { update: (next: TableView) => r.rerender(<Page view={next} />), queuedPerView };
}

// Taken before the fake timers go in: one real task lets every promise callback already queued run.
const realSetTimeout = globalThis.setTimeout;
/** Lets the answers already given come back, and the bar redraw for them. */
const settle = () => act(() => new Promise<void>((resolve) => realSetTimeout(resolve, 0)));

/** Taps a button, then lets the answer to whatever it sent come back. */
async function tap(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
}

/** Moves the clock on by `ms`, running the timers due. */
async function later(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
}

/** Every move sent (hand:act), oldest first. */
const moves = () => call.mock.calls.filter(([event]) => event === 'hand:act').map(([, move]) => move);

/** The words on the buttons in one part of the bar, without the keyboard hints. */
const labels = (part: string) =>
  Array.from(document.querySelectorAll(`.action-bar ${part} button`), (b) =>
    Array.from(b.childNodes)
      .filter((n) => n.nodeName !== 'KBD')
      .map((n) => n.textContent)
      .join('')
      .trim(),
  );

/** A promise for call() to return that answers only when the test says. */
function held() {
  let ok = () => {};
  const promise = new Promise<object>((resolve) => {
    ok = () => resolve({});
  });
  return {
    promise,
    answer: () => {
      ok();
      return settle();
    },
  };
}

const box = () => screen.getByRole('spinbutton', { name: /^Amount/ }) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers();
  call.mockReset();
  call.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- tests

describe('double taps and moves in flight', () => {
  it('ignores a second tap within half a second of a move, but not one after', async () => {
    renderBar(checkedToMe());
    await tap('Check');
    expect(moves()).toEqual([expect.objectContaining({ type: 'check' })]);
    await later(300);
    await tap('Check');
    expect(moves()).toHaveLength(1);
    await later(250);
    await tap('Check');
    expect(moves()).toHaveLength(2);
  });

  it('sends one move at a time: nothing goes while the last is unanswered, and the answer frees the buttons', async () => {
    const answer = held();
    call.mockReturnValueOnce(answer.promise);
    renderBar(facingBet(100));
    await tap('Call 100');
    expect(document.querySelector('.action-bar.sending')).not.toBeNull();
    await later(1000);
    await tap('Raise to 200');
    expect(moves()).toEqual([expect.objectContaining({ type: 'call' })]);
    await answer.answer();
    expect(document.querySelector('.action-bar.sending')).toBeNull();
    await tap('Raise to 200');
    expect(moves()).toEqual([expect.objectContaining({ type: 'call' }), expect.objectContaining({ type: 'raise', to: 200 })]);
  });

  it('says so when the table is slow to answer, and gives the buttons back if it never does', async () => {
    call.mockReturnValueOnce(new Promise(() => {}));
    renderBar(checkedToMe());
    await tap('Check');
    await later(2500);
    expect(screen.getByText(/your connection seems slow/)).toBeTruthy();
    await later(5500);
    expect(screen.getByText(/No answer from the table/)).toBeTruthy();
    await tap('Check');
    expect(moves()).toHaveLength(2);
  });

  it('frees the buttons when the next turn comes before the answer, but still not within half a second of the move', async () => {
    call.mockReturnValueOnce(new Promise(() => {}));
    const bar = renderBar(checkedToMe());
    await tap('Check');
    // Everyone checked behind her, and the next street's view, with Ann first to act, comes before the answer to her check.
    bar.update(checkedToMe({ street: 2, streetName: 'Turn' }));
    await later(200);
    await tap('Check');
    expect(moves()).toHaveLength(1);
    await later(400);
    await tap('Check');
    expect(moves()).toHaveLength(2);
  });

  // Every table:state carries a new `legal` object, so a chat line (or anyone sitting down) while a move is unanswered
  // must not free the buttons: a tap more than half a second after the move would send a second one.
  it('keeps the buttons held while a move is unanswered when a view that is not a new turn arrives', async () => {
    call.mockReturnValueOnce(new Promise(() => {}));
    const bar = renderBar(facingBet(100));
    await tap('Call 100');
    // The same turn again, with a chat line: the server sends everyone a fresh view for it.
    const same = facingBet(100);
    bar.update({ ...same, chat: [{ at: 1, playerId: 'p1', name: 'Bo', text: 'nice' }] });
    await later(600);
    await tap('Raise to 200');
    expect(moves()).toHaveLength(1);
  });
});

describe('folding when checking is free', () => {
  it('folds at once when there is a bet to call', async () => {
    renderBar(facingBet(100));
    await tap('Fold');
    expect(moves()).toEqual([expect.objectContaining({ type: 'fold' })]);
  });

  it('asks first, ignores a tap within half a second of asking, and folds on the next', async () => {
    renderBar(checkedToMe());
    await tap('Fold');
    expect(moves()).toEqual([]);
    expect(labels('.buttons')).toContain('Fold anyway?');
    await later(300);
    await tap('Fold anyway?');
    expect(moves()).toEqual([]);
    await later(300);
    await tap('Fold anyway?');
    expect(moves()).toEqual([expect.objectContaining({ type: 'fold' })]);
  });

  it('forgets the question on the next street', async () => {
    const bar = renderBar(checkedToMe());
    await tap('Fold');
    bar.update(checkedToMe({ street: 2, streetName: 'Turn' }));
    expect(labels('.buttons')).toEqual(['Fold', 'Check', 'Bet 20']);
  });
});

describe('which buttons show', () => {
  it('offers check and bet when nobody has bet, with the pot presets and the bet box', () => {
    renderBar(checkedToMe());
    expect(labels('.buttons')).toEqual(['Fold', 'Check', 'Bet 20']);
    expect(labels('.presets')).toEqual(['½ pot', '¾ pot', 'Pot', 'All in']);
    expect(box().value).toBe('20');
    expect(screen.getByRole('slider', { name: 'Bet size' })).toBeTruthy();
  });

  it('offers fold, call and raise facing a bet', () => {
    renderBar(facingBet(100));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Raise to 200']);
  });

  it('says a call is all in when it takes every chip, and offers no raise then', () => {
    renderBar(facingBet(300, 150));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 150 (all in)']);
    expect(document.querySelector('.sizing')).toBeNull();
  });

  it('names an all-in raise as all in', async () => {
    renderBar(facingBet(100, 250));
    expect(labels('.presets')).toContain('All in');
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Raise to 200']);
    await tap('All in');
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'All in 250']);
    await tap('All in 250');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 250 })]);
  });

  it('offers just the all-in when the smallest raise is every chip', async () => {
    renderBar(facingBet(100, 180));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'All in 180']);
    expect(document.querySelector('.sizing')).toBeNull();
    await tap('All in 180');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 180 })]);
  });

  it('in fixed limit, offers the one raise with no presets or bet box', async () => {
    renderBar(
      tableView({
        hand: { betting: 'fixed-limit', toAct: 0, currentBet: 20, potTotal: 60 },
        others: { 1: { bet: 20 }, 2: { bet: 20 } },
        legal: { canFold: true, canCheck: false, callAmount: 20, canRaise: true, raiseKind: 'raise', minTo: 40, maxTo: 40, canBringIn: false },
      }),
    );
    expect(labels('.buttons')).toEqual(['Fold', 'Call 20', 'Raise to 40']);
    expect(document.querySelector('.sizing')).toBeNull();
    await tap('Raise to 40');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 40 })]);
  });

  it('in a draw game, offers stand pat, or a draw of the cards picked', async () => {
    const draw = (discard: number[]) => {
      const view = tableView({
        hand: { gameId: 'td27', family: 'draw', betting: 'fixed-limit', phase: 'drawing', streetName: 'First draw', boards: [[[]]], toAct: 0 },
        me: { cards: ['2c', '3d', '4h', '7s', 'Kc'].map((card) => ({ card, up: false })) },
      });
      return { ...view, canDraw: { max: 3 } };
    };
    const clearDiscard = vi.fn();
    const bar = renderBar(draw([]), { clearDiscard });
    expect(labels('.buttons')).toEqual(['Clear', 'Stand pat']);
    expect(screen.getByRole('button', { name: 'Clear' }).hasAttribute('disabled')).toBe(true);
    await tap('Stand pat');
    expect(call).toHaveBeenLastCalledWith('hand:draw', expect.objectContaining({ discard: [] }));

    await later(600);
    bar.update(draw([]), { discard: [1, 4] });
    expect(labels('.buttons')).toEqual(['Clear', 'Draw 2']);
    clearDiscard.mockClear();
    await tap('Draw 2');
    expect(call).toHaveBeenLastCalledWith('hand:draw', expect.objectContaining({ discard: [1, 4] }));
    // The picked cards are let go once the table has the draw.
    expect(clearDiscard).toHaveBeenCalledTimes(1);

    bar.update(draw([]), { discard: [0, 1, 2, 3] });
    expect(screen.getByRole('button', { name: 'Draw 4' }).hasAttribute('disabled')).toBe(true);
  });

  it('in stud, offers the bring-in and completing, and no fold', async () => {
    renderBar(
      tableView({
        hand: { gameId: 'stud', family: 'stud', betting: 'fixed-limit', street: 0, streetName: 'Third street', boards: [[[]]], potTotal: 0, toAct: 0 },
        me: {
          cards: [
            { card: '9c', up: false },
            { card: '8d', up: false },
            { card: '2h', up: true },
          ],
        },
        legal: { canFold: false, canCheck: false, callAmount: 0, canRaise: true, raiseKind: 'bet', minTo: 20, maxTo: 20, canBringIn: true },
      }),
    );
    expect(labels('.buttons')).toEqual(['Bring in 5', 'Complete to 20']);
    await tap('Bring in 5');
    await later(600);
    await tap('Complete to 20');
    expect(moves()).toEqual([expect.objectContaining({ type: 'bring-in' }), expect.objectContaining({ type: 'bet', to: 20 })]);
  });

  it('after the hand, offers to show the cards nobody had to see, together or one at a time', async () => {
    const done = (canShow: number[]) => ({ ...tableView({ hand: { phase: 'complete', toAct: null } }), canShow });
    const bar = renderBar(done([0, 1]));
    expect(labels('.buttons')).toEqual(['Show cards', 'Show A♠', 'Show K♥']);
    await tap('Show cards');
    expect(call).toHaveBeenLastCalledWith('hand:show', expect.objectContaining({ cards: [0, 1] }));
    await later(600);
    await tap('Show K♥');
    expect(call).toHaveBeenLastCalledWith('hand:show', expect.objectContaining({ cards: [1] }));

    bar.update(done([1]));
    expect(labels('.buttons')).toEqual(['Show cards']);
    bar.update(done([]));
    expect(labels('.buttons')).toEqual([]);
  });

  it('asks everyone all in whether to run it twice', async () => {
    renderBar({ ...tableView({ hand: { toAct: null } }), canVoteRunItTwice: true });
    expect(labels('.buttons')).toEqual(['Run it once', 'Run it twice']);
    await tap('Run it twice');
    expect(call).toHaveBeenLastCalledWith('hand:runItTwice', expect.objectContaining({ yes: true }));
  });

  it('shows no buttons once you have folded', () => {
    renderBar(tableView({ me: { folded: true, cards: [] } }));
    expect(document.querySelector('.action-bar.idle')).not.toBeNull();
    expect(document.querySelectorAll('.action-bar button')).toHaveLength(0);
  });
});

describe('the bet box and presets', () => {
  it('bets a share of the pot from the presets, and the button sends that amount', async () => {
    renderBar(checkedToMe());
    await tap('½ pot');
    expect(labels('.buttons')).toContain('Bet 100');
    await tap('¾ pot');
    expect(labels('.buttons')).toContain('Bet 150');
    await tap('Pot');
    expect(labels('.buttons')).toContain('Bet 200');
    await tap('Bet 200');
    await later(600);
    await tap('All in');
    await tap('All in 1000');
    expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 200 }), expect.objectContaining({ type: 'bet', to: 1000 })]);
  });

  it('facing a bet, sizes a raise as the call plus that share of the pot after it', async () => {
    // Bo bet 100 and Cy called: 400 in the middle, 500 once Ann calls.
    renderBar(facingBet(100));
    await tap('½ pot');
    expect(labels('.buttons')).toContain('Raise to 350');
    await tap('¾ pot');
    expect(labels('.buttons')).toContain('Raise to 480');
    await tap('Pot');
    await tap('Raise to 600');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 600 })]);
  });

  it('rounds a preset to the small blind', async () => {
    renderBar(checkedToMe({ potTotal: 230, pots: [{ amount: 230, eligible: [0, 1, 2] }] }));
    // Half of 230 is 115: 120 to the nearest 10.
    await tap('½ pot');
    expect(labels('.buttons')).toContain('Bet 120');
  });

  it('in pot limit, makes the Pot preset the exact most, and calls the last preset Max', async () => {
    const view = facingBet(100);
    view.hand!.betting = 'pot-limit';
    view.legal = { ...view.legal!, maxTo: 600 };
    renderBar(view);
    expect(labels('.presets')).toEqual(['½ pot', '¾ pot', 'Pot', 'Max']);
    await tap('Pot');
    await tap('Raise to 600');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 600 })]);
  });

  it('sends what is typed in the bet box, from the button or with Enter', async () => {
    renderBar(facingBet(100));
    fireEvent.change(box(), { target: { value: '350' } });
    expect(labels('.buttons')).toContain('Raise to 350');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await settle();
    await later(600);
    fireEvent.change(box(), { target: { value: '420' } });
    await tap('Raise to 420');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 350 }), expect.objectContaining({ type: 'raise', to: 420 })]);
  });

  it('holds an amount typed past either end to the most or least allowed', async () => {
    renderBar(facingBet(100));
    fireEvent.change(box(), { target: { value: '5000' } });
    await tap('All in 1000');
    await later(600);
    fireEvent.change(box(), { target: { value: '150' } });
    await tap('Raise to 200');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 }), expect.objectContaining({ type: 'raise', to: 200 })]);
  });

  it('works in big blinds when amounts are shown in big blinds', async () => {
    renderBar(facingBet(100), { bigBlind: 20 });
    const inBB = screen.getByRole('spinbutton', { name: 'Amount in big blinds' }) as HTMLInputElement;
    expect(inBB.value).toBe('10');
    fireEvent.change(inBB, { target: { value: '17.5' } });
    await tap('Raise to 17.5 BB');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 350 })]);
  });

  it('puts the far end of the slider at the most allowed', async () => {
    renderBar(facingBet(100));
    const slider = screen.getByRole('slider', { name: 'Bet size' }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: slider.max } });
    await tap('All in 1000');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
  });
});

describe('pre-moves', () => {
  it('offers moves that fit what you will face', () => {
    const bar = renderBar(waitingOn(0));
    expect(labels('.buttons')).toEqual(['Check / Fold', 'Check', 'Call any']);
    bar.update(waitingOn(100));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Call any']);
  });

  it('sends a ticked pre-move when the turn comes, and a second tap unticks it', async () => {
    const onPreAction = vi.fn();
    const bar = renderBar(waitingOn(0), { onPreAction });
    await tap('Call any');
    expect(screen.getByRole('button', { name: /Call any/ }).getAttribute('aria-pressed')).toBe('true');
    expect(onPreAction).toHaveBeenLastCalledWith(true);
    await tap(/Call any/);
    expect(onPreAction).toHaveBeenLastCalledWith(false);
    await tap('Check');
    expect(moves()).toEqual([]);
    bar.update(checkedToMe());
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'check' })]);
  });

  it('calls whatever it costs with Call any', async () => {
    const page = renderInPage(waitingOn(100));
    await tap('Call any');
    page.update(facingBet(300));
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'call' })]);
    // On the view that gave Ann the turn the page knew a move was queued, so it did not call her with the turn sound.
    expect(page.queuedPerView).toEqual([false, true]);
  });

  it('turns check/fold into fold once someone bets, and folds when the turn comes', async () => {
    const bar = renderBar(waitingOn(0));
    await tap('Check / Fold');
    bar.update(waitingOn(100));
    expect(labels('.buttons')).toEqual(['✓ Fold', 'Call 100', 'Call any']);
    bar.update(facingBet(100));
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'fold' })]);
  });

  it('clears a ticked check when someone bets, so you decide again', async () => {
    const onPreAction = vi.fn();
    const bar = renderBar(waitingOn(0), { onPreAction });
    await tap('Check');
    bar.update(waitingOn(100));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Call any']);
    expect(onPreAction).toHaveBeenLastCalledWith(false);
    bar.update(facingBet(100));
    await settle();
    expect(moves()).toEqual([]);
  });

  it('clears a ticked call when someone raises before the turn comes', async () => {
    const onPreAction = vi.fn();
    const bar = renderBar(waitingOn(100), { onPreAction });
    await tap('Call 100');
    bar.update(waitingOn(300));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 300', 'Call any']);
    // Nothing is queued any more, so the page plays the your-turn sound when the turn comes.
    expect(onPreAction).toHaveBeenLastCalledWith(false);
    bar.update(facingBet(300));
    await settle();
    expect(moves()).toEqual([]);
  });

  it('drops a pre-move that no longer fits when the turn comes, and says so before the page picks a sound', async () => {
    const page = renderInPage(waitingOn(100));
    await tap('Call 100');
    // Cy raised to 300, and that view is the one that gives Ann the turn.
    page.update(facingBet(300));
    await settle();
    expect(moves()).toEqual([]);
    // The page already knew on that view that nothing is queued, so it calls Ann with the turn sound.
    expect(page.queuedPerView).toEqual([false, false]);
    expect(labels('.buttons')).toEqual(['Fold', 'Call 300', 'Raise to 600']);
  });

  it('keeps a pre-move for one betting round only', async () => {
    const bar = renderBar(waitingOn(0, 1));
    await tap('Check');
    bar.update(waitingOn(0, 2));
    expect(labels('.buttons')).toEqual(['Check / Fold', 'Check', 'Call any']);
    bar.update(checkedToMe({ street: 2 }));
    await settle();
    expect(moves()).toEqual([]);
  });

  it('does not tick a pre-move with a tap within half a second of a move', async () => {
    const bar = renderBar(checkedToMe());
    await tap('Check');
    bar.update(waitingOn(0, 2));
    await later(200);
    await tap('Check');
    expect(labels('.buttons')).toEqual(['Check / Fold', 'Check', 'Call any']);
    await later(400);
    await tap('Check');
    expect(labels('.buttons')).toEqual(['Check / Fold', '✓ Check', 'Call any']);
  });
});

describe('keyboard', () => {
  const press = async (key: string) => {
    fireEvent.keyDown(window, { key });
    await settle();
  };

  it('checks with K, calls with C, and asks before folding with F', async () => {
    const bar = renderBar(checkedToMe());
    await press('c');
    expect(moves()).toEqual([]);
    await press('k');
    await later(600);
    await press('f');
    expect(labels('.buttons')).toContain('Fold anyway?');
    await later(600);
    await press('f');
    bar.update(facingBet(100));
    await later(600);
    await press('c');
    expect(moves()).toEqual([expect.objectContaining({ type: 'check' }), expect.objectContaining({ type: 'fold' }), expect.objectContaining({ type: 'call' })]);
  });

  it('puts the cursor in the bet box with R, and Enter sends it', async () => {
    renderBar(facingBet(100));
    await press('r');
    expect(document.activeElement).toBe(box());
    // Typing in the box is not a shortcut.
    fireEvent.keyDown(box(), { key: 'f' });
    fireEvent.change(box(), { target: { value: '300' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 300 })]);
  });

  it('puts the cursor in the bet box when you type a number on your turn, with the old amount selected to be replaced (#320)', async () => {
    renderBar(facingBet(100));
    const ev = new KeyboardEvent('keydown', { key: '3', cancelable: true });
    window.dispatchEvent(ev);
    await settle();
    expect(document.activeElement).toBe(box());
    // The browser types the digit into the box: the shortcut must not swallow it.
    expect(ev.defaultPrevented).toBe(false);
    expect(moves()).toEqual([]);
  });

  it('leaves numbers alone before your turn', async () => {
    renderBar(waitingOn(100));
    await press('3');
    expect(document.activeElement).toBe(document.body);
  });

  it('ticks a pre-move with its key before your turn', async () => {
    renderBar(waitingOn(100));
    await press('c');
    expect(labels('.buttons')).toEqual(['Fold', '✓ Call 100', 'Call any']);
    expect(moves()).toEqual([]);
  });
});
