import type { BettingKind } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { BETTING_NAME } from '../format';
import { GameGuide } from '../rules/GameGuide';
import { extrasOn } from '../rules/extras';
import { Modal } from './SeatDialog';

const BETTING_RULES = {
  'no-limit': 'You may bet or raise any amount up to everything in front of you. A raise must be at least as big as the last bet or raise.',
  'pot-limit': 'The most you may bet or raise is the size of the pot (counting your call first).',
  'fixed-limit':
    'Bets and raises come in one fixed size: the small bet on the early streets, the big bet on the later ones. Each round allows a bet and a few raises.',
} as const;

/** How to play the game on the table now (and the others in a rotation) and the side games switched on here, with guides to everything else too. */
export function RulesDialog({ view, gameId, betting: asked, onClose }: { view: TableView; gameId?: string; betting?: BettingKind; onClose: () => void }) {
  const rot = view.settings.game.rotation;
  const menu = view.settings.game.dealersChoice?.enabled ? view.settings.game.dealersChoice.games : [];
  // Dealer's choice lists every game on the menu; `gameId` opens one of them (from the chooser's panel).
  const ids = menu.length
    ? [...new Set(menu.map((g) => g.gameId))]
    : rot.enabled && rot.steps.length
      ? [...new Set(rot.steps.map((s) => s.gameId))]
      : [view.hand?.gameId ?? view.settings.game.gameId];
  const current = gameId ?? view.hand?.gameId ?? view.upcoming?.gameId ?? ids[0];
  const betting = asked ?? view.hand?.betting ?? view.upcoming?.betting ?? view.settings.game.betting;
  return (
    <Modal title="How to play" onClose={onClose}>
      <div className="rules">
        {/* Keyed so the guide follows the rotation to the next game. */}
        <GameGuide key={current} gameIds={[current, ...ids]} extraIds={extrasOn(view.settings)} current={current} settings={view.settings} />
        <section>
          <h3>Betting here: {BETTING_NAME[betting]}</h3>
          <p>{BETTING_RULES[betting]}</p>
        </section>
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
