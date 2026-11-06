import { useEffect, useState } from 'react';
import type { HostPower } from '@rsdp/engine/roles';
import {
  isTournamentStaff,
  finishPrizes,
  placePrizes,
  playerOptions,
  standings,
  summarize,
  tableAddress,
  tableRulesOf,
  tournamentPowers,
  type Command,
  type StructureRow,
  type TournamentState,
} from '@rsdp/tournament';
import { LocalTournamentClient, tournamentClient, type Session } from './client';
import { blinds, chips, clockText, countdown, gamesText, localTime, money, ordinal, tableRulesText } from './format';
import { navigate, useFollowSeat, useNow, useSession, useTournament } from './hooks';
import { savedName } from '../socket';
import { CoHostPanel, EventPanel, PlayerManager, RequestRow } from './HostPanels';
import { InvitesPanel } from './InvitesPanel';
import { PrizeList } from './PayoutEditor';
import { StructureEditor, StructureTable } from './StructureEditor';
import { TableRulesEditor } from './TableRules';
import { AlertsToggle } from './TournamentAlerts';
import { downloadResults, downloadTableChat } from './results';
import { Activity, LobbyChat, useLobbyLog, useUnreadChat } from './LobbyLog';
import { SiteHeader } from '../components/SiteHeader';
import { initialsColor } from '../components/table/Persona';

type Tab = 'players' | 'tables' | 'chat' | 'activity' | 'structure' | 'payouts' | 'host';

const STATUS_LABEL: Record<TournamentState['status'], string> = {
  registering: 'Registering',
  seating: 'Seats drawn',
  running: 'Running',
  paused: 'Paused',
  finished: 'Finished',
  cancelled: 'Cancelled',
};

/** Sends a command and reports the server's refusal, if any. */
function useSend(id: string) {
  const [error, setError] = useState('');
  const send = async (command: Command): Promise<boolean> => {
    setError('');
    try {
      await tournamentClient().send(id, command);
      return true;
    } catch (e) {
      setError(sentence((e as Error).message));
      return false;
    }
  };
  return { send, error, clear: () => setError('') };
}

/** Server messages are lower case; show them as sentences. */
const sentence = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

