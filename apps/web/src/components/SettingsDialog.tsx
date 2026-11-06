import { useState } from 'react';
import '@rsdp/engine/modifiers';
import type { BettingKind } from '@rsdp/engine/core';
import { getModifierSchema, SETTINGS_LIMITS, type SettingsPatch, type TableSettings } from '@rsdp/engine/settings';
import { getVariant, VARIANT_LIST } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import { BETTING_NAME, fromInput, studBringIn, toInput } from '../format';
import { Modal } from './SeatDialog';
import { BettingNudge } from './BettingNudge';
import { Field } from './settings/fields';
import { SideGamesTab } from './settings/SideGamesTab';
import { PresetsTab } from './settings/PresetsTab';
import { canAddGame, canAddLevel, nextBlindLevel } from './settings/lists';

type Tab = 'game' | 'stakes' | 'clock' | 'seats' | 'rules' | 'side' | 'chat' | 'presets';
const TABS: { id: Tab; label: string }[] = [
  { id: 'game', label: 'Game' },
  { id: 'stakes', label: 'Stakes' },
  { id: 'clock', label: 'Clock' },
  { id: 'seats', label: 'Seats' },
  { id: 'rules', label: 'Rules' },
  { id: 'side', label: 'Side games' },
  { id: 'chat', label: 'Chat & watching' },
  { id: 'presets', label: 'Presets' },
];
const BETTINGS: BettingKind[] = ['no-limit', 'pot-limit', 'fixed-limit'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The fields of `next` that differ from `prev`, nested like the settings. Lists are sent whole. */
function diff(prev: unknown, next: unknown): unknown {
  if (isObject(prev) && isObject(next)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      const d = diff(prev[key], next[key]);
      if (d !== undefined) out[key] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(prev) === JSON.stringify(next) ? undefined : next;
}

const maxSeatsFor = (gameIds: string[]) => Math.min(...gameIds.map((id) => getVariant(id).maxPlayers));

/** A stud ante of about a quarter of the small bet (1 at 1/2 limit, the same as a new table), never below one chip; in nickels in dollars (0.10 at .50/1). */
export const defaultStudAnte = (stakes: TableSettings['stakes']) => {
  const quarter = (stakes.smallBet || stakes.bigBlind) / 4;
  return stakes.centsMode && quarter >= 5 ? Math.floor(quarter / 5) * 5 : Math.max(1, Math.round(quarter));
};

export function SettingsDialog({ view, onClose }: { view: TableView; onClose: () => void }) {
  const [draft, setDraft] = useState<TableSettings>(() => structuredClone(view.settings));
  const [tab, setTab] = useState<Tab>('game');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cents = draft.stakes.centsMode;
  const handLive = !!view.hand && view.hand.phase !== 'complete';
  const tournament = view.mode === 'tournament';
  const seated = view.seats.filter(Boolean).length;

  /** Edit one section of the draft. */
  const set = <K extends keyof TableSettings>(section: K, patch: Partial<TableSettings[K]>) =>
    setDraft((d) => ({ ...d, [section]: { ...(d[section] as object), ...patch } }));

  const setModifier = (id: string, patch: object) =>
    setDraft((d) => {
      const cur = (getModifierSchema(id)?.get(d) as object | undefined) ?? {};
      return { ...d, modifiers: { ...d.modifiers, [id]: { ...cur, ...patch } } };
    });

  const games = draft.game.rotation.enabled && draft.game.rotation.steps.length ? draft.game.rotation.steps.map((s) => s.gameId) : [draft.game.gameId];
  const seatLimit = maxSeatsFor(games);

  // A game with fewer seats than the table: say up front who has to leave, or who moves seats.
  const tightest = games.map((id) => getVariant(id)).reduce((a, b) => (b.maxPlayers < a.maxPlayers ? b : a));
  const newSeats = Math.min(draft.table.maxSeats, seatLimit);
  const tooMany = !tournament && seated > newSeats;
  const moving = view.seats.flatMap((x, i) => (x && i >= newSeats ? [i + 1] : []));
  const seatNote = tooMany
    ? seated > seatLimit
      ? `${games.length > 1 ? `${tightest.name}, one of the games in the rotation,` : tightest.name} seats at most ${seatLimit} players and ${seated} are sitting down. ${seated - seatLimit} ${seated - seatLimit === 1 ? 'player needs' : 'players need'} to leave the table (or remove ${seated - seatLimit === 1 ? 'a bot' : 'some bots'}) before you can switch.`
      : `${seated} players are sitting down, so the table needs at least ${seated} seats.`
    : !tournament && moving.length
      ? `The table goes down to ${newSeats} seats. ${moving.length === 1 ? 'The player' : 'Players'} in seat${moving.length === 1 ? '' : 's'} ${moving.join(' and ').replace(/ and (?=.* and )/g, ', ')} will move to ${moving.length === 1 ? 'a free seat' : 'free seats'}${handLive ? ' when this hand ends' : ''}.`
      : '';

  const pickGame = (gameId: string) => {
    const spec = getVariant(gameId);
    setDraft((d) => {
      // Stud is meant to be played with antes; without one the pot starts with the bring-in alone.
      const needsAnte = spec.forcedBets === 'ante-bring-in' && d.stakes.ante === 0;
      return {
        ...d,
        game: { ...d.game, gameId, betting: spec.defaultBetting },
        table: { ...d.table, maxSeats: Math.min(d.table.maxSeats, spec.maxPlayers) },
        stakes: {
          ...d.stakes,
          ...(needsAnte ? { ante: defaultStudAnte(d.stakes), anteType: 'per-player' as const } : {}),
          ...(spec.forcedBets === 'ante-bring-in' && d.stakes.bringIn === 0 ? { bringIn: studBringIn(d.stakes.smallBet || d.stakes.bigBlind, d.stakes.centsMode) } : {}),
        },
      };
    });
  };

  const save = () => {
    const fixed = { ...draft, table: { ...draft.table, maxSeats: Math.min(draft.table.maxSeats, seatLimit) } };
    const patch = diff(view.settings, fixed) as SettingsPatch | undefined;
    if (!patch) return onClose();
    setBusy(true);
    call('host:settings', { patch })
      .then(onClose)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const chipsField = (label: string, value: number, onChange: (v: number) => void, hint?: string) => (
    <Field label={label} hint={hint}>
      <input type="number" min={0} step={cents ? 0.01 : 1} value={toInput(cents, value)} onChange={(e) => onChange(fromInput(cents, +e.target.value))} />
    </Field>
  );
  const numberField = (label: string, value: number, onChange: (v: number) => void, min: number, max: number, hint?: string) => (
    <Field label={label} hint={hint}>
      <input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.round(+e.target.value))} />
    </Field>
  );
  const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );

  const rot = draft.game.rotation;
  const sched = draft.blindSchedule;

  return (
    <Modal title="Table settings" onClose={onClose}>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings-body">
        {tab === 'game' && (
          <>
            <Field label="Table name">
              <input value={draft.table.name} maxLength={40} onChange={(e) => set('table', { name: e.target.value })} />
            </Field>
            {!tournament && (
              <>
                <div className="row">
                  <Field label="Game">
                    <select value={draft.game.gameId} onChange={(e) => pickGame(e.target.value)}>
                      {VARIANT_LIST.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Betting">
                    <select value={draft.game.betting} onChange={(e) => set('game', { betting: e.target.value as BettingKind })}>
                      {BETTINGS.map((b) => (
                        <option key={b} value={b}>
                          {BETTING_NAME[b]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {!rot.enabled && <BettingNudge gameId={draft.game.gameId} betting={draft.game.betting} onSwitch={(betting) => set('game', { betting })} />}
                {numberField('Seats', Math.min(draft.table.maxSeats, seatLimit), (v) => set('table', { maxSeats: v }), Math.max(2, seated), seatLimit, `Up to ${seatLimit} for ${games.length > 1 ? 'these games' : 'this game'}.`)}
                {seatNote && !tooMany && <p className="hint">{seatNote}</p>}
                {toggle('Rotate games (mixed games)', rot.enabled, (enabled) =>
                  set('game', {
                    rotation: { ...rot, enabled, steps: rot.steps.length ? rot.steps : [{ gameId: draft.game.gameId, betting: draft.game.betting, length: 1, unit: 'orbits' }] },
                  }),
                )}
                {rot.enabled && (
                  <div className="list-editor">
                    {rot.steps.map((st, i) => {
                      const update = (p: Partial<typeof st>) =>
                        set('game', { rotation: { ...rot, steps: rot.steps.map((x, j) => (j === i ? { ...x, ...p } : x)) } });
                      return (
                        <div key={i}>
                          <div className="row">
                            <select value={st.gameId} onChange={(e) => update({ gameId: e.target.value, betting: getVariant(e.target.value).defaultBetting })}>
                              {VARIANT_LIST.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                            </select>
                            <select value={st.betting} onChange={(e) => update({ betting: e.target.value as BettingKind })}>
                              {BETTINGS.map((b) => (
                                <option key={b} value={b}>
                                  {BETTING_NAME[b]}
                                </option>
                              ))}
                            </select>
                            <input type="number" min={1} value={st.length} onChange={(e) => update({ length: Math.max(1, Math.round(+e.target.value)) })} />
                            <select value={st.unit} onChange={(e) => update({ unit: e.target.value as 'hands' | 'orbits' })}>
                              <option value="hands">hands</option>
                              <option value="orbits">orbits</option>
                            </select>
                            <button
                              type="button"
                              disabled={rot.steps.length <= 1}
                              onClick={() => set('game', { rotation: { ...rot, steps: rot.steps.filter((_, j) => j !== i) } })}
                            >
                              ✕
                            </button>
                          </div>
                          {/* Rows are keyed by position, so a removed row would hand its note to the next one: start them afresh. */}
                          <BettingNudge key={rot.steps.length} gameId={st.gameId} betting={st.betting} onSwitch={(betting) => update({ betting })} />
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      disabled={!canAddGame(rot.steps)}
                      title={canAddGame(rot.steps) ? undefined : `A rotation holds up to ${SETTINGS_LIMITS.rotationSteps.max} games`}
                      onClick={() => set('game', { rotation: { ...rot, steps: [...rot.steps, { ...rot.steps[rot.steps.length - 1] }] } })}
                    >
                      Add game
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === 'stakes' && !tournament && (
          <>
            <div className="row">
              {chipsField('Small blind', draft.stakes.smallBlind, (v) => set('stakes', { smallBlind: v }))}
              {chipsField('Big blind', draft.stakes.bigBlind, (v) => set('stakes', { bigBlind: v }))}
            </div>
            <div className="row">
              {chipsField('Ante', draft.stakes.ante, (v) => set('stakes', { ante: v, anteType: v > 0 && draft.stakes.anteType === 'none' ? 'per-player' : draft.stakes.anteType }))}
              <Field label="Who antes">
                <select value={draft.stakes.anteType} onChange={(e) => set('stakes', { anteType: e.target.value as TableSettings['stakes']['anteType'], ante: e.target.value === 'none' ? 0 : draft.stakes.ante })}>
                  <option value="none">No ante</option>
                  <option value="per-player">Everyone</option>
                  <option value="big-blind">Big blind (for the table)</option>
                </select>
              </Field>
            </div>
            <div className="row">
              {chipsField('Stud bring-in', draft.stakes.bringIn, (v) => set('stakes', { bringIn: v }), '0 = a third of the small bet')}
            </div>
            <div className="row">
              {chipsField('Limit small bet', draft.stakes.smallBet, (v) => set('stakes', { smallBet: v }), '0 = the big blind')}
              {chipsField('Limit big bet', draft.stakes.bigBet, (v) => set('stakes', { bigBet: v }), '0 = twice the small bet')}
            </div>
            {toggle('Raise the blinds on a schedule', sched.enabled, (enabled) =>
              set('blindSchedule', {
                enabled,
                levels: sched.levels.length
                  ? sched.levels
                  : [{ smallBlind: draft.stakes.smallBlind, bigBlind: draft.stakes.bigBlind, ante: draft.stakes.ante, minutes: 20, hands: 30 }],
              }),
            )}
            {sched.enabled && (
              <div className="list-editor">
                <Field label="Levels change">
                  <select value={sched.countdown} onChange={(e) => set('blindSchedule', { countdown: e.target.value as typeof sched.countdown })}>
                    <option value="per-level-timer">On a timer</option>
                    <option value="hands">After a number of hands</option>
                  </select>
                </Field>
                <div className="row head">
                  <span>SB</span>
                  <span>BB</span>
                  <span>Ante</span>
                  <span>{sched.countdown === 'hands' ? 'Hands' : 'Minutes'}</span>
                  <span />
                </div>
                {sched.levels.map((lv, i) => {
                  const update = (p: Partial<typeof lv>) => set('blindSchedule', { levels: sched.levels.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                  const amount = (k: 'smallBlind' | 'bigBlind' | 'ante') => (
                    <input type="number" min={0} step={cents ? 0.01 : 1} value={toInput(cents, lv[k])} onChange={(e) => update({ [k]: fromInput(cents, +e.target.value) })} />
                  );
                  return (
                    <div className="row" key={i}>
                      {amount('smallBlind')}
                      {amount('bigBlind')}
                      {amount('ante')}
                      {sched.countdown === 'hands' ? (
                        <input type="number" min={1} value={lv.hands} onChange={(e) => update({ hands: Math.max(1, Math.round(+e.target.value)) })} />
                      ) : (
                        <input type="number" min={2} value={lv.minutes} onChange={(e) => update({ minutes: Math.max(2, Math.round(+e.target.value)) })} />
                      )}
                      <button type="button" disabled={sched.levels.length <= 1} onClick={() => set('blindSchedule', { levels: sched.levels.filter((_, j) => j !== i) })}>
                        ✕
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  disabled={!canAddLevel(sched.levels)}
                  title={canAddLevel(sched.levels) ? undefined : `A schedule holds up to ${SETTINGS_LIMITS.blindLevels.max} levels`}
                  onClick={() => set('blindSchedule', { levels: [...sched.levels, nextBlindLevel(sched.levels[sched.levels.length - 1])] })}
                >
                  Add level
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'stakes' && tournament && <p className="muted">The tournament sets the blinds.</p>}

        {tab === 'clock' && (
          <>
            {numberField('Seconds to act', draft.timing.decisionSeconds, (v) => set('timing', { decisionSeconds: v }), 0, 600, '0 = no clock, otherwise 5 to 600')}
            <div className="row">
              {numberField('Time bank (seconds)', draft.timing.timeBankSeconds, (v) => set('timing', { timeBankSeconds: v }), 0, 300)}
              {numberField('Refill every (hands)', draft.timing.timeBankRefillHands, (v) => set('timing', { timeBankRefillHands: v }), 0, 200, '0 = never')}
            </div>
            {toggle('Use the time bank automatically', draft.timing.autoActivateTimeBank, (autoActivateTimeBank) => set('timing', { autoActivateTimeBank }))}
            {!tournament && toggle('Deal the next hand automatically', draft.timing.autoStartNextHand, (autoStartNextHand) => set('timing', { autoStartNextHand }))}
            <div className="row">
              <Field label="Showdown pause">
                <select value={draft.timing.showdownSeconds} onChange={(e) => set('timing', { showdownSeconds: +e.target.value as 3 | 6 | 9 })}>
                  {[3, 6, 9].map((s) => (
                    <option key={s} value={s}>
                      {s} seconds
                    </option>
                  ))}
                </select>
              </Field>
              {numberField('Pause between hands (s)', draft.timing.nextHandDelaySeconds, (v) => set('timing', { nextHandDelaySeconds: v }), 0, 30)}
            </div>
          </>
        )}

        {tab === 'seats' && (
          <>
            {!tournament && (
              <>
                {toggle('Approve new players', draft.seating.requireApproval, (requireApproval) => set('seating', { requireApproval }))}
                {toggle('Allow rebuys', draft.seating.allowRebuys, (allowRebuys) => set('seating', { allowRebuys }))}
                {toggle('Approve rebuys', draft.seating.rebuyRequiresApproval, (rebuyRequiresApproval) => set('seating', { rebuyRequiresApproval }), !draft.seating.allowRebuys)}
                <div className="row">
                  {chipsField('Minimum buy-in', draft.seating.minBuyIn, (v) => set('seating', { minBuyIn: v }), '0 = none')}
                  {chipsField('Maximum buy-in', draft.seating.maxBuyIn, (v) => set('seating', { maxBuyIn: v }), '0 = none')}
                </div>
                {numberField('Return with your old stack within (minutes)', draft.seating.ratholeMinutes, (v) => set('seating', { ratholeMinutes: v }), 0, 1440, '0 = off')}
                {toggle('Waitlist when the table is full', draft.seating.waitlist, (waitlist) => set('seating', { waitlist }))}
                <span className="hint">When a seat comes free it is held for the next person in line for a minute.</span>
                {toggle('Seat new players at random', !!draft.seating.randomSeats, (randomSeats) => set('seating', { randomSeats }))}
                <span className="hint">Players who sit down get a random open seat instead of the one they clicked.</span>
                {toggle('Players can add practice bots', draft.seating.allowPlayerBots !== false, (allowPlayerBots) => set('seating', { allowPlayerBots }))}
                <span className="hint">Anyone seated can add a bot to practice against (up to three each). You can always add and remove bots.</span>
                {numberField('Free the seat of a player offline for (minutes)', draft.seating.releaseOfflineSeatMinutes, (v) => set('seating', { releaseOfflineSeatMinutes: v }), 0, 1440, '0 = never. Their chips go back to the ledger.')}
              </>
            )}
            <div className="row">
              {numberField('Timeouts before away', draft.seating.awayAfterTimeouts, (v) => set('seating', { awayAfterTimeouts: v }), 0, 10, '0 = never')}
              {numberField('Disconnect grace (s)', draft.seating.offlineGraceSeconds, (v) => set('seating', { offlineGraceSeconds: v }), 0, 300)}
            </div>
            {toggle('Keep dealing to away players (they check or fold)', draft.seating.dealToAway, (dealToAway) => set('seating', { dealToAway }))}
            {toggle('Players can throw gestures at each other', draft.chat.gestures !== false, (gestures) => set('chat', { gestures }))}
          </>
        )}

        {tab === 'chat' && (
          <>
            {toggle('Spectators can chat', draft.chat.guestChat, (guestChat) => set('chat', { guestChat }))}
            <span className="hint">Off: only seated players and the host can chat.</span>
            {toggle('Hide swear words in chat', draft.chat.profanityFilter, (profanityFilter) => set('chat', { profanityFilter }))}
            <h4>Watching</h4>
            {toggle(
              'Let people watch',
              draft.spectators.allowed,
              (allowed) => set('spectators', { allowed }),
              // Watching again would show every card of the hand in progress.
              handLive && !view.settings.spectators.allowed && view.settings.spectators.seeAllCards && !draft.spectators.allowed,
            )}
            <span className="hint">Off: people who aren't seated see the seats but not the hand.</span>
            {toggle(
              'Spectators see every hole card',
              draft.spectators.seeAllCards,
              // Turning it on starts with a two-minute delay, so nobody watching can pass cards on during the hand.
              (seeAllCards) => set('spectators', seeAllCards && draft.spectators.delaySeconds === 0 ? { seeAllCards, delaySeconds: 120 } : { seeAllCards }),
              !draft.spectators.allowed || (handLive && !view.settings.spectators.seeAllCards && !draft.spectators.seeAllCards),
            )}
            <span className="hint">
              {handLive && !view.settings.spectators.seeAllCards
                ? 'You can turn this on between hands. '
                : ''}
              Everyone at the table is told when it goes on, sees a red rail and a reminder while it's on, and must agree to it before sitting down.
            </span>
            {numberField('Spectators run behind by (seconds)', draft.spectators.delaySeconds, (v) => set('spectators', { delaySeconds: v }), 0, 600, 'A delay stops anyone passing on what they see. 0 = live.')}
            {draft.spectators.seeAllCards && draft.spectators.delaySeconds === 0 && <p className="error">With no delay, anyone watching can tell a player what everyone holds.</p>}
          </>
        )}

        {tab === 'presets' && <PresetsTab draft={draft} onApply={(next) => setDraft(next)} tournament={tournament} />}

        {tab === 'side' && tournament && <p className="muted">Side games are for cash tables.</p>}
        {tab === 'side' && !tournament && <SideGamesTab draft={draft} cents={cents} setModifier={setModifier} />}

        {tab === 'rules' && (
          <>
            <Field label="Run it twice" hint={tournament ? 'Cash games only.' : undefined}>
              <select disabled={tournament} value={draft.play.runItTwice} onChange={(e) => set('play', { runItTwice: e.target.value as TableSettings['play']['runItTwice'] })}>
                <option value="off">Off</option>
                <option value="ask">Players choose</option>
                <option value="always">Always</option>
              </select>
            </Field>
            <Field label="Straddles" hint={tournament ? 'Cash games only.' : 'Players turn their straddle on from their seat.'}>
              <select disabled={tournament} value={draft.play.straddle} onChange={(e) => set('play', { straddle: e.target.value as TableSettings['play']['straddle'] })}>
                <option value="off">Off</option>
                <option value="utg">Under the gun</option>
                <option value="utg-and-button">Under the gun and button re-straddle</option>
              </select>
            </Field>
            <div className="row">
              {numberField('Limit bets per round', draft.play.fixedLimitCap, (v) => set('play', { fixedLimitCap: v }), 2, 10, 'The bet plus raises')}
            </div>
            {toggle('No cap when heads up', draft.play.uncappedHeadsUp, (uncappedHeadsUp) => set('play', { uncappedHeadsUp }))}
            {toggle('Show every hand at showdown', draft.play.revealAllAtShowdown, (revealAllAtShowdown) => set('play', { revealAllAtShowdown }))}
            <span className="hint">Off: the last bettor shows first and hands that can't win are mucked. Hands are always shown when everyone is all in.</span>
            {toggle('Trim bets nobody can call', draft.play.trimExcessBets, (trimExcessBets) => set('play', { trimExcessBets }))}
            <span className="hint">A bet or all-in is capped at the most anyone left in the hand can put in.</span>
            {toggle('Rabbit hunting', draft.play.rabbitHunt, (rabbitHunt) => set('play', { rabbitHunt }))}
            <span className="hint">After a hand ends early, anyone can peek at the cards that would have come. Only they see them.</span>
          </>
        )}
      </div>
      {handLive && <p className="muted">Changes to the game, stakes and seats take effect when this hand ends.</p>}
      {tooMany && <p className="error">{seatNote}</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy || tooMany} onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}
