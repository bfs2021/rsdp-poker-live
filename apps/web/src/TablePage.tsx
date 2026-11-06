import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getVariant } from '@rsdp/engine/variants';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { call, NoAnswerError, socket } from './socket';
import { contributeSeed, liveSeedProblem, watchCommitments, watchNextSeen } from './fair';
import { nextVolume, setVolume, sounds, useVolume, VOLUME_NAME } from './sound';
import { badgeFavicon, buzz } from './alerts';
import { closeNotifications, notify } from './notify';
import { usePortrait, useWide } from './layout';
import { bbFormat, chipFormat, clock, gameLabel, stakesLabel } from './format';
import { getPrefs, setPrefs, usePrefs } from './prefs';
import { useWakeLock } from './wakeLock';
import { Table, useNow } from './components/Table';
import { HandExtras } from './components/table/HandExtras';
import { PlayerExtras } from './components/table/Persona';
import { SeatingBanners } from './components/table/Seating';
import { ActionBar } from './components/ActionBar';
import { HostPanel } from './components/HostPanel';
import { SidePanel, type Tab } from './components/SidePanel';
import { PartBoundary } from './components/ErrorBoundary';
import { ChatBox, newChat, unreadChat } from './components/table/Chat';
import { TableMenu } from './components/table/TableMenu';
import { useChatMutes } from './chatMutes';
import { Sheet } from './components/Sheet';
import { AddBotDialog, Modal, MyBot, PlayerDialog, RebuyDialog, SeatDialog } from './components/SeatDialog';
import { botOwnerLabel, LEVEL_INFO } from './components/table/BotLevels';
import { SettingsDialog } from './components/SettingsDialog';
import { RulesDialog } from './components/RulesDialog';
import { PeopleDialog } from './components/PeopleDialog';
import { LookDialog } from './components/LookDialog';
import { FeedbackDialog } from './components/FeedbackDialog';
import { hasKeyboard, ShortcutsDialog } from './components/Shortcuts';
import { Dock } from './components/table/Dock';
import { useDepartures, useRunoutReveal } from './runout';
import { holdReloadWhile, reloadIfStale } from './freshness';
import { TableStrip } from './tournament/TableStrip';
import { navigate, tournamentOfTable, useFollowSeat } from './tournament/hooks';

/** Plays sounds, buzzes and badges the tab for what changed between two views. */
function useTableEffects(view: TableView | null, skew: number, preQueued: { current: boolean }) {
  const prev = useRef<TableView | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = view;
    if (!view || !before) return;
    if (newChat(before.chat, view.chat).some((m) => m.playerId && m.playerId !== view.me.playerId)) sounds.chat();
    if (view.powers.includes('approve') && view.requests.length > before.requests.length) sounds.request();
    const hand = view.hand;
    if (!hand) return;
    const fresh = hand.handNumber !== before.hand?.handNumber;
    const seen = fresh ? -1 : (before.hand?.events.at(-1)?.seq ?? -1);
    const events = hand.events.filter((e) => e.seq > seen);
    if (events.some((e) => e.t === 'deal')) sounds.deal();
    const turned = events.reduce((n, e) => Math.max(n, e.t === 'board' ? e.cards.length : 0), 0);
    if (turned) sounds.flip(turned);
    for (const e of events) {
      if (e.t !== 'action') continue;
      if (e.allIn) sounds.allIn();
      else if (e.action === 'fold') sounds.fold();
      else if (e.action === 'check') sounds.check();
      else if (e.action === 'raise' || e.action === 'bet' || e.action === 'complete') sounds.raise();
      else sounds.chips();
    }
    const won = hand.phase === 'complete' && before.hand?.phase !== 'complete';
    if (won && view.me.seat !== null && hand.awards.some((a) => a.seat === view.me.seat)) sounds.win();
    else if (won && hand.awards.length) sounds.pot();
    const myTurn = !!view.legal || !!view.canDraw || view.canVoteRunItTwice;
    const wasMyTurn = !!before.legal || !!before.canDraw || before.canVoteRunItTwice;
    // A queued move (check/fold, call any) answers for you, so there is nothing to call you for.
    if (myTurn && !wasMyTurn && !preQueued.current) {
      sounds.turn();
      buzz();
      notify('Your turn', view.name, { tag: `turn:${view.id}`, url: `/t/${view.id}` });
    }
  }, [view]);

  const myTurn = !!view?.legal || !!view?.canDraw || !!view?.canVoteRunItTwice;

  // A warning beep a few seconds before your clock runs out.
  const deadline = myTurn && !view?.paused && view?.turn?.seat === view?.me.seat ? (view?.turn?.deadline ?? null) : null;
  useEffect(() => {
    if (deadline === null) return;
    const ms = deadline - skew - HURRY_MS - Date.now();
    if (ms < 0) return;
    const t = setTimeout(() => {
      sounds.hurry();
      buzz(200);
    }, ms);
    return () => clearTimeout(t);
  }, [deadline, skew]);

  // Flash the tab title and badge its icon while it's your turn.
  useEffect(() => {
    if (!myTurn) return;
    const original = document.title;
    badgeFavicon(true);
    let on = false;
    const t = setInterval(() => {
      if (document.hidden) {
        on = !on;
        document.title = on ? '▶ Your turn!' : original;
      } else document.title = original;
    }, 800);
    return () => {
      clearInterval(t);
      document.title = original;
      badgeFavicon(false);
      // Acted (here or in another tab): the alert is out of date.
      closeNotifications('turn:');
    };
  }, [myTurn]);
}