export function TournamentLobby({ id }: { id: string }) {
  const { state, skew, nextId, nextError, error } = useTournament(id);
  const session = useSession();
  const now = useNow() + skew;
  const [tab, setTab] = useState<Tab>('players');
  const { send, error: sendError } = useSend(id);
  useFollowSeat(null);
  const log = useLobbyLog(id);
  const unread = useUnreadChat(log, tab === 'chat', session?.playerId, skew);

  if (error || !state)
    return (
      <div className="site-page">
        <SiteHeader />
        <main className="tn-page">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>
      </div>
    );

  // The host and co-hosts see the host tools, each with their own powers.
  const isHost = isTournamentStaff(state, session?.playerId);
  const powers = tournamentPowers(state, session?.playerId);
  const sum = summarize(state, now);
  const tabs: [Tab, string][] = [
    ['players', `Players (${sum.entrants})`],
    ['tables', `Tables${sum.tables ? ` (${sum.tables})` : ''}`],
    ['chat', `Chat${unread ? ` (${unread})` : ''}`],
    ['activity', 'Activity'],
    ['structure', 'Structure'],
    ...(state.settings.payouts ? ([['payouts', 'Payouts']] as [Tab, string][]) : []),
    ...(isHost ? ([['host', `Host${state.requests.length ? ` (${state.requests.length})` : ''}`]] as [Tab, string][]) : []),
  ];

  return (
    <div className="site-page">
      <SiteHeader />
      <main className="tn-page">
        <header className="tn-header">
          <div className="tn-title">
            <h1>{state.settings.name}</h1>
            <span className={`tn-status tn-status-${state.status}`}>{STATUS_LABEL[state.status]}</span>
          </div>
          <p className="muted">
            {gamesText(state.settings)} · {chips(state.settings.startingStack)} chips · {state.settings.seatsPerTable}-max · {clockText(tableRulesOf(state.settings))}
            {state.settings.start.kind === 'sng' ? ' · Sit & Go' : ''}
            {state.settings.bounty ? ` · ${money(state.settings.bounty.amount)} ${state.settings.bounty.progressivePercent > 0 ? 'progressive bounty' : 'bounty'}` : ''}
          </p>
          <div className="tn-header-actions">
            <ShareLink />
            <AlertsToggle />
          </div>
        </header>

        <Hero state={state} now={now} />
        {(state.status === 'registering' || state.status === 'seating') && powers.includes('run') && <HostStart state={state} by={session!.playerId} send={send} />}
        {state.settings.season && !(tournamentClient() instanceof LocalTournamentClient) && (
          <p className="tn-windows">
            <a href={`/season/${state.settings.season.id}`}>{state.settings.season.name}: season standings →</a>
          </p>
        )}
        {nextId && (
          <p className="tn-windows">
            <a href={`/tn/${nextId}`}>{state.settings.start.kind === 'sng' ? 'The next Sit & Go is open' : 'The next one in this series is open'} →</a>
          </p>
        )}
        {!nextId && nextError && (
          <p className="error tn-windows">
            {state.settings.start.kind === 'sng' ? 'The next Sit & Go' : 'The next one in this series'} could not be made: {nextError}
          </p>
        )}
        <Stats state={state} now={now} />
        <MyPanel state={state} session={session} skew={skew} send={send} />
        {sendError && <p className="error tn-toast">{sendError}</p>}

        <nav className="tn-tabs" role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>
        <section className="tn-card">
          {tab === 'players' && <Players state={state} me={session?.playerId} />}
          {tab === 'tables' && <Tables state={state} me={session?.playerId} />}
          {tab === 'chat' && (
            <>
              {mayDownloadTableChat(state, session?.playerId) && (
                <>
                  <p className="muted">This is the lobby chat. What was said at the tables is in this download:</p>
                  <TableChatDownload state={state} />
                </>
              )}
              <LobbyChat id={id} items={log} session={session} />
            </>
          )}
          {tab === 'activity' && <Activity items={log} />}
          {tab === 'structure' && (
            <>
              <p>
                <strong>At the tables:</strong> {tableRulesText(tableRulesOf(state.settings))}
              </p>
              <StructureTable rows={state.settings.structure} currentRow={sum.clock && state.status !== 'finished' ? state.clock.rowIndex : undefined} />
              <p className="muted">
                <a href={`/tn/new?from=${state.id}`}>Copy these settings into a new tournament</a>
              </p>
            </>
          )}
          {tab === 'payouts' && <Payouts state={state} now={now} />}
          {tab === 'host' && isHost && session && <HostTools state={state} me={session.playerId} powers={powers} send={send} />}
        </section>
        {tournamentClient() instanceof LocalTournamentClient && <DemoTools state={state} />}
      </main>
    </div>
  );
}

/** The host's Start button, up by the clock where it's easy to find, not only in the Host tab. */
function HostStart({ state, by, send }: { state: TournamentState; by: string; send: (c: Command) => Promise<boolean> }) {
  // With check-in on, only checked-in players count towards the two needed to start.
  const n = state.entries.filter((e) => e.status === 'registered' && (!state.settings.checkIn || e.checkedInAt !== undefined)).length;
  return (
    <div className="tn-card tn-host-start">
      <span>
        {state.settings.start.kind === 'manual' ? 'Start the tournament when everyone is in.' : 'You can start early if everyone is here.'}
        <span className="muted">
          {' '}
          {n} {n === 1 ? 'player' : 'players'} {state.settings.checkIn ? 'checked in' : 'registered'}.
        </span>
      </span>
      <button className="primary" disabled={state.status === 'registering' && n < 2} onClick={() => send({ type: 'startNow', by })}>
        Start now
      </button>
    </div>
  );
}

function ShareLink() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="tn-share"
      onClick={() => {
        navigator.clipboard?.writeText(location.href).then(() => setCopied(true), () => {});
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? 'Link copied' : 'Copy invite link'}
    </button>
  );
}

