import { useEffect, useRef, useState } from 'react';
import type { ChatView, TableView } from '@rsdp/engine/wire';
import { call } from '../../socket';
import { setChatMuted, useChatMutes } from '../../chatMutes';
import { px, type Point } from '../geometry';
import './chat.css';

/** One-tap replies under the chat box. */
const QUICK = ['nh', 'gg', 'ty', 'lol', 'gl', '😂', '🔥'];
/** How long a message stays up beside the speaker's seat. */
const BUBBLE_MS = 6000;

const sameMessage = (a: ChatView, b: ChatView) => a.at === b.at && a.playerId === b.playerId && a.text === b.text;

/**
 * Messages in `after` that weren't in `before`. The view carries only the latest
 * hundred lines, so once chat is busy the list stops growing and its length
 * says nothing; find where the old list ended instead.
 */
export function newChat(before: ChatView[], after: ChatView[]): ChatView[] {
  const last = before.at(-1);
  if (!last) return after;
  for (let i = after.length - 1; i >= 0; i--) if (sameMessage(after[i], last)) return after.slice(i + 1);
  // The old last line scrolled out of the view entirely: everything is new.
  return after.filter((m) => m.at > last.at);
}

/** Messages from other people since `seenAt`, leaving out anyone you muted. */
export function unreadChat(view: TableView, seenAt: number, mutes: string[]) {
  return view.chat.filter((m) => m.at > seenAt && m.playerId && m.playerId !== view.me.playerId && !mutes.includes(m.playerId)).length;
}

