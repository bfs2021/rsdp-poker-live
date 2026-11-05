import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Action } from '@rsdp/engine/core';
import type { CoachTip, TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import './action-bar.css';
import { bbExactFormat, betFromInput, betStops, betToInput, betUnit, nearestStop, roundToUnit, type BetUnit, type Fmt } from '../format';
import { handStrength } from '../strength';
import { tipText } from '../coach';
import { usePrefs } from '../prefs';
import { LogText, suitSymbol } from './PlayingCard';
import { useNow } from './Table';
import { CoachWhy } from './CoachWhy';
import { preMoveAction, type PreAction } from '../premoves';
import { turnKey } from '../turn';

const cardName = (c: string | undefined) => (c ? `${c[0] === 'T' ? '10' : c[0]}${suitSymbol(c[1])}` : '');

/** How long a move waits for the server before the buttons come back. */
const SEND_TIMEOUT_MS = 8_000;
/** Two taps closer than this are one double tap: the second is ignored, not sent as a move on the next turn. */
const DOUBLE_TAP_MS = 500;

export function ActionBar({
  view,
  fmt: chipFmt,
  bigBlind = null,
  skew,
  discard,
  clearDiscard,
  setDiscard,
  onPreAction,
  onRules,
}: {
  view: TableView;
  fmt: Fmt;
  /** Set when the player has chosen to see amounts in big blinds: the buttons and the bet box then work in BB. */
  bigBlind?: number | null;
  skew: number;
  discard: number[];
  clearDiscard: () => void;
  /** Picks the cards to throw (a coach tip's [Mark]). */
  setDiscard?: (cards: number[]) => void;
  /** Tells the page whether a move is queued, so it can skip the your-turn sound. */
  onPreAction?: (queued: boolean) => void;
  /** Opens How to play (from a coach tip's Why sheet). */
  onRules?: () => void;
}) {
  const { legal, hand } = view;
  const centsMode = view.settings.stakes.centsMode;
  const unit: BetUnit = bigBlind ? { bb: bigBlind } : { centsMode };
  const fmt = bigBlind ? bbExactFormat(bigBlind) : chipFmt;
  const me = view.me.seat !== null ? view.seats[view.me.seat] : null;
  // The bet box and its presets: no-limit and pot-limit, when there's a range to pick from.
  const sized = !!legal && legal.canRaise && legal.maxTo > legal.minTo;
  const [amount, setAmountRaw] = useState(0);
  // What's typed in the bet box, kept as text while typing so "2." or "0.5" isn't rewritten mid-word.
  const [typed, setTyped] = useState<string | null>(null);
  const setAmount = (chips: number) => {
    setTyped(null);
    setAmountRaw(chips);
  };
  // Switching units (here or in another tab) redraws the box in the new unit.
  useEffect(() => setTyped(null), [bigBlind]);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState<{ key: string; action: PreAction } | null>(null);
  // Queued moves are for one betting round only.
  const streetKey = hand ? `${hand.handNumber}:${hand.street}` : '';
  const pre = queued?.key === streetKey ? queued.action : null;
  const setPre = (action: PreAction | null) => setQueued(action && { key: streetKey, action });
  const [confirmFold, setConfirmFold] = useState(false);
  const amountBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onPreAction?.(!!pre);
  }, [!!pre]);

  // Before your turn: the pre-moves on offer, or null when there is nothing to pre-click.
  const runningOut = !!hand?.events.some((e) => e.t === 'run-it');
  const waiting =
    !legal && !!hand && hand.phase === 'betting' && !runningOut && !view.canVoteRunItTwice && !view.canDraw && !!me && me.inHand && !me.folded && !me.allIn;
  const waitToCall = waiting ? Math.min(hand.currentBet - me.bet, me.stack) : 0;
  const preOpts: { label: string; key: string; value: PreAction }[] | null = !waiting
    ? null
    : waitToCall === 0
      ? [
          { label: 'Check / Fold', key: 'F', value: { kind: 'checkFold' } },
          { label: 'Check', key: 'K', value: { kind: 'check' } },
          { label: 'Call any', key: 'A', value: { kind: 'callAny' } },
        ]
      : [
          { label: 'Fold', key: 'F', value: { kind: 'fold' } },
          { label: `Call ${fmt(waitToCall)}`, key: 'C', value: { kind: 'call', amount: waitToCall } },
          { label: 'Call any', key: 'A', value: { kind: 'callAny' } },
        ];
  const isPre = (v: PreAction) => !!pre && JSON.stringify(pre) === JSON.stringify(v);
  const togglePre = (v: PreAction) => settled() && setPre(isPre(v) ? null : v);
  // A bet before your turn changes what a pre-move means, as on PokerNow: check/fold becomes fold, while a
  // check, or a call of an amount someone has since raised, is cleared so you decide again.
  useEffect(() => {
    if (!pre || !waiting) return;
    if (waitToCall > 0 && pre.kind === 'checkFold') setPre({ kind: 'fold' });
    else if (waitToCall > 0 && pre.kind === 'check') setPre(null);
    else if (pre.kind === 'call' && pre.amount !== waitToCall) setPre(null);
  }, [waitToCall, waiting]);
  const ritDeadline = view.canVoteRunItTwice ? hand?.runItTwice.deadline ?? null : null;
  const now = useNow(ritDeadline !== null, 500) + skew;

  // Coach tips: only when the server says this hand is you against bots alone, on your own turn. One tip per decision
  // (the hand's event count), asked for when opened and kept, so opening it again sends nothing.
  const prefs = usePrefs();
  const tipOn = !!view.tips && prefs.tips && (!!legal || !!view.canDraw) && !view.paused && !!hand && hand.phase !== 'complete';
  const tipKey = hand ? `${hand.handNumber}:${hand.events.length}` : '';
  const [tipAt, setTipAt] = useState<string | null>(null);
  const tipOpen = tipOn && tipAt === tipKey;
  const [whyAt, setWhyAt] = useState<string | null>(null);
  const tips = useRef(new Map<string, CoachTip>());
  const asking = useRef(new Set<string>());
  const [tipError, setTipError] = useState<{ key: string; message: string } | null>(null);
  const [, setTipsIn] = useState(0);
  const askTip = (key: string) => {
    if (tips.current.has(key) || asking.current.has(key)) return;
    const [handNumber, at] = key.split(':').map(Number);
    asking.current.add(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const noAnswer = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('no answer from the table')), SEND_TIMEOUT_MS);
    });
    Promise.race([call<{ tip: CoachTip }>('hand:tip', { handNumber, at }), noAnswer])
      .then(({ tip }) => {
        // Only the answer to this decision: one for a turn that has passed is never shown.
        if (tip?.handNumber !== handNumber || tip.at !== at) return;
        tips.current.set(key, tip);
        for (const k of tips.current.keys()) if (tips.current.size > 12) tips.current.delete(k);
        setTipsIn((n) => n + 1);
      })
      .catch((e: Error) => setTipError({ key, message: e.message }))
      .finally(() => {
        clearTimeout(timer);
        asking.current.delete(key);
      });
  };
  const toggleTip = () => {
    if (!tipOn) return;
    if (tipOpen) return setTipAt(null);
    setTipAt(tipKey);
    if (tipError?.key === tipKey) setTipError(null);
    askTip(tipKey);
  };
  const tip = tipOpen ? tips.current.get(tipKey) : undefined;
  // R with the tip open brings the bet box back first.
  const boxWanted = useRef(false);
  useEffect(() => {
    if (tipOpen || !boxWanted.current) return;
    boxWanted.current = false;
    amountBox.current?.focus();
    amountBox.current?.select();
  }, [tipOpen]);

  // One move at a time: a double tap must not send a second move, which could land on the next street
  // (the big blind checking preflop and then first to act on the flop) or queue a pre-move.
  const inFlight = useRef(false);
  const lastSent = useRef(0);
  const [sending, setSending] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!sending) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 2500);
    return () => clearTimeout(t);
  }, [sending]);
  const release = () => {
    inFlight.current = false;
    setSending(false);
  };
  const run = (p: () => Promise<unknown>) => {
    // The next turn's view arrives before the answer to this move, and frees the buttons: a tap within half a second
    // of a move is still the second half of a double tap, not a move on the next street.
    if (inFlight.current || Date.now() - lastSent.current < DOUBLE_TAP_MS) return;
    setTipAt(null);
    setWhyAt(null);
    inFlight.current = true;
    lastSent.current = Date.now();
    setSending(true);
    // An answer lost to a dropped connection never comes: give the buttons back rather than lock them for good.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const noAnswer = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('No answer from the table. Check your connection and try again.')), SEND_TIMEOUT_MS);
    });
    Promise.race([p(), noAnswer])
      .then(() => setError(''))
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        clearTimeout(timer);
        release();
      });
  };
  // A new turn (or hand) means the last move was dealt with, answered or not. Only a new turn: every view carries a
  // fresh `legal`, and a chat line or someone sitting down while a move is unanswered must not free the buttons.
  const { handNumber: turnHand, at: turnAt } = turnKey(view);
  useEffect(release, [!!legal, turnHand, hand?.street, turnAt]);
  // Each move carries the turn on screen when it was pressed, read then rather than from an older render: the server
  // refuses one that arrives after that turn has passed (usually the second of two taps on a slow connection), so it
  // isn't played on a later street.
  const onScreen = useRef(view);
  onScreen.current = view;
  const send = (action: Action) => {
    const sentFor = turnKey(onScreen.current);
    run(() => call('hand:act', { ...action, ...sentFor }));
  };
  const draw = (cards: number[]) => {
    const sentFor = turnKey(onScreen.current);
    run(() => call('hand:draw', { discard: cards, ...sentFor }).then(clearDiscard));
  };
  // A show carries only the hand it was pressed after (shows add events once a hand is over, so the count is no turn):
  // one that arrives after the next deal must not show that hand's cards.
  const show = (cards: number[]) => {
    const { handNumber } = turnKey(onScreen.current);
    run(() => call('hand:show', { cards, handNumber }));
  };
  // A run it twice vote carries only its hand too (each vote adds an event): one that arrives during a later hand's vote is ignored.
  const vote = (yes: boolean) => {
    const { handNumber } = turnKey(onScreen.current);
    run(() => call('hand:runItTwice', { yes, handNumber }));
  };
  const startBank = () => call('hand:timeBank', turnKey(onScreen.current)).catch((e: Error) => setError(e.message));
  /** Taps on pre-moves within half a second of a move are the second half of a double tap. */
  const settled = () => !inFlight.current && Date.now() - lastSent.current > DOUBLE_TAP_MS;

  useEffect(() => {
    if (legal) setAmount(legal.minTo);
    setError('');
    setConfirmFold(false);
  }, [legal?.minTo, hand?.handNumber, hand?.street]);

  // Folding when you could check for free asks once more, and the answer can't be the second half of a double tap.
  const foldAskedAt = useRef(0);
  const fold = () => {
    if (legal?.canCheck && !confirmFold) {
      foldAskedAt.current = Date.now();
      return setConfirmFold(true);
    }
    if (legal?.canCheck && Date.now() - foldAskedAt.current < DOUBLE_TAP_MS) return;
    setConfirmFold(false);
    send({ type: 'fold' });
  };

  // Keyboard: F fold, K check, C call, R raise box (Enter sends it), a digit starts typing the amount there.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  keys.current = (e) => {
    if ((!legal && !preOpts && !tipOn) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]');
    // Keys never act behind an open dialog or sheet.
    if (typing || document.querySelector('.modal-backdrop, .sheet-backdrop, .replayer-backdrop')) return;
    const k = e.key.toLowerCase();
    // T opens the tip on draw turns too, so it comes before the betting keys.
    if (k === 't' && tipOn) {
      e.preventDefault();
      toggleTip();
      return;
    }
    if (!legal && !preOpts) return;
    // Before your turn the same keys tick (or untick) a pre-move.
    if (!legal) {
      const o = preOpts?.find((o) => o.key.toLowerCase() === k);
      if (o) togglePre(o.value);
      return;
    }
    if (k === 'f' && legal.canFold) fold();
    else if (k === 'k' && legal.canCheck) send({ type: 'check' });
    else if (k === 'c' && !legal.canCheck && !legal.canBringIn) send({ type: 'call' });
    else if (/^[0-9]$/.test(k) && amountBox.current) {
      // A number on your turn starts the bet amount: the box takes focus now, so this key lands in it, replacing
      // what was there (#320). Not preventDefault: the browser types the digit into the newly focused box.
      amountBox.current.focus();
      amountBox.current.select();
    } else if (k === 'r' && amountBox.current) {
      e.preventDefault();
      amountBox.current.focus();
      amountBox.current.select();
    } else if (k === 'r' && tipOpen && sized) {
      e.preventDefault();
      boxWanted.current = true;
      setTipAt(null);
    } else if (k === 'r' && hand?.betting === 'fixed-limit' && legal.canRaise) send({ type: legal.raiseKind, to: legal.minTo });
    else return;
  };

  // When it becomes your turn, play the queued move if it still applies.
  useEffect(() => {
    if (!legal || !pre) return;
    setPre(null);
    const move = preMoveAction(pre, legal);
    // A pre-move that no longer applies is dropped so you can decide again; say so now, before the
    // page decides whether to call you with the turn sound.
    if (move) send(move);
    else onPreAction?.(false);
  }, [legal]);

  const myCards = me?.inHand ? me.cards.map((c) => c.card) : [];
  const strength = hand && myCards.length ? handStrength(hand.gameId, myCards, hand.boards[0]?.[0] ?? []) : null;
  const hint = strength && <div className="strength">{strength}</div>;
  // On your turn (betting or drawing) the tip and the time bank sit on the bar's top line, so the bar is no taller for them.
  const canBank = !view.paused && !!me && !!view.turn && view.turn.seat === me.seat && !view.turn.usingBank && view.turn.deadline !== null && me.timeBank > 0;
  const head =
    canBank || tipOn ? (
      <div className="bar-head">
        {tipOn && (
          <button className="play-tip-button" aria-expanded={tipOpen} aria-controls="play-tip" aria-keyshortcuts="T" title="Tip (T)" onClick={toggleTip}>
            Tip
            <Key k="T" />
          </button>
        )}
        {hint}
        {canBank && (
          <button className="time-bank" onClick={startBank}>
            Time bank +{me.timeBank}s
          </button>
        )}
      </div>
    ) : (
      hint
    );
  // The sizing block's height, so a tip in its place takes just as much room and nothing below it moves.
  const sizingBox = useRef<HTMLDivElement>(null);
  const sizingHeight = useRef(0);
  useLayoutEffect(() => {
    if (sizingBox.current) sizingHeight.current = sizingBox.current.offsetHeight;
  });
  const tipPanel = (inPlaceOfSizing: boolean) =>
    tipOpen && (
      <TipPanel
        tip={tip}
        error={tipError?.key === tipKey ? tipError.message : null}
        view={view}
        fmt={fmt}
        minHeight={inPlaceOfSizing ? sizingHeight.current : 0}
        onSet={
          inPlaceOfSizing
            ? (to) => {
                setAmount(to);
                setTipAt(null);
              }
            : null
        }
        onMark={setDiscard ?? null}
        onWhy={() => setWhyAt(tipKey)}
      />
    );
  // Where there is no sizing block for the tip to stand in for (fixed limit, a draw turn), it gets a place of its own from
  // the start of the turn, holding the draw prompt (or nothing) until it opens, so opening it moves nothing.
  const tipSlot = (closed: ReactNode) => (tipOn ? <div className="play-tip-slot">{tipPanel(false) || closed}</div> : closed);
  const why = tip && whyAt === tipKey && (
    <CoachWhy
      tip={tip}
      view={view}
      fmt={fmt}
      skew={skew}
      onClose={() => setWhyAt(null)}
      onRules={
        onRules &&
        (() => {
          setWhyAt(null);
          onRules();
        })
      }
    />
  );
  const errorLine = slow ? (
    <div className="muted sending-note">Sending… your connection seems slow.</div>
  ) : (
    error && <div className="error">{error}</div>
  );

  // After the hand: show cards you were not made to show.
  if (hand?.phase === 'complete' || !hand) {
    if (!view.canShow.length) return <div className="action-bar idle">{hint}</div>;
    return (
      <div className="action-bar idle">
        {hint}
        {errorLine}
        <div className="buttons small">
          <button onClick={() => show(view.canShow)}>Show cards</button>
          {view.canShow.length > 1 &&
            view.canShow.map((i) => (
              <button key={i} onClick={() => show([i])}>
                Show {cardName(myCards[i])}
              </button>
            ))}
        </div>
      </div>
    );
  }

  if (view.canVoteRunItTwice) {
    const left = ritDeadline ? Math.max(0, Math.ceil((ritDeadline - now) / 1000)) : null;
    return (
      <div className={`action-bar my-turn${sending ? ' sending' : ''}`}>
        {hint}
        {errorLine}
        <div className="prompt">Everyone is all in. Run it twice?{left !== null && <span className="muted"> {left}s</span>}</div>
        <div className="buttons">
          <button onClick={() => vote(false)}>Run it once</button>
          <button className="primary" onClick={() => vote(true)}>
            Run it twice
          </button>
        </div>
      </div>
    );
  }

  if (view.canDraw) {
    const n = discard.length;
    return (
      <div className={`action-bar my-turn${sending ? ' sending' : ''}`}>
        {head}
        {errorLine}
        {tipSlot(
          <div className="prompt">
            {hand.streetName}: click the cards you want to throw away{view.canDraw.max < myCards.length ? ` (up to ${view.canDraw.max})` : ''}.
          </div>,
        )}
        <div className="buttons">
          <button disabled={n === 0} onClick={clearDiscard}>
            Clear
          </button>
          <button
            className="primary"
            disabled={n > view.canDraw.max}
            onClick={() => draw(discard)}
          >
            {n === 0 ? 'Stand pat' : `Draw ${n}`}
          </button>
        </div>
        {why}
      </div>
    );
  }

  // Once the board is being run out (everyone all in) there is nothing left to bet.
  if (!me || !me.inHand || me.folded || me.allIn || hand.phase !== 'betting' || runningOut) {
    const waiting = hand.phase === 'drawing' && me?.inHand && !me.folded ? <div className="muted">Waiting for the draw…</div> : null;
    return (
      <div className="action-bar idle">
        {hint}
        {waiting}
      </div>
    );
  }

  if (!legal) {
    if (!preOpts) return <div className="action-bar idle">{hint}</div>;
    return (
      <div className="action-bar pre" data-street={streetKey}>
        {hint}
        <div className="buttons">
          {preOpts.map((o) => {
            const on = isPre(o.value);
            return (
              <button
                key={o.label}
                className={on ? 'queued' : ''}
                aria-pressed={on}
                title={`${on ? 'Click again to cancel' : 'Do this as soon as it is your turn'}. Shortcut: ${o.key}`}
                onClick={() => togglePre(o.value)}
              >
                <span className="box">{on ? '✓' : ''}</span> {o.label}
                <Key k={o.key} />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const toCall = hand.currentBet - me.bet;
  const allInTo = me.stack + me.bet;
  const clamp = (x: number) => Math.max(legal.minTo, Math.min(legal.maxTo, Math.floor(x)));
  // The slider stops on round amounts (quarters at .25/.50, whole dollars once the stack is deep), never 18.61.
  const step = betUnit(hand.stakes);
  const stops = sized ? betStops(legal.minTo, legal.maxTo, step) : [legal.minTo];
  // A pot-sized raise: call first, then raise by the size of the pot after the call, to the nearest small blind.
  // (A pot that is the most you may bet, as in pot limit, stays exact.)
  const potRaise = (fraction: number) => {
    const exact = hand.currentBet + (hand.potTotal + toCall) * fraction;
    return exact >= legal.maxTo ? legal.maxTo : clamp(roundToUnit(exact, step));
  };
  const raiseType = legal.raiseKind;
  const raiseLabel = (to: number) =>
    to >= allInTo ? `All in ${fmt(to)}` : legal.canBringIn ? `Complete to ${fmt(to)}` : raiseType === 'bet' ? `Bet ${fmt(to)}` : `Raise to ${fmt(to)}`;

  return (
    <div className={`action-bar my-turn${sending ? ' sending' : ''}`} data-street={streetKey}>
      {head}
      {errorLine}
      {!sized && tipSlot(null)}
      {sized && (tipPanel(true) || (
        <div className="sizing" ref={sizingBox}>
          {hand.betting !== 'fixed-limit' && (
            <div className="presets">
              <button onClick={() => setAmount(potRaise(0.5))}>½ pot</button>
              <button onClick={() => setAmount(potRaise(0.75))}>¾ pot</button>
              <button onClick={() => setAmount(potRaise(1))}>Pot</button>
              <button onClick={() => setAmount(legal.maxTo)}>{legal.maxTo >= allInTo ? 'All in' : 'Max'}</button>
            </div>
          )}
          <div className="slider">
            <input
              type="range"
              min={0}
              max={stops.length - 1}
              value={nearestStop(stops, amount)}
              onChange={(e) => setAmount(stops[+e.target.value] ?? legal.minTo)}
              aria-label="Bet size"
              aria-valuetext={fmt(clamp(amount))}
            />
            <input
              ref={amountBox}
              type="number"
              inputMode="decimal"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && legal.canRaise) send({ type: raiseType, to: clamp(amount) });
              }}
              min={betToInput(unit, legal.minTo)}
              max={betToInput(unit, legal.maxTo)}
              step={bigBlind ? 'any' : centsMode ? 0.01 : 1}
              value={typed ?? betToInput(unit, amount)}
              onChange={(e) => {
                setTyped(e.target.value);
                // Text the browser can't read as a number leaves the amount as it was.
                if (!e.target.validity.badInput) setAmountRaw(betFromInput(unit, e.target.value === '' ? NaN : +e.target.value));
              }}
              onBlur={() => setTyped(null)}
              aria-label={bigBlind ? 'Amount in big blinds' : 'Amount'}
            />
            {bigBlind && <span className="unit">BB</span>}
          </div>
        </div>
      ))}
      <div className="buttons">
        {legal.canFold && (
          <button className={`fold ${confirmFold ? 'confirm' : ''}`} onClick={fold} title="Shortcut: F">
            {confirmFold ? 'Fold anyway?' : 'Fold'}
            <Key k="F" />
          </button>
        )}
        {legal.canBringIn ? (
          <button onClick={() => send({ type: 'bring-in' })}>Bring in {fmt(hand.stakes.bringIn)}</button>
        ) : legal.canCheck ? (
          <button className="call" onClick={() => send({ type: 'check' })} title="Shortcut: K">
            Check
            <Key k="K" />
          </button>
        ) : (
          <button className="call" onClick={() => send({ type: 'call' })} title="Shortcut: C">
            Call {fmt(legal.callAmount)}
            {legal.callAmount >= me.stack ? ' (all in)' : ''}
            <Key k="C" />
          </button>
        )}
        {legal.canRaise && (
          <button className="primary" onClick={() => send({ type: raiseType, to: sized ? clamp(amount) : legal.minTo })}>
            {raiseLabel(sized ? clamp(amount) : legal.minTo)}
            <Key k="R" />
          </button>
        )}
      </div>
      {why}
    </div>
  );
}

/**
 * A coach tip on the action bar: the verdict, what it's based on, and small
 * buttons for Why?, putting the amount in the bet box, or marking the cards to
 * throw. It is never one of the move buttons, so they never move or dim for it.
 */
function TipPanel({
  tip,
  error,
  view,
  fmt,
  minHeight,
  onSet,
  onMark,
  onWhy,
}: {
  tip: CoachTip | undefined;
  error: string | null;
  view: TableView;
  fmt: Fmt;
  minHeight: number;
  onSet: ((to: number) => void) | null;
  onMark: ((cards: number[]) => void) | null;
  onWhy: () => void;
}) {
  let text: ReturnType<typeof tipText> | null = null;
  let problem = error;
  try {
    if (tip && !error) text = tipText(tip, view, fmt);
  } catch {
    problem = 'something went wrong';
  }
  return (
    <div id="play-tip" className="play-tip" role="status" aria-live="polite" style={minHeight ? { minHeight } : undefined}>
      {problem ? (
        <div className="play-tip-error">No tip right now: {problem}.</div>
      ) : !text ? (
        <div className="play-tip-basis">Working it out…</div>
      ) : (
        <>
          <div className="play-tip-verdict">
            <LogText text={text.verdict} />
          </div>
          <div className="play-tip-basis">
            {text.basis && <span>{text.basis}</span>}
            <button data-act="why" onClick={onWhy}>
              Why?
            </button>
            {onSet && text.set && (
              <button data-act="set" onClick={() => onSet(text.set!.to)}>
                {text.set.label}
              </button>
            )}
            {onMark && text.mark && (
              <button data-act="mark" onClick={() => onMark(text.mark!.discard)}>
                <LogText text={text.mark.label} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A small keyboard hint on a button; hidden on touch screens. */
function Key({ k }: { k: string }) {
  return (
    <kbd className="key-hint" aria-hidden="true">
      {k}
    </kbd>
  );
}
