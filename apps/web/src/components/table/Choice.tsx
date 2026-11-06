import { useState } from 'react';
import type { BettingKind } from '@rsdp/engine/core';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { gameTitle, getVariant } from '@rsdp/engine/variants';
import { call } from '../../socket';
import { Modal } from '../SeatDialog';
import { useNow } from '../Table';
import { choiceOf } from '../settings/dealersChoice';

/*
 * Dealer's choice at the table (D31): the Pick chip on the next chooser's seat, the line on the felt while they
 * pick, and the chooser's "Pick the next game" panel.
 */

/** Seconds left on a clock, or null. */
const secondsTo = (deadline: number | null | undefined, now: number) => (deadline == null ? null : Math.max(0, Math.ceil((deadline - now) / 1000)));

/** I hold the Pick chip and may pick now. */
export const canPickNow = (view: TableView) => !!view.choice?.open && view.choice.chip !== null && view.choice.chip === view.me.seat;

/** The table is waiting for my pick (its clock is running), so it calls me like a turn to act. */
export const myPickDue = (view: TableView) => canPickNow(view) && view.choice!.deadline !== null && !view.paused;

/** The Pick chip, on the nameplate of whoever picks the next game. */
export function PickTag({ view, seat }: { view: TableView; seat: SeatView }) {
  if (view.choice?.chip !== seat.seat) return null;
  return (
    <span className="tag pick-tag" title="Picks the next game (Dealer's choice)">
      Pick
    </span>
  );
}

/** Between hands while the table waits for a pick: who is picking, and the time left. In the "Next hand in" spot. */
export function ChoiceLine({ view, now }: { view: TableView; now: number }) {
  const c = view.choice;
  const live = !!view.hand && view.hand.phase !== 'complete';
  if (!c || live || !view.started || c.deadline === null) return null;
  const secs = secondsTo(c.deadline, now);
  const who = c.chip !== null ? view.seats[c.chip] : null;
  if (!who) return null;
  return (
    <div className="next-hand choice-line">
      {who.playerId === view.me.playerId ? 'Your pick: choose the next game' : `${who.name} is picking the next game`}
      {view.paused ? '' : ` · ${secs}`}
    </div>
  );
}

/** Top bar: whose pick the game is, and how long it has left. */
export function choiceText(view: TableView): string | null {
  const c = view.choice;
  if (!c?.current) return null;
  const by = c.current.by ? `${c.current.by}'s pick` : null;
  const left = c.handsLeft === null ? null : c.handsLeft === 0 ? 'last hand' : `${c.handsLeft} more hand${c.handsLeft === 1 ? '' : 's'}`;
  return [by, left].filter(Boolean).join(' · ') || null;
}

/**
 * The chooser's panel: every game on the menu, with How to play for each (it opens on top), greyed out when it
 * seats fewer than are at the table. Opens by itself when the table is waiting; during the last hand of a pick
 * the chooser opens it from the top bar.
 */
export function GamePicker({ view, skew, onClose, onRules }: { view: TableView; skew: number; onClose: () => void; onRules: (gameId: string, betting: BettingKind) => void }) {
  const c = view.choice;
  const now = useNow(!!c?.deadline && !view.paused, 250) + skew;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!c) return null;
  const menu = choiceOf(view.settings).games;
  const secs = view.paused ? secondsTo(c.deadline, view.serverNow) : secondsTo(c.deadline, now);
  const current = c.current;
  const pick = (index: number) => {
    setBusy(true);
    setError('');
    call('hand:chooseGame', { index, ...(view.hand ? { handNumber: view.hand.handNumber } : {}) })
      .then(onClose)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const keepIndex = current ? menu.findIndex((g) => g.gameId === current.gameId && g.betting === current.betting) : -1;
  const fallback = menu[c.defaultIndex];
  return (
    <Modal title="Pick the next game" onClose={onClose}>
      <div className="game-picker">
        <p className="muted">
          {c.deadline !== null
            ? `${secs} second${secs === 1 ? '' : 's'} left. `
            : 'You pick once this hand is over; you can choose now. '}
          {c.handsLeft === null && !current ? 'The first game' : 'Your game'} lasts {view.settings.game.dealersChoice?.hands ? `${view.settings.game.dealersChoice.hands} hands` : 'one orbit'}
          {fallback ? `. If time runs out: ${gameTitle(fallback.gameId, fallback.betting)}.` : '.'}
        </p>
        {c.canKeep && keepIndex >= 0 && current && (
          <button className="primary" disabled={busy} onClick={() => pick(keepIndex)}>
            Keep playing {current.gameName}
          </button>
        )}
        <ul className="game-picker-list">
          {menu.map((g, i) => {
            const seats = getVariant(g.gameId).maxPlayers;
            const fits = seats >= c.count;
            const title = gameTitle(g.gameId, g.betting);
            return (
              <li key={`${g.gameId}/${g.betting}`} className={fits ? '' : 'greyed'}>
                <button className="game-picker-pick" disabled={busy || !fits} onClick={() => pick(i)} aria-describedby={fits ? undefined : `pick-why-${i}`}>
                  {title}
                </button>
                {!fits && (
                  <span className="muted" id={`pick-why-${i}`}>
                    Seats {seats} · {c.count} are sitting down
                  </span>
                )}
                <button type="button" className="link" onClick={() => onRules(g.gameId, g.betting)} aria-label={`How to play ${title}`}>
                  How to play
                </button>
              </li>
            );
          })}
        </ul>
        {error && <p className="error">{error}</p>}
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