/** The table chat: messages, a box to type in and quick replies. Always on screen at a desk; a sheet on a phone. */
export function ChatBox({ view, autoFocus = false, letGo = false }: { view: TableView; autoFocus?: boolean; letGo?: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const mutes = useChatMutes();
  const scroller = useRef<HTMLDivElement>(null);
  const shown = view.chat.filter((m) => !m.playerId || !mutes.includes(m.playerId));
  const mutedByHost = view.muted.includes(view.me.playerId);
  const quiet = !view.settings.chat.guestChat && view.me.seat === null && !view.isHost && !view.coHosts.some((c) => c.playerId === view.me.playerId);
  const canTalk = !mutedByHost && !quiet;

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [shown.length, view.chat.at(-1)?.at]);

  // At a desk the chat box lets go once a message is sent, so the next keys are shortcuts or a bet again,
  // not more chat (#320). Enter goes back in. A phone's chat sheet keeps its keyboard up for the next line.
  const release = () => {
    if (letGo && document.activeElement instanceof HTMLElement && document.activeElement.closest('.chat-box')) document.activeElement.blur();
  };
  const send = (say: string) => {
    if (!say.trim()) return;
    call('chat:send', { text: say })
      .then(() => setError(''))
      .catch((err: Error) => setError(err.message));
  };

  return (
    <div className="panel chat-box">
      <div className="chat-title">Chat</div>
      <div className="scroll chat-scroll" ref={scroller}>
        {shown.length ? (
          shown.map((m, i) => (
            <div key={`${m.at}-${i}`} className={m.playerId ? (m.playerId === view.me.playerId ? 'chat-line mine' : 'chat-line') : 'chat-line log-table'}>
              {m.playerId ? (
                m.playerId === view.me.playerId ? (
                  <b>{m.name}: </b>
                ) : (
                  <b className="chat-name" title={`Click to mute ${m.name} for you`} onClick={() => confirm(`Mute ${m.name}? Only you stop seeing their messages.`) && setChatMuted(m.playerId!, true)}>
                    {m.name}:{' '}
                  </b>
                )
              ) : null}
              {m.text}
            </div>
          ))
        ) : (
          <p className="muted">No messages yet. Say hi!</p>
        )}
      </div>
      <ChatNotes view={view} mutes={mutes} mutedByHost={mutedByHost} quiet={quiet} error={error} />
      {canTalk && (
        <>
          <form
            className="row chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) release();
              send(text);
              setText('');
            }}
          >
            <input value={text} maxLength={300} placeholder="Type a message" aria-label="Chat message" autoFocus={autoFocus} enterKeyHint="send" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()} />
            <button disabled={!text.trim()}>Send</button>
          </form>
          <div className="quick-replies">
            {QUICK.map((q) => (
              <button key={q} type="button" onClick={() => {
                  send(q);
                  release();
                }}
                title={`Send “${q}”`}>
                {q}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Under the chat: whom you muted, and why you can't talk if you can't. */
function ChatNotes({ view, mutes, mutedByHost, quiet, error }: { view: TableView; mutes: string[]; mutedByHost: boolean; quiet: boolean; error: string }) {
  const name = (id: string) => [...view.chat].reverse().find((m) => m.playerId === id)?.name ?? view.seats.find((s) => s?.playerId === id)?.name ?? view.watchers.find((w) => w.playerId === id)?.name ?? 'Guest';
  const shown = mutes.filter((id) => view.chat.some((m) => m.playerId === id) || view.seats.some((s) => s?.playerId === id) || view.watchers.some((w) => w.playerId === id));
  if (!shown.length && !mutedByHost && !quiet && !error) return null;
  return (
    <div className="chat-notes muted">
      {mutedByHost ? <div>The host has muted you.</div> : quiet ? <div>Only players at the table can chat here.</div> : error && <div className="error">{error}</div>}
      {shown.length > 0 && (
        <div>
          Muted for you:{' '}
          {shown.map((id) => (
            <button key={id} className="link" title="Unmute" onClick={() => setChatMuted(id, false)}>
              {name(id)} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Bubble = { id: number; playerId: string; text: string };
let bubbleId = 0;

/** New messages pop up beside the speaker's seat for a few seconds, so nobody has to watch the chat box. */
export function ChatBubbles({ view, seatPoint, width, height }: { view: TableView; seatPoint: (seat: number) => Point; width: number; height: number }) {
  const mutes = useChatMutes();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const before = useRef<ChatView[] | null>(null);
  const muted = useRef(mutes);
  muted.current = mutes;
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const old = before.current;
    before.current = view.chat;
    // Chat from before you arrived is not news.
    if (!old) return;
    // Your own lines don't pop up on your screen: you just typed them, and they'd cover your cards.
    const fresh = newChat(old, view.chat).filter((m) => m.playerId && m.playerId !== view.me.playerId && !muted.current.includes(m.playerId));
    const add: Bubble[] = [];
    for (const m of fresh) if (view.seats.some((s) => s?.playerId === m.playerId)) add.push({ id: ++bubbleId, playerId: m.playerId!, text: m.text });
    if (!add.length) return;
    // One bubble per player: a new line replaces their last one.
    const speakers = new Set(add.map((b) => b.playerId));
    setBubbles((bs) => [...bs.filter((b) => !speakers.has(b.playerId)), ...add.filter((b, i) => !add.slice(i + 1).some((x) => x.playerId === b.playerId))]);
    for (const b of add) {
      const t = setTimeout(() => {
        timers.current.delete(t);
        setBubbles((bs) => bs.filter((x) => x.id !== b.id));
      }, BUBBLE_MS);
      timers.current.add(t);
    }
  }, [view.chat]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return (
    <>
      {bubbles.map((b) => {
        // The bubble follows its speaker, and goes if they leave the table.
        const seat = view.seats.find((s) => s?.playerId === b.playerId);
        if (!seat) return null;
        const p = seatPoint(seat.seat);
        // Seats in the top half speak downwards, toward the middle; the rest speak upwards.
        // Side seats lean their bubble inwards so it stays on the screen.
        const below = p.y < height / 2;
        const lean = p.x < width * 0.3 ? 'lean-right' : p.x > width * 0.7 ? 'lean-left' : '';
        return (
          <div key={b.id} className={`chat-bubble ${below ? 'below' : 'above'} ${lean}`} style={px(p)} role="status">
            <span>{b.text}</span>
          </div>
        );
      })}
    </>
  );
}
