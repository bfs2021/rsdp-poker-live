import type { BettingKind } from '@rsdp/engine/core';
import { SETTINGS_LIMITS, type ChoiceGame, type DealersChoiceSettings } from '@rsdp/engine/settings';
import { gameTitle, getVariant, VARIANT_LIST } from '@rsdp/engine/variants';
import { BETTING_NAME } from '../../format';
import { BettingNudge } from '../BettingNudge';
import { Field } from './fields';
import { CHOICE_FILLS, isStud, menuSeats, nextMenuGame, repeatsOf } from './dealersChoice';

const BETTINGS: BettingKind[] = ['no-limit', 'pot-limit', 'fixed-limit'];
const L = SETTINGS_LIMITS;

/**
 * The Game tab's Dealer's choice section (D31): the menu the chooser picks from, with one-tap fills, how long a pick
 * lasts and the time to pick. `setMenu` also sets up the stakes the menu's games need.
 */
export function DealersChoiceFields({
  choice,
  seated,
  onChange,
  setMenu,
}: {
  choice: DealersChoiceSettings;
  seated: number;
  onChange: (patch: Partial<DealersChoiceSettings>) => void;
  setMenu: (games: ChoiceGame[]) => void;
}) {
  const games = choice.games;
  const repeats = new Set(repeatsOf(games));
  const fill = CHOICE_FILLS.find((f) => f.games.length === games.length && f.games.every((g, i) => g.gameId === games[i].gameId && g.betting === games[i].betting));
  const small = games.filter((g) => getVariant(g.gameId).maxPlayers < seated);
  const add = nextMenuGame(games);
  return (
    <div className="choice-fields">
      <p className="muted">
        Players take turns choosing the game from this menu. The Pick chip goes round the table one seat at a time, and each pick lasts{' '}
        {choice.hands ? `${choice.hands} hand${choice.hands === 1 ? '' : 's'}` : 'one orbit'}. The stakes stay the same for every game.
      </p>
      <div className="mixed-game-picks" role="group" aria-label="Fill the menu">
        <span className="muted">Fill the menu with:</span>
        {CHOICE_FILLS.map((f) => (
          <button type="button" key={f.id} className={fill?.id === f.id ? 'on' : ''} aria-pressed={fill?.id === f.id} onClick={() => setMenu(f.games)}>
            {f.name}
          </button>
        ))}
      </div>
      <div className="list-editor" aria-label="The menu">
        {games.map((g, i) => {
          const update = (p: Partial<ChoiceGame>) => setMenu(games.map((x, j) => (j === i ? { ...x, ...p } : x)));
          return (
            <div key={i}>
              <div className="row">
                <select aria-label={`Game ${i + 1}`} value={g.gameId} onChange={(e) => update({ gameId: e.target.value, betting: getVariant(e.target.value).defaultBetting })}>
                  {VARIANT_LIST.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <select aria-label={`Betting for game ${i + 1}`} value={g.betting} onChange={(e) => update({ betting: e.target.value as BettingKind })}>
                  {BETTINGS.map((b) => (
                    <option key={b} value={b}>
                      {BETTING_NAME[b]}
                    </option>
                  ))}
                </select>
                <button type="button" aria-label={`Take ${gameTitle(g.gameId, g.betting)} off the menu`} disabled={games.length <= L.choiceGames.min} onClick={() => setMenu(games.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
              {repeats.has(i) && <p className="error">{gameTitle(g.gameId, g.betting)} is on the menu twice.</p>}
              {/* Rows are keyed by position, so a removed row would hand its note to the next one: start them afresh. */}
              <BettingNudge key={games.length} gameId={g.gameId} betting={g.betting} onSwitch={(betting) => update({ betting })} />
            </div>
          );
        })}
        <button
          type="button"
          disabled={!add || games.length >= L.choiceGames.max}
          title={games.length >= L.choiceGames.max ? `The menu holds up to ${L.choiceGames.max} games` : undefined}
          onClick={() => add && setMenu([...games, add])}
        >
          Add game
        </button>
      </div>
      {games.length < L.choiceGames.min && <p className="error">Put at least two games on the menu.</p>}
      {small.length > 0 && (
        <p className="hint">
          {small.map((g) => gameTitle(g.gameId, g.betting)).join(', ')} {small.length === 1 ? 'seats' : 'seat'} fewer than the {seated} players sitting down, so{' '}
          {small.length === 1 ? 'it is' : 'they are'} greyed out until enough players leave.
        </p>
      )}
      {games.some((g) => isStud(g.gameId)) && <p className="muted">With a stud game on the menu, only the stud games ante; the others play on the blinds, and the Limit games bet the Limit amounts in Stakes.</p>}
      <div className="row">
        <Field label="Each pick lasts">
          <select value={choice.hands ? 'hands' : 'orbit'} onChange={(e) => onChange({ hands: e.target.value === 'orbit' ? 0 : choice.hands || 6 })}>
            <option value="orbit">One orbit</option>
            <option value="hands">A set number of hands</option>
          </select>
        </Field>
        {choice.hands > 0 && (
          <Field label="Hands">
            <input type="number" min={1} max={L.choiceHands.max} value={choice.hands} onChange={(e) => onChange({ hands: Math.min(L.choiceHands.max, Math.max(1, Math.round(+e.target.value))) })} />
          </Field>
        )}
        <Field label="Time to pick (seconds)" hint="If time runs out, the current game carries on.">
          <input
            type="number"
            min={L.pickSeconds.min}
            max={L.pickSeconds.max}
            value={choice.pickSeconds}
            onChange={(e) => onChange({ pickSeconds: Math.min(L.pickSeconds.max, Math.max(L.pickSeconds.min, Math.round(+e.target.value))) })}
          />
        </Field>
      </div>
      <p className="muted">Up to {menuSeats(games)} seats, for the biggest game on the menu.</p>
    </div>
  );
}
