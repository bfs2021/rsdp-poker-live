import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AVATARS, BOT_LOOKS, GESTURES, type GestureKind, type SeatView, type TableView } from '@rsdp/engine/wire';
import { call, currentSession, onSession, socket } from '../../socket';
import { setPrefs, usePrefs } from '../../prefs';
import { sounds } from '../../sound';
import { fromVars, px, type Point } from '../geometry';
import { botOwnerLabel } from './BotLevels';
import { NoteButton } from './Notes';

/*
 * Who a player is at the table, beyond their name: a picture (from the
 * built-in library or uploaded), a mood emoji by the seat, and gestures
 * thrown from one seat to another. All free, all our own art (emoji).
 */

export const GESTURE_INFO: Record<GestureKind, { emoji: string; label: string }> = {
  heart: { emoji: '❤️', label: 'Heart' },
  clap: { emoji: '👏', label: 'Applause' },
  cheers: { emoji: '🍻', label: 'Cheers' },
  fire: { emoji: '🔥', label: 'On fire' },
  laugh: { emoji: '😂', label: 'Laugh' },
  cry: { emoji: '😭', label: 'Tears' },
  money: { emoji: '💸', label: 'Take my money' },
  fish: { emoji: '🐟', label: 'Fish' },
  shark: { emoji: '🦈', label: 'Shark' },
  clown: { emoji: '🤡', label: 'Clown' },
  tomato: { emoji: '🍅', label: 'Tomato' },
  rose: { emoji: '🌹', label: 'Rose' },
};

/** Quick picks for the mood; the emoji keyboard gives the rest. */
const MOODS = ['😎', '😀', '🤔', '😴', '🤠', '😤', '🥶', '🔥', '🍀', '🎉', '🍕', '☕', '🍺', '🙏', '💀', '🫠'];

/** A player's picture: a library emoji on its colour, or their upload. Nothing when they have none. */
export function Avatar({ playerId, avatar, name, size = 36 }: { playerId: string; avatar: string | null; name: string; size?: number }) {
  if (!avatar) return null;
  const style = { width: size, height: size, fontSize: Math.round(size * 0.58) };
  if (avatar.startsWith('lib:')) {
    const a = AVATARS[avatar.slice(4)];
    if (!a) return null;
    return (
      <span className="avatar" style={{ ...style, background: a.bg }} role="img" aria-label={`${name}'s picture`}>
        {a.emoji}
      </span>
    );
  }
  if (avatar.startsWith('up:')) return <img className="avatar" style={style} src={`/api/avatars/${encodeURIComponent(playerId)}?v=${avatar.slice(3)}`} alt={`${name}'s picture`} loading="lazy" />;
  return null;
}

const BOT_INK = '#1f2630';

/** The eyes and mouth that, with the colour, tell one practice bot from another. */
function BotFace({ face, color }: { face: number; color: string }) {
  switch (face % 4) {
    case 1: // visor
      return (
        <>
          <rect x="11" y="16" width="14" height="4.4" rx="2.2" fill={BOT_INK} />
          <circle cx="14.6" cy="18.2" r="1.2" fill={color} />
          <circle cx="21.4" cy="18.2" r="1.2" fill={color} />
          <rect x="15" y="23" width="6" height="1.7" rx="0.85" fill={BOT_INK} />
        </>
      );
    case 2: // square eyes and a smile
      return (
        <>
          <rect x="12" y="15.8" width="4.2" height="4.2" rx="1" fill={BOT_INK} />
          <rect x="19.8" y="15.8" width="4.2" height="4.2" rx="1" fill={BOT_INK} />
          <path d="M14 22.4 Q18 25.6 22 22.4" fill="none" stroke={BOT_INK} strokeWidth="1.7" strokeLinecap="round" />
        </>
      );
    case 3: // one big eye
      return (
        <>
          <circle cx="18" cy="18.2" r="3.6" fill={BOT_INK} />
          <circle cx="18" cy="18.2" r="1.5" fill={color} />
          <rect x="13.5" y="23" width="9" height="1.7" rx="0.85" fill={BOT_INK} />
        </>
      );
    default: // round eyes and a grille
      return (
        <>
          <circle cx="14" cy="18" r="2.2" fill={BOT_INK} />
          <circle cx="22" cy="18" r="2.2" fill={BOT_INK} />
          <rect x="13" y="22.4" width="10" height="2.4" rx="1.2" fill={BOT_INK} />
          <path d="M16.3 22.4v2.4M19.7 22.4v2.4" stroke="#f4f6f8" strokeWidth="0.8" />
        </>
      );
  }
}