/** The big clock: countdown to the start, the level clock, or the result. */
function Hero({ state, now }: { state: TournamentState; now: number }) {
  const sum = summarize(state, now);
  if (state.status === 'cancelled') return <div className="tn-hero"><p className="tn-hero-main">Cancelled</p></div>;
  if (state.status === 'finished') {
    const winner = standings(state).find((s) => s.place === 1);
    return (
      <div className="tn-hero">
        <p className="tn-hero-label">Winner</p>
        <p className="tn-hero-main">🏆 {winner?.displayName ?? '–'}</p>
      </div>
    );
  }
  if (!sum.clock) {
    return (
      <div className="tn-hero">
        {sum.msToCancel !== null ? (
          <>
            <p className="tn-hero-label">Waiting for a second player</p>
            <p className="tn-hero-main">{countdown(sum.msToCancel)}</p>
            <p className="muted">Starts the moment someone else registers; cancels when this runs out.</p>
          </>
        ) : sum.playersNeeded !== null ? (
          <>
            <p className="tn-hero-label">Starts when full</p>
            <p className="tn-hero-main">{sum.playersNeeded} more</p>
          </>
        ) : sum.msToStart !== null ? (
          <>
            <p className="tn-hero-label">{state.status === 'seating' ? 'Cards in the air in' : 'Starts automatically in'}</p>
            <p className="tn-hero-main">{countdown(sum.msToStart)}</p>
            <p className="muted">{localTime(state.startAt!)}</p>
          </>
        ) : (
          <>
            <p className="tn-hero-label">Starts when the host starts it</p>
            <p className="tn-hero-main">{sum.playersLeft} registered</p>
          </>
        )}
      </div>
    );
  }
  const c = sum.clock;
  const levels = state.settings.structure.filter((r) => r.kind === 'level').length;
  return (
    <div className={`tn-hero ${c.onBreak ? 'tn-on-break' : ''}`}>
      <p className="tn-hero-label">
        {c.onBreak ? `Break after level ${c.levelNumber}` : `Level ${c.levelNumber} of ${levels}`}
        {state.status === 'paused' ? ' · paused' : ''}
        {sum.handForHand ? ' · hand-for-hand' : ''}
      </p>
      <p className="tn-hero-main">{c.msLeft === null ? '∞' : countdown(c.msLeft)}</p>
      <p className="tn-hero-blinds">{c.onBreak ? `Next: ${blinds(c.level)}` : blinds(c.level)}</p>
      <p className="muted">
        {!c.onBreak && c.nextLevel ? `Next ${blinds(c.nextLevel)}` : ''}
        {c.msToBreak !== null ? ` · break in ${countdown(c.msToBreak)}` : ''}
      </p>
    </div>
  );
}

function Stats({ state, now }: { state: TournamentState; now: number }) {
  const sum = summarize(state, now);
  // A finished tournament has no stacks left to compare; the hero shows the winner.
  const items: [string, string][] = state.status === 'finished'
    ? [['Players', `${sum.entrants}`]]
    : [
        ['Players', sum.clock ? `${sum.playersLeft} / ${sum.entrants}` : `${sum.entrants}${state.settings.maxEntrants < 600 ? ` / ${state.settings.maxEntrants}` : ''}`],
        ['Average stack', sum.clock ? chips(sum.averageStack) : '–'],
        ['Chip leader', sum.chipLeader ? `${sum.chipLeader.displayName} ${chips(sum.chipLeader.stack)}` : '–'],
      ];
  if (state.settings.payouts) items.push(['Prize pool', money(sum.prizePool)], ['Paid', `${sum.paidPlaces}`]);
  if (sum.totalRebuys) items.push(['Rebuys', `${sum.totalRebuys}`]);
  if (sum.totalAddOns) items.push(['Add-ons', `${sum.totalAddOns}`]);
  if (state.settings.bounty && sum.clock) items.push(['Bounties in play', money(sum.bountiesInPlay)]);
  if (sum.checkIn) items.push(['Checked in', `${sum.checkIn.checkedIn} / ${Math.min(state.settings.maxEntrants, sum.checkIn.checkedIn + sum.checkIn.notCheckedIn)}`]);
  const checkIn = sum.checkIn;
  const checkInNote = !checkIn
    ? ''
    : checkIn.msToOpen !== null
      ? `Check-in opens in ${countdown(checkIn.msToOpen)}`
      : checkIn.groupsOpen === 0
        ? 'Check-in opens when the host opens it'
        : `Check-in open${checkIn.groups > 1 ? ` for group ${checkIn.groupsOpen} of ${checkIn.groups}` : ''}${checkIn.msToNextGroup !== null ? `; next group in ${countdown(checkIn.msToNextGroup)}` : ''}`;
  const windows = [checkInNote, sum.registrationOpen && sum.clock ? 'Late registration open' : '', sum.rebuysOpen ? 'Rebuys open' : '', sum.addOnsOpen ? 'Add-ons open' : '', sum.reEntryOpen ? 'Re-entry open' : ''].filter(Boolean);
  return (
    <>
      <dl className="tn-stats">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {windows.length > 0 && <p className="tn-windows">{windows.join(' · ')}</p>}
    </>
  );
}

