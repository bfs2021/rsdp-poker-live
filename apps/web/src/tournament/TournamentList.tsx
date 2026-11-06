import { useEffect, useState } from 'react';
import { isLive, type TournamentListing } from '@rsdp/tournament';
import { socket } from '../socket';
import { tournamentClient } from './client';
import { AlertsToggle } from './TournamentAlerts';
import { countdown, gamesText, localTime, ordinal } from './format';
import { navigate, useNow } from './hooks';

/** How often the home page refreshes its lists while open. */
const REFRESH_MS = 30_000;
/** Closer than this, a start shows as a countdown rather than a date. */
const COUNTDOWN_UNDER_MS = 24 * 60 * 60 * 1000;
/** Rows shown before "Show all", so the cash table form stays near the top. */
const FIRST_ROWS = 6;

type Tab = 'open' | 'mine';

/** The home page's tournaments, refreshed while the page is open and when the connection comes back. */
export function useTournamentList() {
  const [list, setList] = useState<TournamentListing[] | null>(null);
  const [skew, setSkew] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      tournamentClient()
        .list()
        .then((r) => {
          if (!alive) return;
          setList(r.tournaments);
          setSkew(r.serverNow - Date.now());
        })
        .catch(() => alive && setList((l) => l ?? []));
    const onVisible = () => document.visibilityState === 'visible' && load();
    load();
    // A hidden tab catches up when it comes back into view.
    const t = setInterval(() => document.visibilityState === 'visible' && load(), REFRESH_MS);
    socket.on('connect', load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      socket.off('connect', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return { list, skew };
}

const isMine = (t: TournamentListing) => t.me.hosting || t.me.registered;

/** Upcoming and running tournaments, and the viewer's own (hosted or played). */
export function TournamentList() {
  const { list, skew } = useTournamentList();
  const now = useNow() + skew;
  const [tab, setTab] = useState<Tab | null>(null);
  const [all, setAll] = useState(false);
  if (!list) return null;
  const open = list.filter(isLive);
  const mine = list.filter(isMine);
  // Your own live events first, if you have any.
  const shown = tab ?? (mine.some(isLive) ? 'mine' : 'open');
  const rows = shown === 'mine' ? mine : open;

  return (
    <section className="card-panel tn-list" aria-label="Tournaments">
      <div className="tn-list-head">
        <h2>Tournaments</h2>
        <AlertsToggle quietWhenBlocked />
        <a
          href="/tn/new"
          onClick={(e) => {
            e.preventDefault();
            navigate('/tn/new');
          }}
        >
          Host one
        </a>
      </div>
      <nav className="tn-tabs" role="tablist">
        <button role="tab" aria-selected={shown === 'open'} className={shown === 'open' ? 'on' : ''} onClick={() => {
            setTab('open');
            setAll(false);
          }}>
          Upcoming & running{open.length ? ` (${open.length})` : ''}
        </button>
        <button role="tab" aria-selected={shown === 'mine'} className={shown === 'mine' ? 'on' : ''} onClick={() => {
            setTab('mine');
            setAll(false);
          }}>
          Mine{mine.length ? ` (${mine.length})` : ''}
        </button>
      </nav>
      {rows.length === 0 ? (
        <p className="muted">{shown === 'mine' ? "Tournaments you host or play in show up here." : 'Nothing scheduled right now. Host one and share the link.'}</p>
      ) : (
        <ul className="tn-list-rows">
          {(all ? rows : rows.slice(0, FIRST_ROWS)).map((t) => (
            <ListingRow key={t.id} t={t} now={now} />
          ))}
        </ul>
      )}
      {!all && rows.length > FIRST_ROWS && <button onClick={() => setAll(true)}>Show all {rows.length}</button>}
    </section>
  );
}

function ListingRow({ t, now }: { t: TournamentListing; now: number }) {
  const href = `/tn/${t.id}`;
  const badge = myBadge(t);
  return (
    <li>
      <a
        className="tn-list-row"
        href={href}
        onClick={(e) => {
          e.preventDefault();
          navigate(href);
        }}
      >
        <span className="tn-list-name">
          {t.name}
          {badge && <span className={`tn-tag ${badge.warn ? 'tn-tag-warn' : ''}`}>{badge.label}</span>}
        </span>
        <span className={`tn-list-when tn-list-${t.status}`}>{when(t, now)}</span>
        <span className="muted">
          {gamesText(t)} · {t.entrants} {t.entrants === 1 ? 'player' : 'players'}
          {t.start === 'sng' ? ' · Sit & Go' : ''}
        </span>
      </a>
    </li>
  );
}

/** Where the viewer stands: hosting, registered, still in, or how they finished. */
export function myBadge(t: TournamentListing): { label: string; warn?: boolean } | null {
  const { me } = t;
  if (me.place === 1 && t.status === 'finished') return { label: 'Won', warn: true };
  if (me.place !== null) return { label: ordinal(me.place) };
  if (me.alive && (t.status === 'running' || t.status === 'paused' || t.status === 'seating')) return { label: 'Playing', warn: true };
  if (me.registered && isLive(t)) return { label: 'Registered' };
  if (me.hosting) return { label: 'Hosting' };
  return null;
}

/** "Starts in 12:04", "Level 5 · 9 of 24 left", "Won by Ana"... */
export function when(t: TournamentListing, now: number): string {
  switch (t.status) {
    case 'running':
    case 'paused':
      return `${t.status === 'paused' ? 'Paused' : 'Running'}${t.levelNumber ? ` · Level ${t.levelNumber}` : ''} · ${t.playersLeft} of ${t.entrants} left`;
    case 'seating':
      return t.startAt ? `Seats drawn · cards in the air in ${countdown(t.startAt - now)}` : 'Seats drawn';
    case 'finished':
      return t.winner ? `Finished · won by ${t.winner}` : 'Finished';
    case 'cancelled':
      return 'Cancelled';
    case 'registering':
      if (t.start === 'sng' && t.playersNeeded !== null) return `Starts when full · ${t.playersNeeded} more needed`;
      if (t.startAt === null) return 'Starts when the host starts it';
      if (t.startAt <= now) return 'Waiting for players';
      return t.startAt - now < COUNTDOWN_UNDER_MS ? `Starts in ${countdown(t.startAt - now)}` : `Starts ${localTime(t.startAt)}`;
  }
}