/** A practice bot's picture: a robot in its own colour and face (BOT_LOOKS), drawn here so it's the same on every device. */
export function BotAvatar({ look, title, size = 36 }: { look: number; title: string; size?: number }) {
  const n = BOT_LOOKS.length;
  const { color, face } = BOT_LOOKS[((Math.trunc(look) % n) + n) % n] ?? BOT_LOOKS[0];
  return (
    <span className="avatar bot-avatar" style={{ width: size, height: size }} role="img" aria-label={title} title={title}>
      <svg viewBox="0 0 36 36" width="100%" height="100%" aria-hidden="true">
        <circle cx="18" cy="18" r="18" fill={color} />
        <path d="M18 7.5v4" stroke="#f4f6f8" strokeWidth="1.6" />
        <circle cx="18" cy="6.6" r="1.9" fill="#f4f6f8" />
        <rect x="6.2" y="15.5" width="2.6" height="6" rx="1.2" fill="#f4f6f8" />
        <rect x="27.2" y="15.5" width="2.6" height="6" rx="1.2" fill="#f4f6f8" />
        <rect x="8.5" y="11" width="19" height="16.5" rx="4.5" fill="#f4f6f8" />
        <BotFace face={face} color={color} />
      </svg>
    </span>
  );
}

const INITIALS_COLORS = ['#e5574b', '#3b82f6', '#e39a1c', '#14a06f', '#8b5cf6', '#e0558f', '#0f9fae', '#6b7a8f'];

