import { useEffect, useState, type FormEvent } from 'react';
import { chipFormat } from '../format';
import { handNet } from '../replay';
import { LogText } from '../components/PlayingCard';
import { Replayer } from '../components/Replayer';
import type { TableView } from '@rsdp/engine/wire';
import { Shell } from './AccountPages';
import { fetchHandGames, searchHands, shareFoundHand, type FoundHand, type HandGame, type HandQuery } from './api';

/** One choice in the Game list: the game and its betting. */
const gameKey = (game: string, betting?: string) => `${game}/${betting ?? ''}`;

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The cards I was dealt in a hand, as [As][Kd] for LogText. */
function myCards(f: FoundHand): string {
  const seat = f.hand.seats.find((s) => s.playerId === f.myId)?.seat;
  const cards: string[] = [];
  for (const e of f.hand.events) {
    if (e.t === 'deal' && e.seat === seat) cards.push(...e.cards.map((c) => c.card));
    else if (e.t === 'draw' && e.seat === seat) cards.push(...e.cards);
  }
  return cards.filter((c) => c !== '??').map((c) => `[${c}]`).join('');
}

/** /hands: find past hands across every table I played, then replay or share them. */
export function HandSearchPage() {
  const [query, setQuery] = useState<HandQuery>({ result: '' });
  const [games, setGames] = useState<HandGame[]>([]);
  const [found, setFound] = useState<FoundHand[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<FoundHand | null>(null);
  /** The query the results on screen came from: further pages carry on with it, not with edits not yet searched. */
  const [shown, setShown] = useState<HandQuery>({ result: '' });

  useEffect(() => {
    fetchHandGames()
      .then((g) => setGames(g.games))
      .catch(() => {});
    void run(false);
  }, []);

  async function run(more: boolean, q = query) {
    setBusy(true);
    setError('');
    try {
      const asked = more ? shown : q;
      const page = await searchHands(asked, more ? next : null);
      setShown(asked);
      setFound((f) => (more && f ? [...f, ...page.hands] : page.hands));
      setNext(page.next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(false);
  };
  const set = (k: keyof HandQuery) => (e: { target: { value: string } }) => setQuery((q) => ({ ...q, [k]: e.target.value }));

  return (
    <Shell title="Hand search">
      <form className="account-form hand-search" onSubmit={submit}>
        <div className="hand-search-grid">
          <label>
            My cards
            <input value={query.cards ?? ''} placeholder="AA, AKs, 72o, AsKs" maxLength={20} spellCheck={false} autoCapitalize="characters" onChange={set('cards')} />
          </label>
          <label>
            Played with
            <input value={query.player ?? ''} placeholder="A friend's name" maxLength={20} onChange={set('player')} />
          </label>
          <label>
            Game
            <select
              value={query.game ? gameKey(query.game, query.betting) : ''}
              onChange={(e) => {
                const g = games.find((x) => gameKey(x.id, x.betting) === e.target.value);
                setQuery((q) => ({ ...q, game: g?.id, betting: g?.betting }));
              }}
            >
              <option value="">Any game</option>
              {games.map((g) => (
                <option key={gameKey(g.id, g.betting)} value={gameKey(g.id, g.betting)}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pot at least
            <span className="hand-search-bb">
              <input type="number" min={0} step={1} inputMode="numeric" value={query.minPot ?? ''} placeholder="0" onChange={set('minPot')} /> big blinds
            </span>
          </label>
          <label>
            How it went
            <select value={query.result ?? ''} onChange={set('result')}>
              <option value="">Won or lost</option>
              <option value="won">I won chips</option>
              <option value="lost">I lost chips</option>
            </select>
          </label>
        </div>
        <div className="row">
          <button className="primary" disabled={busy}>
            Search
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const cleared: HandQuery = { result: '' };
              setQuery(cleared);
              void run(false, cleared);
            }}
          >
            Clear
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {found && found.length === 0 && !busy && <p className="muted">No hands match. Hands you were dealt in, at any table, are searched, newest first.</p>}
      {found && found.length > 0 && (
        <ul className="account-list found-hands">
          {found.map((f) => (
            <FoundRow key={f.handId} f={f} onReplay={() => setOpen(f)} />
          ))}
        </ul>
      )}
      {next && (
        <button className="more" disabled={busy} onClick={() => void run(true)}>
          {busy ? 'Searching…' : 'Look further back'}
        </button>
      )}
      {busy && !found && <p className="muted">Searching…</p>}
      {open && (
        <Replayer
          hands={[open.hand]}
          start={0}
          tableId={open.tableId}
          tableName={open.tableName || 'Table'}
          seatCount={open.seatCount}
          myId={open.myId}
          felt={(open.felt ?? undefined) as TableView['settings']['table']['felt']}
          fmt={chipFormat(open.centsMode)}
          onClose={() => setOpen(null)}
        />
      )}
    </Shell>
  );
}

function FoundRow({ f, onReplay }: { f: FoundHand; onReplay: () => void }) {
  const fmt = chipFormat(f.centsMode);
  const net = handNet(f.hand, f.myId);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const share = (hideMine: boolean) =>
    shareFoundHand(f.handId, hideMine)
      .then(async ({ id }) => {
        const url = `${location.origin}/h/${id}`;
        setLink(url);
        setError('');
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          prompt('Copy this link', url);
        }
      })
      .catch((e: Error) => setError(e.message));
  const cards = myCards(f);
  return (
    <li>
      <span className="found-title">
        {cards && (
          <span className="found-cards">
            <LogText text={cards} />
          </span>
        )}{' '}
        {f.hand.gameName} · pot {fmt(f.pot)}
      </span>
      <span className="muted">
        <a href={`/t/${f.tableId}`}>{f.tableName || 'Table'}</a> · hand {f.hand.handNumber} · {when(f.hand.startedAt)}
        {' · '}
        {f.hand.seats
          .filter((s) => s.playerId !== f.myId)
          .map((s) => s.name)
          .join(', ')}
      </span>
      {net !== null && <span className={`account-net ${net > 0 ? 'up' : net < 0 ? 'down' : ''}`}>{net > 0 ? `+${fmt(net)}` : net < 0 ? `−${fmt(-net)}` : 'even'}</span>}
      <span className="found-actions">
        <button onClick={onReplay}>Replay</button>
        <button onClick={() => void share(false)} title="A link anyone can open, with your cards showing">
          Share
        </button>
        <button onClick={() => void share(true)} title="A link anyone can open; your cards stay face down unless you showed them">
          Share, hide my cards
        </button>
        {link && <span className="good">Link copied</span>}
        {error && <span className="error">{error}</span>}
      </span>
    </li>
  );
}