/** What the viewer can do: register, rebuy, add on, re-enter, quit. */
function MyPanel({ state, session, skew, send }: { state: TournamentState; session: Session | null; skew: number; send: (c: Command) => Promise<boolean> }) {
  // The rebuy offer expires on the server's clock.
  const now = useNow(500) + skew;
  const [name, setName] = useState(() => session?.displayName || savedName());
  const [nameError, setNameError] = useState('');
  // An invite link carries its code.
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code') ?? '');
  if (state.status === 'cancelled') return null;
  if (!session) return null;
  const o = playerOptions(state, session.playerId);
  // Guests register under the name they pick here; it is also their name at the tables.
  const needsName = o.canRegister && !session.displayName;
  const register = async () => {
    setNameError('');
    if (needsName) {
      if (!name.trim()) return setNameError('Pick the name other players will see.');
      try {
        await tournamentClient().setName(name);
      } catch (e) {
        return setNameError(sentence((e as Error).message));
      }
    }
    if (state.settings.invites?.required && !code.trim()) return setNameError('Enter your invite code.');
    await send({ type: 'register', playerId: session.playerId, displayName: (needsName ? name : session.displayName).trim(), ...(code.trim() ? { code: code.trim() } : {}) });
  };
  const askCode = o.canRegister && (!!state.settings.invites || !!code);
  const me = { playerId: session.playerId, displayName: session.displayName };
  const place = o.entry && !['registered', 'seated', 'rebuy-offer'].includes(o.entry.status) ? standings(state).find((s) => s.entryId === o.entry!.id)?.place : null;
  const table = o.entry?.tableId ? state.tables.findIndex((t) => t.id === o.entry!.tableId) + 1 : 0;
  const pendingLabel: Record<string, string> = { register: 'registration', rebuy: 'rebuy', 'add-on': 'add-on', 're-entry': 're-entry' };

  return (
    <div className="tn-card tn-me">
      <div className="tn-me-status">
        {!o.entry && !o.pending.length && <span>You're not registered.</span>}
        {o.entry?.status === 'registered' && !state.settings.checkIn && (
          <span>You're registered. {state.settings.start.kind === 'scheduled' ? 'Your seat is drawn a minute before the start.' : ''}</span>
        )}
        {o.entry?.status === 'registered' && state.settings.checkIn && (
          <span className={o.canCheckIn ? 'tn-alert' : ''}>
            {o.checkedIn
              ? "You're checked in. Your seat is drawn when the tournament starts."
              : o.canCheckIn
                ? 'Check-in is open: check in to keep your seat.'
                : o.checkInOpensAt !== null
                  ? `You're registered. You can check in from ${localTime(o.checkInOpensAt)} (in ${countdown(o.checkInOpensAt - now)}).`
                  : "You're registered. Check in when check-in opens, or you lose your place."}
          </span>
        )}
        {o.entry?.status === 'seated' && (
          <span>
            <a href={`/t/${tableAddress(o.entry.tableId!)}`}>
              Table {table}, seat {o.entry.seat! + 1}
            </a>{' '}
            · <b>{chips(o.entry.stack)}</b> chips
          </span>
        )}
        {o.entry?.status === 'rebuy-offer' && (
          <span className="tn-alert">
            You're out of chips. Rebuy for {chips(state.settings.rebuy.chips)}? {countdown((o.entry.rebuyOfferExpiresAt ?? now) - now)}
          </span>
        )}
        {place != null && <span>You finished {ordinal(place)}.</span>}
        {o.pending.map((r) => (
          <span key={r.id} className="muted">
            Waiting for the host to approve your {pendingLabel[r.kind]}.
          </span>
        ))}
      </div>
      {needsName && (
        <label className="tn-name">
          Your name
          <input value={name} maxLength={20} placeholder="The name others see" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && register()} />
        </label>
      )}
      {askCode && (
        <label className="tn-name">
          Invite code{state.settings.invites?.required ? '' : ' (if you have one)'}
          <input value={code} maxLength={40} autoCapitalize="characters" placeholder="ABCD2345" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && register()} />
        </label>
      )}
      {nameError && <p className="error">{nameError}</p>}
      <div className="tn-actions">
        {o.canCheckIn && (
          <button className="primary big" onClick={() => send({ type: 'checkIn', playerId: me.playerId })}>
            Check in
          </button>
        )}
        {o.entry?.status === 'seated' && (
          <button className="primary big" onClick={() => navigate(`/t/${tableAddress(o.entry!.tableId!)}`)}>
            Go to my table
          </button>
        )}
        {o.canRegister && <button className="primary big" onClick={register}>Register{session.displayName ? ` as ${session.displayName}` : ''}</button>}
        {o.canRebuy && <button className="primary big" onClick={() => send({ type: 'rebuy', playerId: me.playerId })}>Rebuy</button>}
        {o.canDeclineRebuy && <button onClick={() => send({ type: 'declineRebuy', playerId: me.playerId })}>No thanks</button>}
        {o.canAddOn && <button className="primary" onClick={() => send({ type: 'addOn', playerId: me.playerId })}>Add on {chips(state.settings.addOn.chips)}</button>}
        {o.canReEnter && <button className="primary big" onClick={() => send({ type: 'reEnter', playerId: me.playerId })}>Re-enter</button>}
        {o.canUnregister && <button onClick={() => send({ type: 'unregister', playerId: me.playerId })}>Unregister</button>}
        {o.canQuit && (
          <button
            onClick={() => {
              if (confirm('Leave the tournament for good? Your chips leave play.')) send({ type: 'quit', playerId: me.playerId });
            }}
          >
            Leave tournament
          </button>
        )}
      </div>
    </div>
  );
}