const HURRY_MS = 5000;

type Dialog = { kind: 'seat'; seat: number; waitlist?: boolean } | { kind: 'player'; seat: SeatView } | { kind: 'add-bot'; seat: number } | { kind: 'rebuy' } | { kind: 'settings' } | { kind: 'rules' } | { kind: 'people' } | { kind: 'look' } | { kind: 'keys' } | { kind: 'feedback' } | null;

/** How long the keyboard tip stays up if nobody presses Got it. */
const KEYS_TIP_MS = 20_000;

export function TablePage({ tableId }: { tableId: string }) {
  const [live, setView] = useState<TableView | null>(null);
  // An all-in runout is dealt a street at a time; everything below sees the table as it is shown. A player knocked
  // out stays in their seat until the next deal.
  const view = useDepartures(useRunoutReveal(live));
  const [skew, setSkew] = useState(0);
  const [error, setError] = useState('');
  /** The server's answer when it refused (or never answered) Sit out, I'm back, straddle or wait for the big blind. */
  const [seatError, setSeatError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sheet, setSheet] = useState<'menu' | 'chat' | Tab | null>(null);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(socket.connected);
  const volume = useVolume();
  const [discard, setDiscard] = useState<number[]>([]);
  /** When the newest chat line you have seen was sent, for the unread badge on phones. */
  const [chatSeenAt, setChatSeenAt] = useState(0);
  const preQueued = useRef(false);
  const portrait = usePortrait();
  // Big windows: chat in the bottom-left corner, and the records and host controls in a panel from the top bar (#317).
  const wide = useWide(portrait);
  const [drawerPick, setDrawer] = useState<boolean | null>(null);
  const chatMutes = useChatMutes();
  useTableEffects(view, skew, preQueued);
  const readyTable = useFollowSeat(tableId, view?.me.seat != null, view !== live);
  // A newer build of the app waits for the end of the hand (and its runout) before this tab reloads into it.
  const mine = live?.me.seat != null ? live.seats[live.me.seat] : null;
  const busy = view !== live || (!!live?.hand && live.hand.phase !== 'complete' && !!mine?.inHand && !mine.folded);
  const busyNow = useRef(busy);
  busyNow.current = busy;
  useEffect(() => holdReloadWhile(() => busyNow.current), []);
  useEffect(() => {
    if (!busy) reloadIfStale();
  }, [busy]);

  useEffect(() => {
    // A join lost to a dropped connection is tried again when it comes back, so only a refusal ends the page.
    const join = () => call('table:join', { tableId }).catch((e: Error) => e instanceof NoAnswerError || setError(e.message));
    let first = true;
    const watch = watchCommitments();
    const nextSeen = watchNextSeen();
    const onState = (v: TableView) => {
      if (v.id !== tableId) return;
      setView(v);
      watch(v);
      nextSeen(v);
      contributeSeed(v);
      setSkew(v.serverNow - Date.now());
      // Chat from before you arrived is not news.
      if (first) setChatSeenAt(v.chat.at(-1)?.at ?? 0);
      first = false;
    };
    const onConnect = () => {
      setConnected(true);
      join();
    };
    const onDisconnect = () => setConnected(false);
    const onDeleted = ({ id }: { id: string }) => id === tableId && setError('deleted');
    socket.on('table:state', onState);
    socket.on('table:deleted', onDeleted);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    // The socket may have connected after the first render but before this ran, so its connect event is gone.
    setConnected(socket.connected);
    if (socket.connected) join();
    return () => {
      socket.off('table:state', onState);
      socket.off('table:deleted', onDeleted);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.emit('table:leave');
      nextSeen.stop();
    };
  }, [tableId]);

  // The discard pick is for one draw only.
  const drawKey = view?.canDraw ? `${view.hand?.handNumber}:${view.hand?.street}` : '';
  useEffect(() => setDiscard([]), [drawKey]);

  const fmt = useMemo(() => chipFormat(!!view?.settings.stakes.centsMode), [view?.settings.stakes.centsMode]);
  const dollars = !!view?.settings.stakes.centsMode;
  // The felt and the bet box can show amounts in big blinds; buy-ins and the ledger stay in chips.
  const prefs = usePrefs();
  const studNow = (view?.hand?.family ?? (view?.upcoming ? gameFamily(view.upcoming.gameId) : 'flop')) === 'stud';
  const bigBlind = studNow ? 0 : (view?.hand?.stakes.bigBlind ?? view?.upcoming?.stakes.bigBlind ?? view?.settings.stakes.bigBlind ?? 0);
  const bigBlindRef = useRef(bigBlind);
  bigBlindRef.current = bigBlind;
  const feltFmt = useMemo(() => (prefs.units === 'bb' && bigBlind > 0 ? bbFormat(bigBlind) : fmt), [prefs.units, bigBlind, fmt]);
  useWakeLock(prefs.wakeLock && view?.me.seat != null);
  // B switches between chips and big blinds; ? lists every shortcut.
  useEffect(() => {
    // The control last pressed with a mouse or finger, until Tab moves on from it.
    let clicked: Element | null = null;
    const onPointer = (e: PointerEvent) => {
      clicked = e.target instanceof Element ? e.target.closest('button, a, summary, [role=button]') : null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') clicked = null;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'Enter') {
        // Enter on a button reached with the keyboard (Tab) presses it; anywhere else it starts a chat message. A button
        // last clicked with the mouse keeps focus, so Enter there goes to chat too: otherwise Enter after clicking
        // Start game pressed the Stop game button that took its place, and Pause flipped to Resume (#320).
        if (e.defaultPrevented) return;
        const control = e.target instanceof HTMLElement ? e.target.closest('button, a, summary, [role=button]') : null;
        if (control && control !== clicked) return;
        if (document.querySelector('.modal-backdrop, .sheet-backdrop, .replayer-backdrop')) return;
        const box = document.querySelector<HTMLInputElement>('.side .chat-form input, .corner-chat .chat-form input');
        // With no chat box to go to (muted, say), a clicked button still isn't pressed again.
        if (box || control) e.preventDefault();
        box?.focus();
        return;
      }
      if (e.key === '?') {
        if (!document.querySelector('.modal-backdrop, .sheet-backdrop, .replayer-backdrop')) setDialog({ kind: 'keys' });
        return;
      }
      if (e.key.toLowerCase() !== 'b' || !bigBlindRef.current) return;
      setPrefs({ units: getPrefs().units === 'bb' ? 'chips' : 'bb' });
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  // A one-time tip about the keyboard shortcuts, for seated players on a computer.
  const [keysTipSeen, setKeysTipSeen] = useState(() => {
    try {
      return localStorage.getItem('rsdp.tip.keys') === '1';
    } catch {
      return true;
    }
  });
  /** Gone for good after "Got it" or opening the shortcuts; a timeout only hides it until the next visit. */
  const dismissKeysTip = (forGood = true) => {
    setKeysTipSeen(true);
    try {
      if (forGood) localStorage.setItem('rsdp.tip.keys', '1');
    } catch {
      /* ignore */
    }
  };
  const keysTip = !keysTipSeen && !portrait && view?.me.seat != null && hasKeyboard();
  // The tip floats over the corner instead of pushing the table down, and goes by itself after a while.
  useEffect(() => {
    if (!keysTip) return;
    const t = setTimeout(() => dismissKeysTip(false), KEYS_TIP_MS);
    return () => clearTimeout(t);
  }, [keysTip]);
  const now = useNow(!!view?.level?.endsAt, 1000) + skew;
  // Losing your seat without pressing Leave (the host removed you, or an offline seat was released) gets a word of explanation.
  const wasSeated = useRef(false);
  const leftByMe = useRef(false);
  const [unseated, setUnseated] = useState(false);
  useEffect(() => {
    const seated = view?.me.seat != null;
    if (wasSeated.current && !seated && !leftByMe.current && view?.mode === 'cash') setUnseated(true);
    if (seated) {
      leftByMe.current = false;
      setUnseated(false);
    }
    wasSeated.current = seated;
  }, [view?.me.seat]);

  // At a desk the chat is always on screen; on a phone it's read when its sheet is open.
  const chatOpen = !portrait || sheet === 'chat';
  const lastChatAt = view?.chat.at(-1)?.at ?? 0;
  useEffect(() => {
    if (chatOpen && lastChatAt > chatSeenAt) setChatSeenAt(lastChatAt);
  }, [chatOpen, lastChatAt]);

  // Escape closes the records panel (a dialog on top closes first).
  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !document.querySelector('.side.drawer.open')) return;
      // Escape in a text box only leaves the box; a dialog or replay on top closes first.
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (document.querySelector('.modal-backdrop, .replayer-backdrop')) return;
      const inside = document.activeElement?.closest('.side.drawer');
      setDrawer(false);
      if (inside) document.querySelector<HTMLElement>('.drawer-button')?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide]);
  // The panel only starts open until the game first starts; after that it stays as the player leaves it, so it
  // doesn't close by itself over an open replay, or pop open over the table when the host stops the game.
  const started = !!view?.started;
  useEffect(() => {
    if (started && drawerPick === null) setDrawer(false);
  }, [started, drawerPick]);
  // The records panel sits just under the top bar, however tall it is.
  const pageRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const page = pageRef.current;
    const bar = page?.querySelector<HTMLElement>('.topbar');
    if (!wide || !page || !bar) return;
    const measure = () => page.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [wide, !!view]);
  if (error) {
    // A tournament table closes when it breaks; the lobby knows the new seat.
    const tournament = error === 'table not found' ? tournamentOfTable(tableId) : null;
    return (
      <main className="home">
        <h1 className="logo">
          RSDP Poker <span>Live!</span>
        </h1>
        <p className="error">{error === 'deleted' ? 'This table was deleted.' : error === 'table not found' ? 'This table has closed or the link is wrong.' : error}</p>
        {tournament && (
          <p>
            <a href={`/tn/${tournament}`}>Back to the tournament lobby</a>
          </p>
        )}
        <a href="/">Start a new table</a>
      </main>
    );
  }
  if (!view) return <main className="home">Connecting…</main>;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt('Copy this link', location.href);
    }
  };

  const cash = view.mode === 'cash';
  const mySeat = view.me.seat !== null ? view.seats[view.me.seat] : null;
  // Worked out once per render: it reads this browser's saved notes.
  const seedWarning = liveSeedProblem(view);
  const seatRequest = view.requests.find((r) => r.playerId === view.me.playerId && r.kind === 'seat');
  const rebuyRequest = view.requests.find((r) => r.playerId === view.me.playerId && r.kind === 'rebuy');
  const pending = view.powers.includes('approve') ? view.requests.length : 0;
  const handLive = !!view.hand && view.hand.phase !== 'complete';
  const inHand = !!mySeat?.inHand && handLive;
  const canRebuy = cash && !!mySeat && view.settings.seating.allowRebuys;
  // The server's own rule (chips, or chips coming after this hand). A server from before it sent this: chips shown.
  const canSitIn = view.me.canSitIn ?? (!!mySeat && mySeat.stack > 0);
  // Like run() in the host panel: a refusal or a lost answer shows, instead of the button seeming dead.
  const seatCall = (event: 'seat:sitOut' | 'seat:prefs', payload: object) =>
    call(event, payload)
      .then(() => setSeatError(''))
      .catch((e: Error) => setSeatError(e.message));
  const seatErrorLine = seatError && (
    <div className="banner warn" role="alert">
      {seatError}{' '}
      <button onClick={() => setSeatError('')}>OK</button>
    </div>
  );
  // A player sees only their own bots' requests; the host sees everyone's and never has to ask.
  const myBotRequests = view.powers.includes('approve') ? [] : view.requests.filter((r) => r.bot);
  const myBots = view.seats.filter((s) => s?.bot?.ownerId === view.me.playerId).length + myBotRequests.length;
  const canAddBot = cash && (view.powers.includes('players') || (!!mySeat && view.settings.seating.allowPlayerBots !== false && myBots < 3));
  const addBot = (seat: number) => setDialog({ kind: 'add-bot', seat });
  // A player's popup follows their seat as it changes (a bot's new level, a move).
  const playerSeat = dialog?.kind === 'player' ? (view.seats.find((s) => s?.playerId === dialog.seat.playerId) ?? dialog.seat) : null;
  const unread = chatOpen ? 0 : unreadChat(view, chatSeenAt, chatMutes);
  const close = () => setSheet(null);

  const game = view.hand
    ? { label: gameLabel(view.hand.gameId, view.hand.betting), stakes: stakesLabel(view.hand.stakes, view.hand.family, view.hand.betting, fmt) }
    : view.upcoming
      ? {
          label: gameLabel(view.upcoming.gameId, view.upcoming.betting),
          stakes: stakesLabel(view.upcoming.stakes, gameFamily(view.upcoming.gameId), view.upcoming.betting, fmt),
        }
      : null;
  const level = view.level;
  const levelText = level
    ? `Level ${level.index + 1}/${level.count}${level.endsAt ? ` · ${clock(level.endsAt - now)}` : level.handsLeft !== null ? ` · ${level.handsLeft} hands` : ''}`
    : null;
  // Straddles need blinds, so stud tables never offer them.
  const nextFamily = view.hand?.family ?? (view.upcoming ? gameFamily(view.upcoming.gameId) : 'flop');
  const straddleOn = cash && view.settings.play.straddle !== 'off' && nextFamily !== 'stud';

  const volumeButton = (
    <button
      title={VOLUME_NAME[volume]}
      aria-label={VOLUME_NAME[volume]}
      onClick={() => {
        const v = nextVolume(volume);
        setVolume(v);
        if (v > 0) sounds.chips();
      }}
    >
      {volume === 0 ? '🔇' : volume < 0.5 ? '🔈' : volume < 1 ? '🔉' : '🔊'}
      {portrait && <> {VOLUME_NAME[volume]}</>}
    </button>
  );
  const seatButtons = mySeat && (
    <>
      {canRebuy && <button onClick={() => setDialog({ kind: 'rebuy' })}>Add chips</button>}
      {(!mySeat.sittingOut || canSitIn) && <button onClick={() => seatCall('seat:sitOut', { value: !mySeat.sittingOut })}>{mySeat.sittingOut ? "I'm back" : 'Sit out'}</button>}
      {cash && (
        <button
          onClick={() =>
            confirm(inHand ? 'Leave your seat when this hand ends? Your chips go back to the ledger.' : 'Leave your seat? Your chips go back to the ledger.') &&
            ((leftByMe.current = true), socket.emit('seat:stand', { afterHand: inHand }))
          }
        >
          {mySeat.leaving ? 'Leaving…' : 'Leave seat'}
        </button>
      )}
    </>
  );
  const seatOptions = mySeat && cash && (straddleOn || mySeat.waiting) && (
    <div className="seat-options">
      {straddleOn && (
        <label className="toggle">
          <input type="checkbox" checked={mySeat.straddle} onChange={(e) => seatCall('seat:prefs', { straddle: e.target.checked })} />
          Straddle when I'm under the gun
        </label>
      )}
      {mySeat.waiting && (
        <label className="toggle">
          <input type="checkbox" checked={mySeat.waitForBigBlind} onChange={(e) => seatCall('seat:prefs', { waitForBigBlind: e.target.checked })} />
          Wait for the big blind
        </label>
      )}
    </div>
  );
  // On a computer the same options sit under the action bar as small chips, so they don't take a whole row of words.
  const seatChips = mySeat && cash && (straddleOn || mySeat.waiting) && (
    <div className="seat-chips">
      {straddleOn && (
        <button
          className="seat-chip"
          aria-pressed={mySeat.straddle}
          title="Straddle automatically when you're under the gun"
          onClick={() => seatCall('seat:prefs', { straddle: !mySeat.straddle })}
        >
          {mySeat.straddle && <span aria-hidden>✓ </span>}Straddle
        </button>
      )}
      {mySeat.waiting && (
        <button className="seat-chip" aria-pressed={mySeat.waitForBigBlind} title="Wait for the big blind before you're dealt in" onClick={() => seatCall('seat:prefs', { waitForBigBlind: !mySeat.waitForBigBlind })}>
          {mySeat.waitForBigBlind && <span aria-hidden>✓ </span>}Wait for the big blind
        </button>
      )}
    </div>
  );
  const hostPanel = (view.isHost || view.coHosts.some((c) => c.playerId === view.me.playerId)) && cash && (
    <HostPanel
      view={view}
      fmt={fmt}
      onSettings={() => {
        close();
        setDialog({ kind: 'settings' });
      }}
    />
  );

  // The panel starts open for a host whose game hasn't started, so Start game is in view; after that it's the player's pick.
  const drawer = wide && (drawerPick ?? (!!hostPanel && !view.started));
  const openDrawer = () => setDrawer(true);

  return (
    <div ref={pageRef} className={['table-page', portrait && 'portrait', wide && 'wide'].filter(Boolean).join(' ')}>
      <header className="topbar">
        <a className="logo small" href="/">
          {portrait ? (
            <>
              R<span>!</span>
            </>
          ) : (
            <>
              RSDP Poker <span>Live!</span>
            </>
          )}
        </a>
        <span className="stakes">
          {/* At a tournament the strip under the bar names the event, so the bar just says which table. */}
          <b>{view.tournamentId ? (view.name.match(/· (Table \d+)$/)?.[1] ?? view.name) : view.name}</b>
          {game && (
            <>
              {portrait ? <br /> : ' · '}
              {game.label} {game.stakes}
            </>
          )}
          {levelText && <> · {levelText}</>}
          {view.hand?.bombPot && view.hand.phase !== 'complete' && <b> · Bomb pot</b>}
          {view.paused && <b className="paused"> · Paused</b>}
        </span>
        {bigBlind > 0 && (
          <button
            className="units-toggle"
            aria-pressed={prefs.units === 'bb'}
            aria-label="Amounts in big blinds"
            onClick={() => setPrefs({ units: prefs.units === 'bb' ? 'chips' : 'bb' })}
            title={`Show amounts in ${prefs.units === 'bb' ? (dollars ? 'dollars' : 'chips') : 'big blinds'} (B)`}
          >
            <span className={prefs.units === 'bb' ? '' : 'on'}>{dollars ? '$' : 'Chips'}</span>
            <span className={prefs.units === 'bb' ? 'on' : ''}>BB</span>
          </button>
        )}
        {portrait ? (
          <>
            <button className="chat-button" onClick={() => setSheet('chat')} aria-label={unread ? `Chat, ${unread} new` : 'Chat'}>
              💬{unread > 0 && <span className="badge">{unread}</span>}
            </button>
            <button onClick={() => setSheet('log')}>Log</button>
            <button aria-label="Menu" onClick={() => setSheet('menu')}>
              ☰{pending > 0 && <span className="badge">{pending}</span>}
            </button>
          </>
        ) : (
          <>
            <button className="invite-button" onClick={copyLink}>
              {copied ? 'Link copied' : 'Invite'}
            </button>
            {seatButtons}
            {wide && (
              <button className={drawer ? 'drawer-button on' : 'drawer-button'} aria-expanded={drawer} aria-controls="records-panel" onClick={() => setDrawer(!drawer)}>
                {hostPanel ? 'Host & log' : 'Log'}
                {pending > 0 && (
                  <span className="badge" aria-label={`, ${pending} ${pending === 1 ? 'request' : 'requests'} waiting`}>
                    {pending}
                  </span>
                )}
              </button>
            )}
            <TableMenu
              items={[
                { label: 'People', hint: `${view.watchers.length} watching`, onClick: () => setDialog({ kind: 'people' }) },
                { label: 'How to play', onClick: () => setDialog({ kind: 'rules' }) },
                { label: 'Keyboard shortcuts', hint: <kbd>?</kbd>, onClick: () => setDialog({ kind: 'keys' }) },
                { label: 'Look, sound and me', onClick: () => setDialog({ kind: 'look' }) },
                { label: 'Send feedback', hint: '✉️', onClick: () => setDialog({ kind: 'feedback' }) },
                {
                  label: `Sound: ${VOLUME_NAME[volume].replace(/^Sound /, '')}`,
                  hint: volume === 0 ? '🔇' : volume < 0.5 ? '🔈' : volume < 1 ? '🔉' : '🔊',
                  keepOpen: true,
                  onClick: () => {
                    const v = nextVolume(volume);
                    setVolume(v);
                    if (v > 0) sounds.chips();
                  },
                },
              ]}
            />
          </>
        )}
      </header>

      {!connected && <div className="banner warn">Connection lost. Reconnecting…</div>}

      <div className="layout">
        <section className="felt-area">
          {view.tournamentId && <TableStrip tournamentId={view.tournamentId} tableId={tableId} seatedHere={view.me.seat !== null} holding={view !== live} />}
          {readyTable && (
            <div className="banner attention">
              Your tournament table is ready.{' '}
              <a
                href={`/t/${readyTable}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/t/${readyTable}`);
                }}
              >
                Go to it
              </a>
            </div>
          )}
          {unseated && (
            <div className="banner attention">
              You're no longer seated: the host removed you, or your seat was released while you were away. Your chips are counted in the ledger.{' '}
              <button onClick={() => setUnseated(false)}>OK</button>
            </div>
          )}
          {cash && !view.started && (
            <div className="banner" onClick={wide && view.powers.includes('run') ? openDrawer : undefined}>
              {view.history.length > 0
                ? view.powers.includes('run')
                  ? `The game is stopped. ${portrait ? 'Start it again from the ☰ menu' : wide ? 'Press Start game under Host & log to deal again' : 'Press Start game to deal again'}.`
                  : 'The game is stopped. Waiting for the host to start it again.'
                : view.powers.includes('run')
                  ? portrait
                    ? 'Take a seat and invite friends, then start the game from the ☰ menu.'
                    : `Take a seat, send friends the invite link, then press Start game${wide ? ' under Host & log' : ''}.`
                  : 'Waiting for the host to start the game.'}
            </div>
          )}
          {view.stopAfterHand && <div className="banner">The host is stopping the game after this hand.</div>}
          {pending > 0 && (
            <div className="banner attention" onClick={portrait ? () => setSheet('menu') : wide ? openDrawer : undefined}>
              {pending} {pending === 1 ? 'request is' : 'requests are'} waiting for you. {portrait ? 'Tap to see.' : wide ? 'Click to see.' : 'See Host controls.'}
            </div>
          )}
          {seatRequest && (
            <div className="banner">
              Waiting for the host to let you sit…{' '}
              <button onClick={() => socket.emit('seat:cancel')}>Cancel</button>
            </div>
          )}
          {myBotRequests.map((r) => (
            <div className="banner" key={r.id}>
              Your bot {r.name} is waiting for the host to let it sit…{' '}
              <button onClick={() => call('bot:remove', { playerId: r.playerId }).catch((e: Error) => alert(e.message))}>Cancel</button>
            </div>
          ))}
          <SeatingBanners view={view} skew={skew} onTakeSeat={(seat) => setDialog({ kind: 'seat', seat })} onJoinWaitlist={() => setDialog({ kind: 'seat', seat: 0, waitlist: true })} onPeople={() => setDialog({ kind: 'people' })} />
          {seedWarning && <div className="banner warn">⚠ Fair dealing: {seedWarning}. Tell the table, and check this hand once it&rsquo;s revealed.</div>}
          {rebuyRequest && <div className="banner">Waiting for the host to approve your {fmt(rebuyRequest.amount)} rebuy…</div>}
          {mySeat?.sittingOut && (
            <div className="banner">
              {mySeat.sitOutReason === 'busted'
                ? "You're out of chips."
                : mySeat.sitOutReason === 'timeouts'
                  ? 'You were marked away after running out of time.'
                  : mySeat.sitOutReason === 'host'
                    ? 'The host sat you out.'
                    : "You're sitting out."}
              {mySeat.owesBlinds && ' You will post the blinds you missed when you come back.'}{' '}
              {(mySeat.sitOutReason === 'busted' || !canSitIn) && canRebuy ? (
                <button className="primary" onClick={() => setDialog({ kind: 'rebuy' })}>
                  Add chips
                </button>
              ) : canSitIn ? (
                <button className="primary" onClick={() => seatCall('seat:sitOut', { value: false })}>
                  I'm back
                </button>
              ) : (
                mySeat.sitOutReason !== 'busted' && 'You have no chips to play with.'
              )}
            </div>
          )}
          {seatErrorLine}
          <Table
            view={view}
            skew={skew}
            fmt={feltFmt}
            compact={portrait}
            fill
            wide={wide}
            onPickSeat={cash && !mySeat && !seatRequest ? (seat) => setDialog({ kind: 'seat', seat }) : undefined}
            onAddBot={canAddBot ? addBot : undefined}
            onSeatClick={(seat) => setDialog({ kind: 'player', seat })}
            discard={view.canDraw ? { selected: discard, toggle: (i) => setDiscard((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i])) } : null}
          />
          {/* A zero-height anchor between the felt and the action bar: the tip floats up over the felt's corner. The anchor
              stays even with no tip, so the felt's height doesn't change when the tip comes and goes, which made the
              whole table twitch on big screens (#350). */}
          <div className="tip-anchor">
            {keysTip && !dialog && (
              <div className="tip-toast" role="status">
                <span>
                  Tip: play from the keyboard. <kbd>F</kbd> folds, <kbd>K</kbd> checks, <kbd>C</kbd> calls, <kbd>R</kbd> raises{bigBlind > 0 && <>, <kbd>B</kbd> switches chips and big blinds</>}
                  {view.tips && prefs.tips && <>, <kbd>T</kbd> opens the coach&apos;s tip</>}.
                </span>
                <button
                  onClick={() => {
                    dismissKeysTip();
                    setDialog({ kind: 'keys' });
                  }}
                >
                  All shortcuts
                </button>
                <button onClick={() => dismissKeysTip()}>Got it</button>
              </div>
            )}
          </div>
          <Dock
            reset={`${portrait}:${view.me.seat}`}
            seated={view.me.seat !== null}
            limit={(view.hand ?? view.upcoming)?.betting === 'fixed-limit'}
            tips={!!view.tips && prefs.tips}
          >
            <ActionBar
              view={view}
              fmt={fmt}
              bigBlind={prefs.units === 'bb' && bigBlind > 0 ? bigBlind : null}
              skew={skew}
              discard={discard}
              clearDiscard={() => setDiscard([])}
              setDiscard={setDiscard}
              onPreAction={(q) => {
                preQueued.current = q;
              }}
              onRules={() => setDialog({ kind: 'rules' })}
            />
            <div className="dock-row">
              <HandExtras view={view} />
              {!portrait && seatChips}
            </div>
          </Dock>
        </section>
        {!portrait && (
          <aside id="records-panel" className={wide ? `side drawer${drawer ? ' open' : ''}` : 'side'}>
            {hostPanel}
            <PartBoundary name="side panel">
              <SidePanel view={view} fmt={fmt} />
            </PartBoundary>
            {!wide && (
              <PartBoundary name="chat">
                <ChatBox view={view} letGo={hasKeyboard()} />
              </PartBoundary>
            )}
          </aside>
        )}
        {wide && (
          <div className="corner-chat">
            <PartBoundary name="chat">
              <ChatBox view={view} letGo={hasKeyboard()} />
            </PartBoundary>
          </div>
        )}
      </div>

      {portrait && sheet === 'menu' && (
        <Sheet title={view.name} onClose={close}>
          {hostPanel}
          <div className="menu-buttons">
            {seatButtons}
            <button onClick={copyLink}>{copied ? 'Link copied!' : 'Copy invite link'}</button>
            <button
              onClick={() => {
                close();
                setDialog({ kind: 'rules' });
              }}
            >
              How to play
            </button>
            <button
              onClick={() => {
                close();
                setDialog({ kind: 'people' });
              }}
            >
              People · {view.watchers.length} watching
            </button>
            <button
              onClick={() => {
                close();
                setDialog({ kind: 'look' });
              }}
            >
              🎨 Look, sound and me
            </button>
            <button
              onClick={() => {
                close();
                setDialog({ kind: 'feedback' });
              }}
            >
              ✉️ Send feedback
            </button>
            {volumeButton}
          </div>
          {seatOptions}
          {seatErrorLine}
        </Sheet>
      )}
      {portrait && sheet === 'chat' && (
        <Sheet title="Chat" onClose={close} className="chat-sheet">
          <PartBoundary name="chat">
            <ChatBox view={view} autoFocus />
          </PartBoundary>
        </Sheet>
      )}
      {portrait && sheet && sheet !== 'menu' && sheet !== 'chat' && (
        <Sheet title="Table" onClose={close} tall>
          <PartBoundary name="side panel">
            <SidePanel view={view} fmt={fmt} initialTab={sheet} />
          </PartBoundary>
        </Sheet>
      )}

      {dialog?.kind === 'seat' && <SeatDialog view={view} seat={dialog.seat} waitlist={dialog.waitlist} fmt={fmt} onClose={() => setDialog(null)} />}
      {playerSeat &&
        (view.powers.length > 0 && cash ? (
          <PlayerDialog view={view} seat={playerSeat} fmt={fmt} onClose={() => setDialog(null)}>
            <PlayerExtras view={view} seat={playerSeat} onDone={() => setDialog(null)} />
          </PlayerDialog>
        ) : (
          <Modal title={playerSeat.playerId === view.me.playerId ? 'You' : playerSeat.name} onClose={() => setDialog(null)}>
            {playerSeat.bot && playerSeat.bot.ownerId !== view.me.playerId && (
              <p className="muted">
                {botOwnerLabel(playerSeat.bot, 'practice bot')}. {LEVEL_INFO[playerSeat.bot.level ?? 'normal'].about}
              </p>
            )}
            <PlayerExtras view={view} seat={playerSeat} onDone={() => setDialog(null)} />
            {playerSeat.bot?.ownerId === view.me.playerId && <MyBot view={view} seat={playerSeat} onDone={() => setDialog(null)} />}
            <div className="row">
              <button onClick={() => setDialog(null)}>Close</button>
            </div>
          </Modal>
        ))}
      {dialog?.kind === 'add-bot' && <AddBotDialog view={view} seat={dialog.seat} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rebuy' && <RebuyDialog view={view} fmt={fmt} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog view={view} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rules' && <RulesDialog view={view} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'people' && <PeopleDialog view={view} fmt={fmt} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'look' && <LookDialog view={view} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'keys' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'feedback' && <FeedbackDialog portrait={portrait} onClose={() => setDialog(null)} />}
    </div>
  );
}

function gameFamily(gameId: string) {
  try {
    return getVariant(gameId).family;
  } catch {
    return 'flop';
  }
}