/** A steady colour per player for the initials shown when there's no picture. */
export function initialsColor(playerId: string) {
  let h = 0;
  for (const ch of playerId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return INITIALS_COLORS[Math.abs(h) % INITIALS_COLORS.length];
}

/** Picture and mood on a seat, as this viewer chose to see them. */
export function SeatPersona({ seat, badge }: { seat: SeatView; badge?: ReactNode }) {
  const prefs = usePrefs();
  const showAvatar = prefs.avatars && !!seat.avatar && !prefs.hiddenAvatars.includes(seat.playerId);
  const showMood = prefs.moods && !!seat.mood;
  return (
    <>
      <span className="seat-avatar">
        {seat.bot ? (
          // Practice bots always show their robot, so nobody mistakes one for a person or for another bot.
          <>
            <BotAvatar look={seat.bot.look} title={`${seat.name}, ${botOwnerLabel(seat.bot, 'practice bot')}`} />
            {/* Phones show its level here (the nameplate has no room for the owner line). */}
            <span className="bot-badge">{seat.bot.level && seat.bot.level !== 'normal' ? seat.bot.level : 'bot'}</span>
          </>
        ) : showAvatar ? (
          <Avatar playerId={seat.playerId} avatar={seat.avatar} name={seat.name} />
        ) : (
          <span className="avatar initials" style={{ background: initialsColor(seat.playerId) }} aria-hidden="true">
            {[...seat.name.trim()][0]?.toUpperCase() ?? '?'}
          </span>
        )}
        {badge}
      </span>
      {showMood && (
        <span className="seat-mood" title={`${seat.name}'s mood`}>
          {seat.mood}
        </span>
      )}
    </>
  );
}

/** My own picture, from the session (it follows me to every table). */
function useMyAvatar() {
  return useSyncExternalStore(onSession, () => currentSession()?.avatar ?? null);
}

/** Shrinks a picture to a small square JPEG, centre-cropped, so uploads stay a few kilobytes. */
async function shrink(file: File, size = 160): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file isn’t a picture this browser can open.'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d')!;
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    for (const q of [0.85, 0.7, 0.5]) {
      const data = canvas.toDataURL('image/jpeg', q);
      if (data.length < 55_000) return data;
    }
    throw new Error('That picture is too detailed; try another.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Pick my picture (library or upload) and, when seated, my mood. */
export function MyProfile({ view }: { view: TableView | null }) {
  const mine = useMyAvatar();
  const me = useSyncExternalStore(onSession, () => currentSession()?.playerId ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const seat = view && view.me.seat !== null ? view.seats[view.me.seat] : null;
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    return p
      .then(() => setError(''))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const pick = (input: { library?: string; image?: string } | null) => run(call('avatar:set', input));
  const setSeatMood = (m: string | null) => run(call('seat:prefs', { mood: m }));

  return (
    <div className="my-profile">
      <h3>My picture</h3>
      <div className="row">
        <Avatar playerId={me} avatar={mine} name="My" size={56} />
        {!mine && <span className="muted">No picture yet.</span>}
        <button disabled={busy} onClick={() => file.current?.click()}>
          Upload a photo
        </button>
        {mine && (
          <button disabled={busy} onClick={() => pick(null)}>
            Remove
          </button>
        )}
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void run(shrink(f).then((image) => call('avatar:set', { image })));
          }}
        />
      </div>
      <div className="avatar-grid" role="listbox" aria-label="Pictures">
        {Object.keys(AVATARS).map((id) => (
          <button key={id} className={`avatar-pick ${mine === `lib:${id}` ? 'active' : ''}`} disabled={busy} onClick={() => pick({ library: id })} aria-label={id} aria-selected={mine === `lib:${id}`}>
            <Avatar playerId="" avatar={`lib:${id}`} name={id} size={40} />
          </button>
        ))}
      </div>
      <p className="hint">Your picture follows you to every table and tournament.</p>
      {seat && (
        <>
          <h3>Mood</h3>
          <div className="mood-grid">
            {MOODS.map((m) => (
              <button key={m} className={`mood-pick ${seat.mood === m ? 'active' : ''}`} disabled={busy} onClick={() => setSeatMood(m)}>
                {m}
              </button>
            ))}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (mood.trim()) void setSeatMood(mood.trim()).then(() => setMood(''));
            }}
          >
            <input value={mood} maxLength={16} placeholder="Or type any emoji" onChange={(e) => setMood(e.target.value)} aria-label="Mood emoji" />
            <button disabled={busy || !mood.trim()}>Set</button>
            {seat.mood && (
              <button type="button" disabled={busy} onClick={() => setSeatMood(null)}>
                Clear mood
              </button>
            )}
          </form>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** What a tap on a seat offers besides the host's tools: my profile for my seat, gestures for anyone else. */
export function PlayerExtras({ view, seat: tapped, onDone }: { view: TableView; seat: SeatView; onDone: () => void }) {
  const prefs = usePrefs();
  const seat = view.seats.find((s) => s?.playerId === tapped.playerId) ?? tapped;
  const [error, setError] = useState('');
  if (seat.playerId === view.me.playerId) return <MyProfile view={view} />;
  const off = view.settings.chat.gestures === false;
  const hidden = prefs.hiddenAvatars.includes(seat.playerId);
  return (
    <div className="player-extras">
      <h3>Throw a gesture</h3>
      {off ? (
        <p className="muted">The host has turned gestures off.</p>
      ) : (
        <div className="gesture-grid">
          {GESTURES.map((g) => (
            <button
              key={g}
              title={GESTURE_INFO[g].label}
              aria-label={`${GESTURE_INFO[g].label} at ${seat.name}`}
              onClick={() => call('table:gesture', { to: seat.playerId, kind: g }).then(onDone, (e: Error) => setError(e.message))}
            >
              {GESTURE_INFO[g].emoji}
            </button>
          ))}
        </div>
      )}
      {prefs.gestures === 'off' && <p className="hint">You have gestures hidden for yourself (Table look → Sound).</p>}
      {seat.avatar && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setPrefs({ hiddenAvatars: e.target.checked ? [...prefs.hiddenAvatars, seat.playerId] : prefs.hiddenAvatars.filter((x) => x !== seat.playerId) })}
          />
          Hide {seat.name}'s picture (only for me)
        </label>
      )}
      <NoteButton seat={seat} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface Throw {
  id: number;
  kind: GestureKind;
  from: Point;
  to: Point;
}
let throwId = 0;

/** Gestures flying across the felt from the thrower's seat (or the rail, for a spectator) to their target. */
export function GestureLayer({ view, seatPoint, railPoint }: { view: TableView; seatPoint: (seat: number) => Point; railPoint: Point }) {
  const prefs = usePrefs();
  const [flying, setFlying] = useState<Throw[]>([]);
  const latest = useRef({ view, seatPoint, railPoint, mode: prefs.gestures });
  latest.current = { view, seatPoint, railPoint, mode: prefs.gestures };
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onGesture = (g: { from: string; to: string; kind: GestureKind }) => {
      const { view: v, seatPoint: at, railPoint: rail, mode } = latest.current;
      if (mode === 'off' || document.hidden || !Object.hasOwn(GESTURE_INFO, g.kind)) return;
      const target = v.seats.find((s) => s?.playerId === g.to);
      if (!target) return;
      const thrower = v.seats.find((s) => s?.playerId === g.from);
      const t: Throw = { id: ++throwId, kind: g.kind, from: thrower ? at(thrower.seat) : rail, to: at(target.seat) };
      setFlying((f) => [...f.slice(-11), t]);
      const land = setTimeout(() => {
        timers.delete(land);
        sounds.gesture(g.kind);
      }, 700);
      const done = setTimeout(() => {
        timers.delete(done);
        setFlying((f) => f.filter((x) => x.id !== t.id));
      }, 2200);
      timers.add(land).add(done);
    };
    socket.on('table:gesture', onGesture);
    return () => {
      socket.off('table:gesture', onGesture);
      timers.forEach(clearTimeout);
    };
  }, []);
  return (
    <>
      {flying.map((t) => (
        <div key={t.id} className="gesture-flight" style={{ ...px(t.to), ...fromVars(t.from, t.to) }} aria-hidden="true">
          {GESTURE_INFO[t.kind].emoji}
        </div>
      ))}
    </>
  );
}