function Players({ state, me }: { state: TournamentState; me?: string }) {
  const rows = standings(state);
  const started = state.status !== 'registering' && state.status !== 'seating';
  const tableNo = (tableId: string | null) => (tableId ? state.tables.findIndex((t) => t.id === tableId) + 1 : 0);
  const [q, setQ] = useState('');
  const shown = q ? rows.filter((r) => r.displayName.toLowerCase().includes(q.toLowerCase())) : rows;
  const pending = state.requests.filter((r) => r.kind === 'register');
  const bounty = !!state.settings.bounty;
  const checkIn = !!state.settings.checkIn && !state.tables.length;
  if (!rows.length && !pending.length) return <p className="muted">No one has registered yet.</p>;
  return (
    <>
      {rows.length > 12 && <input className="tn-search" placeholder="Find a player" value={q} onChange={(e) => setQ(e.target.value)} />}
      <table className="tn-table">
        <thead>
          <tr>
            {started && <th>#</th>}
            <th>Player</th>
            <th className="num">{started ? 'Chips' : ''}</th>
            {bounty && <th className="num">Bounty</th>}
            {bounty && <th className="num">KOs</th>}
            {state.settings.payouts && <th className="num">Prize</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => {
            const e = state.entries.find((x) => x.id === r.entryId)!;
            return (
              <tr key={r.entryId} className={`${r.playerId === me ? 'tn-me-row' : ''} ${r.place ? 'tn-out' : ''}`}>
                {started && <td>{r.place ? ordinal(r.place) : i + 1}</td>}
                <td className="tn-player">
                  <span className="avatar initials" style={{ background: initialsColor(r.playerId) }} aria-hidden="true">
                    {[...r.displayName.trim()][0]?.toUpperCase() ?? '?'}
                  </span>
                  {r.displayName}
                  {r.playerId === me && <span className="tn-you">you</span>}
                  {r.entryNo > 1 && <span className="tn-tag">E{r.entryNo}</span>}
                  {r.rebuys > 0 && <span className="tn-tag">R{r.rebuys}</span>}
                  {r.addOns > 0 && <span className="tn-tag">A</span>}
                  {e.status === 'rebuy-offer' && <span className="tn-tag tn-tag-warn">rebuy?</span>}
                  {checkIn && <span className={`tn-tag ${e.checkedInAt === undefined ? '' : 'tn-tag-good'}`}>{e.checkedInAt === undefined ? 'not checked in' : 'checked in'}</span>}
                  {e.tableId && started && <span className="muted"> · T{tableNo(e.tableId)}</span>}
                </td>
                <td className="num">{started && !r.place ? chips(r.stack) : ''}</td>
                {bounty && <td className="num" title={r.bounties ? `${money(r.bounties)} won` : undefined}>{r.place ? (r.bounties ? `won ${money(r.bounties)}` : '') : money(r.bounty)}</td>}
                {bounty && <td className="num">{r.knockouts || ''}</td>}
                {state.settings.payouts && <td className="num">{r.prize ? money(r.prize) : ''}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {pending.length > 0 && <p className="muted">{pending.length} waiting for approval.</p>}
      {rows.length > 0 && started && (
        <button className="tn-csv" onClick={() => downloadResults(state)}>
          Download results (CSV)
        </button>
      )}
    </>
  );
}

function Tables({ state, me }: { state: TournamentState; me?: string }) {
  const over = state.status === 'finished' || state.status === 'cancelled';
  const played = state.counters.table > 0;
  const chat = mayDownloadTableChat(state, me) ? <TableChatDownload state={state} /> : null;
  if (!state.tables.length)
    return over ? (
      <>
        <p className="muted">{played ? 'The tables have closed.' : 'No tables were opened.'}</p>
        {chat}
      </>
    ) : (
      <p className="muted">Tables are created when the tournament starts{state.settings.start.kind === 'scheduled' ? ' (a minute before the start time)' : ''}.</p>
    );
  return (
    <>
      {chat}
      <div className="tn-tables">
        {state.tables.map((t, i) => {
          const players = t.seats.map((id, seat) => ({ seat, e: id ? state.entries.find((x) => x.id === id) : undefined })).filter((x) => x.e);
          return (
            <div className="tn-table-card" key={t.id}>
              <h3>
                <a href={`/t/${tableAddress(t.id)}`}>Table {i + 1}</a> <span className="muted">· {players.length} players{t.inHand ? ' · in a hand' : ''}</span>
              </h3>
              <ul>
                {players.map(({ seat, e }) => (
                  <li key={seat}>
                    <span className="muted">{seat + 1}</span> {e!.displayName}
                    <span className="num">{chips(e!.stack)}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** A closed table can't be opened again, so once it is over its chat comes from the lobby (host, co-hosts and players). */
function mayDownloadTableChat(state: TournamentState, me?: string) {
  const over = state.status === 'finished' || state.status === 'cancelled';
  return over && state.counters.table > 0 && (isTournamentStaff(state, me) || state.entries.some((e) => e.playerId === me));
}

function TableChatDownload({ state }: { state: TournamentState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const get = async () => {
    setBusy(true);
    setError('');
    try {
      downloadTableChat(state, await tournamentClient().tableChat(state.id));
    } catch (e) {
      setError(sentence(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="row wrap">
      <button disabled={busy} onClick={() => void get()} title="What was said and logged at every table, including tables that broke during play">
        {busy ? 'Getting the chat…' : 'Download table chat'}
      </button>
      {error && <span className="error">{error}</span>}
    </p>
  );
}

function Payouts({ state, now }: { state: TournamentState; now: number }) {
  const sum = summarize(state, now);
  const p = state.settings.payouts!;
  // Before two people have entered, what the smallest field would pay.
  const prizes = state.entries.length >= 2 ? finishPrizes(state) : placePrizes(sum.prizePool, p.structure, 2);
  return (
    <>
      <p className="muted">
        For display only. {money(p.money.buyIn)} buy-in{p.money.rebuy && state.settings.rebuy.max ? `, ${money(p.money.rebuy)} rebuy` : ''}
        {p.money.addOn && state.settings.addOn.max ? `, ${money(p.money.addOn)} add-on` : ''}. Updates as players join.
      </p>
      <PrizeList prizes={prizes} />
    </>
  );
}

function HostTools({ state, me, powers, send }: { state: TournamentState; me: string; powers: HostPower[]; send: (c: Command) => Promise<boolean> }) {
  const by = me;
  const can = (p: HostPower) => powers.includes(p);
  const started = state.status === 'running' || state.status === 'paused';
  const [rows, setRows] = useState<StructureRow[]>(state.settings.structure);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setRows(state.settings.structure);
  }, [state.settings.structure, dirty]);
  const s = state.settings;
  const over = state.status === 'finished' || state.status === 'cancelled';

  return (
    <div className="tn-host">
      {can('approve') && state.requests.length > 0 && (
        <div className="tn-requests">
          <h3>Requests</h3>
          {state.requests.map((r) => (
            <RequestRow key={r.id} state={state} r={r} by={by} powers={powers} send={send} />
          ))}
        </div>
      )}

      {!over && can('run') && (
        <div className="tn-actions">
          {/* Start now sits in the card by the clock (HostStart). */}
          {s.checkIn && state.status === 'registering' && state.checkIn?.openedAt == null && (
            <button className="primary" onClick={() => send({ type: 'openCheckIn', by })}>
              Open check-in now
            </button>
          )}
          {state.status === 'running' && <button onClick={() => send({ type: 'pause', by })}>Pause</button>}
          {state.status === 'paused' && (
            <button className="primary" onClick={() => send({ type: 'resume', by })}>
              Resume
            </button>
          )}
          <button
            onClick={() => {
              const msg = started ? 'End the tournament now and rank everyone left by chip count?' : 'Cancel this tournament?';
              if (confirm(msg)) send({ type: 'end', by });
            }}
          >
            {started ? 'End and rank by chips' : 'Cancel tournament'}
          </button>
        </div>
      )}
      {state.status === 'running' && can('run') && <p className="muted">To end early, pause first and let running hands finish.</p>}

      {!over && can('approve') && <InvitesPanel state={state} send={send} />}

      {!over && (can('chips') || can('players')) && <PlayerManager state={state} by={by} powers={powers} send={send} />}

      {!over && can('settings') && (
        <>
          <h3>Settings</h3>
          <div className="tn-toggles">
            <Toggle label="Late registration" on={s.lateRegistration.enabled} set={(v) => send({ type: 'updateSettings', by, settings: { lateRegistration: { ...s.lateRegistration, enabled: v } } })} />
            <Toggle label="Approve registrations" on={s.registrationApproval} set={(v) => send({ type: 'updateSettings', by, settings: { registrationApproval: v } })} />
            {s.rebuy.max > 0 && <Toggle label="Approve rebuys" on={s.rebuy.approval} set={(v) => send({ type: 'updateSettings', by, settings: { rebuy: { ...s.rebuy, approval: v } } })} />}
            {s.addOn.max > 0 && <Toggle label="Approve add-ons" on={s.addOn.approval} set={(v) => send({ type: 'updateSettings', by, settings: { addOn: { ...s.addOn, approval: v } } })} />}
            <Toggle label="Re-entry" on={s.reEntry.enabled} set={(v) => send({ type: 'updateSettings', by, settings: { reEntry: { ...s.reEntry, enabled: v } } })} />
            <Toggle label="Players may leave" on={s.allowQuit} set={(v) => send({ type: 'updateSettings', by, settings: { allowQuit: v } })} />
            {s.payouts && <Toggle label="Hand-for-hand on the bubble" on={s.handForHand} set={(v) => send({ type: 'updateSettings', by, settings: { handForHand: v } })} />}
            <Toggle
              label="Invite code needed to register"
              on={!!s.invites?.required}
              set={(v) => send({ type: 'updateSettings', by, settings: { invites: { autoApprove: s.invites?.autoApprove ?? true, required: v } } })}
            />
            {(s.invites || s.registrationApproval) && (
              <Toggle
                label="A valid code skips my approval"
                on={!!s.invites?.autoApprove}
                set={(v) => send({ type: 'updateSettings', by, settings: { invites: { required: s.invites?.required ?? false, autoApprove: v } } })}
              />
            )}
          </div>

          <h3>Blind levels</h3>
          <p className="muted">{started ? 'Levels already played and the current level are locked; changes apply from the next level.' : 'Edit freely until the start.'}</p>
          <StructureEditor
            rows={rows}
            onChange={(r) => {
              setRows(r);
              setDirty(true);
            }}
            startingStack={s.startingStack}
            expectedEntrants={Math.max(2, state.entries.length)}
            maxRebuys={s.rebuy.max}
            lockedThrough={started ? state.clock.rowIndex : -1}
            currentRow={started ? state.clock.rowIndex : undefined}
            showGames={s.games.length > 1}
          />
          {dirty && (
            <div className="tn-actions">
              <button
                className="primary"
                onClick={async () => {
                  if (await send({ type: 'editStructure', by, structure: rows })) setDirty(false);
                }}
              >
                Save levels
              </button>
              <button onClick={() => setDirty(false)}>Discard</button>
            </div>
          )}

          <h3>At the tables</h3>
          <TableRulesEditor state={state} by={by} send={send} />
        </>
      )}

      <CoHostPanel state={state} me={me} send={send} />
      <EventPanel state={state} me={me} send={send} />
    </div>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="tn-switch">
      <input type="checkbox" role="switch" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Local mode only: fill the field and play hands so the pages can be tried before real tables exist. */
function DemoTools({ state }: { state: TournamentState }) {
  const client = tournamentClient() as LocalTournamentClient;
  const session = useSession();
  const people = [{ playerId: state.hostId, displayName: 'Host' }, ...state.entries.filter((e) => !e.supersededBy).map((e) => ({ playerId: e.playerId, displayName: e.displayName }))];
  const [err, setErr] = useState('');
  const run = (f: () => unknown) => {
    setErr('');
    Promise.resolve()
      .then(f)
      .catch((e) => setErr((e as Error).message));
  };
  return (
    <details className="tn-card tn-demo">
      <summary>Test mode</summary>
      <p className="muted">This tournament lives only in this browser until the server side is connected. Use these to try it out.</p>
      <div className="tn-actions">
        <button onClick={() => run(() => client.addTestPlayers(state.id, 5))}>+5 test players</button>
        <button onClick={() => run(() => client.addTestPlayers(state.id, 20))}>+20</button>
        <button onClick={() => run(() => client.playHands(state.id))}>Play a hand on every table</button>
        <button onClick={() => run(() => client.skipAhead(state.id, 60_000))}>Skip 1 min</button>
        <button onClick={() => run(() => client.skipAhead(state.id, 5 * 60_000))}>Skip 5 min</button>
      </div>
      <label>
        Viewing as
        <select
          value={session?.playerId}
          onChange={(e) => {
            const p = people.find((x) => x.playerId === e.target.value);
            if (p) client.actAs(p.playerId, p.displayName);
          }}
        >
          {[...new Map(people.map((p) => [p.playerId, p])).values()].map((p) => (
            <option key={p.playerId} value={p.playerId}>
              {p.displayName}
            </option>
          ))}
          {session && !people.some((p) => p.playerId === session.playerId) && <option value={session.playerId}>{session.displayName}</option>}
        </select>
      </label>
      {err && <p className="error">{err}</p>}
    </details>
  );
}
