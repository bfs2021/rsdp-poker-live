import { useEffect, useMemo, useRef, useState } from 'react';
import {
  copySettings,
  defaultSettings,
  nextOccurrence,
  applyStarter,
  payoutPreset,
  RSDP_TABLE_RULES,
  upcomingOccurrences,
  validateSchedule,
  validateSettings,
  MAX_BUYS_PER_PLAYER,
  type PayoutPresetName,
  type RecurrenceRule,
  type Schedule,
  type StructureRow,
  type TableRules,
  type TournamentSettings,
  type Weekday,
} from '@rsdp/tournament';
import { LocalTournamentClient, tournamentClient } from './client';
import { GAMES, localTime } from './format';
import type { BettingKind } from '@rsdp/engine/core';
import { getVariant, mixedGameMaxPlayers, mixedGameOf, MIXED_GAMES, VARIANT_LIST, type MixedGame } from '@rsdp/engine/variants';
import { useSession } from './hooks';
import { call } from '../socket';
import { FormatsEditor, NO_FORMATS, type Formats } from './FormatsEditor';
import { PayoutEditor } from './PayoutEditor';
import { StructureEditor } from './StructureEditor';
import { SavedStructures } from './SavedStructures';
import { TableRulesFields } from './TableRules';
import { SiteHeader } from '../components/SiteHeader';

/** A new tournament starts on the group's own RSDP structure and table rules. */
const RSDP_DEFAULTS = applyStarter(defaultSettings(), 'rsdp');

type StartKind = 'scheduled' | 'sng' | 'manual';
type Repeat = 'none' | 'daily' | 'weekly' | 'monthly-day' | 'monthly-nth';

/** The game picker's rows: Hold'em, Omaha, Stud and Draw, so twelve games don't read as one long list. */
const GAME_GROUPS: [string, typeof GAMES][] = (() => {
  const group = (id: string, name: string) => (getVariant(id).family === 'stud' ? 'Stud' : getVariant(id).family === 'draw' ? 'Draw' : /Omaha/.test(name) ? 'Omaha' : "Hold'em");
  const order = ["Hold'em", 'Omaha', 'Stud', 'Draw'];
  return order.map((g) => [g, GAMES.filter((x) => group(x.id, x.name) === g)] as [string, typeof GAMES]).filter(([, list]) => list.length > 0);
})();

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NTH = [
  { v: 1, label: 'First' },
  { v: 2, label: 'Second' },
  { v: 3, label: 'Third' },
  { v: 4, label: 'Fourth' },
  { v: -1, label: 'Last' },
] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const int = (v: string, min = 0) => Math.max(min, Math.floor(Number(v) || 0));

function defaultDate() {
  const d = new Date(Date.now() + 24 * 3600_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function tzList(): string[] {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return all.includes(here) ? all : [here, ...all];
}

/** The form's start fields for copied settings (TRN-07). */
function startFields(initial: TournamentSettings | undefined) {
  const start = initial?.start;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (start?.kind !== 'scheduled') return { date: defaultDate(), time: '19:30', timeZone: zone, repeat: 'none' as Repeat, weekdays: [] as Weekday[], nth: 1 as const, carry: {} };
  if (!start.schedule) {
    const d = new Date(start.startAt);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, timeZone: zone, repeat: 'none' as Repeat, weekdays: [] as Weekday[], nth: 1 as const, carry: {} };
  }
  const { startDate, time, timeZone, repeat: r, until } = start.schedule;
  const repeat: Repeat = !r ? 'none' : r.freq === 'daily' ? 'daily' : r.freq === 'weekly' ? 'weekly' : 'monthDay' in r ? 'monthly-day' : 'monthly-nth';
  return {
    date: startDate,
    time,
    timeZone,
    repeat,
    weekdays: r?.freq === 'weekly' ? r.weekdays : ([] as Weekday[]),
    nth: r && 'nth' in r ? r.nth : (1 as const),
    // Parts of a copied schedule the form has no fields for.
    carry: { ...(r?.interval ? { interval: r.interval } : {}), ...(until ? { until } : {}) },
  };
}

/** `/tn/new?from=<id>`: the form filled in from another tournament. Loading a starter or saved structure fills it in again. */
export function TournamentCreatePage({ from, onCreated }: { from: string | null; onCreated: (id: string) => void }) {
  const [copied, setCopied] = useState<TournamentSettings | null>(null);
  const [loaded, setLoaded] = useState<{ settings: TournamentSettings; note: string; n: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!from) return;
    // One view is all the copy needs; it can arrive before subscribe returns.
    let done = false;
    let off: (() => void) | null = null;
    off = tournamentClient().subscribe(
      from,
      (v) => {
        setCopied((prev) => prev ?? copySettings(v.state.settings, v.serverNow));
        done = true;
        off?.();
      },
      (m) => setError(m),
    );
    if (done) off();
    return () => off?.();
  }, [from]);
  const onLoad = (settings: TournamentSettings, note: string) => setLoaded((prev) => ({ settings, note, n: (prev?.n ?? 0) + 1 }));
  if (loaded) return <TournamentCreate key={loaded.n} onCreated={onCreated} initial={loaded.settings} note={loaded.note} onLoad={onLoad} />;
  if (!from) return <TournamentCreate onCreated={onCreated} onLoad={onLoad} />;
  if (error) return <main className="tn-page"><p className="error">Couldn't copy that tournament: {error}</p><a href="/tn/new">Start from scratch</a></main>;
  if (!copied) return <main className="tn-page"><p className="muted">Copying settings…</p></main>;
  return <TournamentCreate onCreated={onCreated} initial={copied} note="Copied from another tournament. Check the start time, then create." onLoad={onLoad} />;
}

export function TournamentCreate({
  onCreated,
  initial,
  note,
  onLoad,
}: {
  onCreated: (id: string) => void;
  initial?: TournamentSettings;
  /** Where the form's settings came from, shown under the heading. */
  note?: string;
  /** Fill the form in again from these settings (a starter or a saved structure). */
  onLoad?: (settings: TournamentSettings, note: string) => void;
}) {
  const session = useSession();
  const first = useMemo(() => startFields(initial), [initial]);
  const [name, setName] = useState(initial?.name ?? 'Friday Night Tournament');
  const [games, setGames] = useState<string[]>(initial?.games ?? ['nlhe']);
  // HORSE and 8-Game give each game its own betting (Limit Hold'em, then No-Limit Hold'em); null for the usual one.
  const [gameBetting, setGameBetting] = useState<(BettingKind | null)[] | undefined>(initial?.gameBetting);
  const [startingStack, setStartingStack] = useState(initial?.startingStack ?? RSDP_DEFAULTS.startingStack);
  const [seatsPerTable, setSeats] = useState(initial?.seatsPerTable ?? 9);
  const [maxEntrants, setMaxEntrants] = useState(initial?.maxEntrants ?? 100);
  const [startKind, setStartKind] = useState<StartKind>(initial?.start.kind ?? 'scheduled');
  const [date, setDate] = useState(first.date);
  const [time, setTime] = useState(first.time);
  const [timeZone, setTimeZone] = useState(first.timeZone);
  const [repeat, setRepeat] = useState<Repeat>(first.repeat);
  const [weekdays, setWeekdays] = useState<Weekday[]>(first.weekdays);
  const [nth, setNth] = useState<1 | 2 | 3 | 4 | -1>(first.nth);
  const [sng, setSng] = useState(initial?.start.kind === 'sng' ? { playersNeeded: initial.start.playersNeeded, startDelaySeconds: initial.start.startDelaySeconds, autoSpawn: initial.start.autoSpawn } : { playersNeeded: 9, startDelaySeconds: 30, autoSpawn: true });
  const [structure, setStructure] = useState<StructureRow[]>(() => initial?.structure ?? structuredClone(RSDP_DEFAULTS.structure));
  /** The break ticking Add-ons put in, so unticking it takes that break out again. */
  const addOnBreak = useRef<StructureRow | null>(null);
  // Copied settings keep the fields this form has no inputs for (seating lead, grace, hand-for-hand, rotation stop).
  const base = useMemo(() => {
    if (!initial) return RSDP_DEFAULTS;
    // Formats, payouts and the season come back from their own inputs, so one switched off is left out.
    const { bounty: _b, invites: _i, checkIn: _c, payouts: _p, season: _s, gameBetting: _g, ...rest } = initial;
    return rest;
  }, [initial]);
  const [lateReg, setLateReg] = useState(base.lateRegistration);
  const [rebuy, setRebuy] = useState({ ...base.rebuy });
  const [addOn, setAddOn] = useState({ ...base.addOn });
  const [reEntry, setReEntry] = useState(base.reEntry);
  const [registrationApproval, setRegistrationApproval] = useState(base.registrationApproval);
  const [allowQuit, setAllowQuit] = useState(base.allowQuit);
  // A copy of an event made before events had their own table rules never picked any, so it gets the RSDP ones.
  const [tableRules, setTableRules] = useState<TableRules>(() => ({ ...(base.tableRules ?? RSDP_TABLE_RULES) }));
  const [payoutsOn, setPayoutsOn] = useState(initial ? !!initial.payouts : true);
  const [money, setMoney] = useState({ buyIn: 2000, rebuy: 2000, addOn: 2000, feePercent: 0, added: 0, ...initial?.payouts?.money });
  const [payouts, setPayouts] = useState(() => initial?.payouts?.structure ?? payoutPreset('rsdp', 600));
  const [formats, setFormats] = useState<Formats>(() => ({ bounty: initial?.bounty ?? null, invites: initial?.invites ?? null, checkIn: initial?.checkIn ?? null }));
  // '' = not part of a season, 'new' = start one, otherwise an existing season's id.
  // A "new season" choice carried over from a starter or saved structure comes back as one.
  const [seasonPick, setSeasonPick] = useState(initial?.season?.id === '' ? 'new' : '');
  const [seasonName, setSeasonName] = useState(initial?.season?.id === '' ? initial.season.name : '');
  const [mySeasons, setMySeasons] = useState<{ id: string; name: string; events: number }[]>([]);
  useEffect(() => {
    if (!session || tournamentClient() instanceof LocalTournamentClient) return;
    call<{ seasons: typeof mySeasons }>('season:mine', {}).then((r) => {
      setMySeasons(r.seasons);
      // A copy of one of your events joins its season unless you pick otherwise.
      const copied = initial?.season?.id;
      if (copied && r.seasons.some((x) => x.id === copied)) setSeasonPick((p) => p || copied);
    }, () => {});
  }, [session?.playerId]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const firstDay = new Date(`${date}T12:00:00`).getDay() as Weekday;
  const rule: RecurrenceRule | null = useMemo(() => {
    switch (repeat) {
      case 'none':
        return null;
      case 'daily':
        return { freq: 'daily' };
      case 'weekly':
        return { freq: 'weekly', weekdays: weekdays.length ? weekdays : [firstDay] };
      case 'monthly-day':
        return { freq: 'monthly', monthDay: Number(date.slice(8, 10)) };
      case 'monthly-nth':
        return { freq: 'monthly', nth, weekday: firstDay };
    }
  }, [repeat, weekdays, firstDay, date, nth]);
  // A copied series keeps its interval and end date only while its repeat is left as it was.
  const { interval, until } = repeat === first.repeat ? (first.carry as { interval?: number; until?: string }) : {};
  const schedule: Schedule = { timeZone, startDate: date, time, repeat: rule && interval ? { ...rule, interval } : rule, ...(until && rule ? { until } : {}) };
  const scheduleErrors = startKind === 'scheduled' ? validateSchedule(schedule) : [];
  const now = Date.now();
  const startAt = startKind === 'scheduled' && !scheduleErrors.length ? nextOccurrence(schedule, now) : null;
  const preview = startKind === 'scheduled' && !scheduleErrors.length && rule ? upcomingOccurrences(schedule, now, 4) : [];

  const settings: TournamentSettings = {
    ...base,
    name,
    games,
    ...(gameBetting ? { gameBetting } : {}),
    startingStack,
    seatsPerTable,
    maxEntrants,
    structure,
    start:
      startKind === 'scheduled'
        ? { kind: 'scheduled', startAt: startAt ?? NaN, schedule }
        : startKind === 'sng'
          ? { kind: 'sng', ...sng, playersNeeded: Math.min(sng.playersNeeded, maxEntrants) }
          : { kind: 'manual' },
    lateRegistration: lateReg,
    rebuy,
    addOn,
    reEntry,
    registrationApproval,
    allowQuit,
    tableRules,
    ...(formats.bounty ? { bounty: formats.bounty } : {}),
    ...(formats.invites ? { invites: formats.invites } : {}),
    ...(formats.checkIn && startKind !== 'sng' ? { checkIn: formats.checkIn } : {}),
    ...(seasonPick === 'new'
      ? { season: { id: '', name: seasonName.trim() || name } }
      : seasonPick
        ? { season: { id: seasonPick, name: mySeasons.find((s) => s.id === seasonPick)?.name ?? '' } }
        : {}),
    // Presets are built for 600 entries; trim them to this event's size.
    ...(payoutsOn ? { payouts: { structure: payouts.name === 'custom' ? payouts : payoutPreset(payouts.name as PayoutPresetName, maxEntrants), money } } : {}),
  };
  // Without a start time the schedule's own messages say why, so the settings check leaves the start out.
  const checked: TournamentSettings = startKind === 'scheduled' && startAt === null ? { ...settings, start: { kind: 'manual' } } : settings;
  // Stud deals 7 cards each and draw games need cards to draw from, so they seat fewer than 10.
  const levelGames = structure.flatMap((r) => (r.kind === 'level' && r.gameId ? [r.gameId] : []));
  const capping = [...new Set([...games, ...levelGames])].flatMap((id) => VARIANT_LIST.filter((v) => v.id === id)).sort((a, b) => a.maxPlayers - b.maxPlayers)[0];
  const seatCap = capping ? Math.min(10, capping.maxPlayers) : 10;
  const seatError = seatsPerTable > seatCap ? [`${capping!.name} deals to at most ${seatCap} players, so seats per table must be ${seatCap} or fewer`] : [];
  const errors = [
    ...new Set([...seatError, ...scheduleErrors, ...(startKind === 'scheduled' && startAt === null && !scheduleErrors.length ? ['That start time has passed'] : []), ...validateSettings(checked)]),
  ];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (errors.length) return;
    setBusy(true);
    setError('');
    try {
      onCreated(await tournamentClient().create(settings));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const [seatNote, setSeatNote] = useState('');
  const currentMix = mixedGameOf(games.map((gameId, i) => ({ gameId, betting: gameBetting?.[i] ?? getVariant(gameId).defaultBetting })));
  const pickMix = (mix: MixedGame) => {
    setGames(mix.steps.map((st) => st.gameId));
    setGameBetting(mix.steps.map((st) => st.betting));
    const cap = Math.min(10, mixedGameMaxPlayers(mix));
    setSeatNote(seatsPerTable > cap ? `Seats per table lowered to ${cap}: ${mix.name} can't deal to more.` : '');
    if (seatsPerTable > cap) setSeats(cap);
  };
  const toggleGame = (id: string) => {
    setSeatNote('');
    // Picking games one by one goes back to each game's usual betting.
    setGameBetting(undefined);
    const list = [...new Set(games)];
    if (list.includes(id)) return setGames(list.filter((g) => g !== id));
    setGames([...list, id]);
    const spec = getVariant(id);
    const cap = Math.min(seatCap, spec.maxPlayers);
    if (seatsPerTable > cap) {
      setSeats(cap);
      setSeatNote(`Seats per table lowered to ${cap}: ${(spec.maxPlayers === cap ? spec : capping!).name} can't deal to more.`);
    }
  };
  const expectedEntrants = startKind === 'sng' ? sng.playersNeeded : Math.min(maxEntrants, 30);

  if (!session) return <main className="tn-page"><p className="muted">Connecting…</p></main>;

  return (
    <div className="site-page">
      <SiteHeader />
      <main className="tn-page">
        <header className="tn-header">
          <h1>New tournament</h1>
          {note && <p className="muted" role="status">{note}</p>}
        </header>
        <form className="tn-form" onSubmit={submit} noValidate>
          {onLoad && <SavedStructures current={settings} onLoad={onLoad} />}
          <section className="tn-card">
            <h2>Basics</h2>
            <label>
              Name
              <input value={name} maxLength={40} required onChange={(e) => setName(e.target.value)} />
            </label>
            <fieldset className="tn-fieldset">
              <legend>Game{games.length > 1 ? 's (rotate each level)' : ''}</legend>
              <div className="tn-game-groups">
                {GAME_GROUPS.map(([group, list]) => (
                  <div key={group} className="tn-game-group tn-chips">
                    <span>{group}</span>
                    {list.map((g) => (
                      <label key={g.id} className={`tn-chip ${games.includes(g.id) ? 'on' : ''}`}>
                        <input type="checkbox" checked={games.includes(g.id)} onChange={() => toggleGame(g.id)} />
                        {g.name}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              <div className="tn-game-group tn-chips" role="group" aria-label="Mixed games">
                <span>Mixed</span>
                {MIXED_GAMES.map((mix) => (
                  <button
                    type="button"
                    key={mix.id}
                    className={`tn-chip ${currentMix?.id === mix.id ? 'on' : ''}`}
                    aria-pressed={currentMix?.id === mix.id}
                    title={mix.summary}
                    onClick={() => pickMix(mix)}
                  >
                    {mix.name}
                  </button>
                ))}
              </div>
              {currentMix && (
                <p className="muted">
                  {currentMix.name}: {currentMix.summary} The game changes every level. The Limit games bet the big blind, then twice it, unless a level sets its own Limit
                  amounts; only the stud games post the level's ante
                  {structure.some((r) => r.kind === 'level' && r.ante > 0) ? '.' : ', so add antes to the levels below if you want them in Razz and Stud.'}
                </p>
              )}
              {seatNote && <p className="muted" role="status">{seatNote}</p>}
            </fieldset>
            <div className="tn-grid3">
              <label>
                Starting stack
                <input type="number" min={1} value={startingStack} onChange={(e) => setStartingStack(int(e.target.value, 1))} />
              </label>
              <label>
                Seats per table
                <input
                  type="number"
                  min={2}
                  max={seatCap}
                  value={seatsPerTable}
                  onChange={(e) => {
                    setSeats(int(e.target.value, 2));
                    setSeatNote('');
                  }}
                />
              </label>
              <label>
                Max players
                <input type="number" min={2} max={600} value={maxEntrants} onChange={(e) => setMaxEntrants(int(e.target.value, 2))} />
              </label>
            </div>
          </section>

          <section className="tn-card">
            <h2>Start</h2>
            <div className="tn-segment" role="radiogroup">
              {(
                [
                  ['scheduled', 'At a set time'],
                  ['sng', 'Sit & Go'],
                  ['manual', 'When I start it'],
                ] as const
              ).map(([k, label]) => (
                <button type="button" role="radio" aria-checked={startKind === k} key={k} className={startKind === k ? 'on' : ''} onClick={() => setStartKind(k)}>
                  {label}
                </button>
              ))}
            </div>
            {startKind === 'scheduled' && (
              <>
                <div className="tn-grid3">
                  <label>
                    Date
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </label>
                  <label>
                    Time
                    <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                  </label>
                  <label>
                    Time zone
                    <select value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
                      {tzList().map((z) => (
                        <option key={z}>{z}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Repeat
                  <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
                    <option value="none">Does not repeat</option>
                    <option value="daily">Every day</option>
                    <option value="weekly">Every week</option>
                    <option value="monthly-day">Every month on day {Number(date.slice(8, 10)) || '–'}</option>
                    <option value="monthly-nth">Every month on a weekday</option>
                  </select>
                </label>
                {repeat === 'weekly' && (
                  <div className="tn-chips">
                    {WEEKDAYS.map((d, i) => {
                      const on = weekdays.length ? weekdays.includes(i as Weekday) : i === firstDay;
                      return (
                        <label key={d} className={`tn-chip ${on ? 'on' : ''}`}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const cur = weekdays.length ? weekdays : [firstDay];
                              setWeekdays(on ? cur.filter((x) => x !== i) : [...cur, i as Weekday]);
                            }}
                          />
                          {d}
                        </label>
                      );
                    })}
                  </div>
                )}
                {repeat === 'monthly-nth' && (
                  <label>
                    Which {WEEKDAYS[firstDay]}
                    <select value={nth} onChange={(e) => setNth(Number(e.target.value) as typeof nth)}>
                      {NTH.map((n) => (
                        <option key={n.v} value={n.v}>
                          {n.label} {WEEKDAYS[firstDay]} of the month
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {startAt !== null && (
                  <p className="tn-note">
                    Starts on its own at <b>{localTime(startAt)}</b> your time. Seats are drawn a minute before; no one has to press start.
                  </p>
                )}
                {preview.length > 1 && <p className="muted">Next: {preview.slice(1).map(localTime).join(' · ')}</p>}
              </>
            )}
            {startKind === 'sng' && (
              <div className="tn-grid3">
                <label>
                  Players needed
                  <input type="number" min={2} max={maxEntrants} value={sng.playersNeeded} onChange={(e) => setSng({ ...sng, playersNeeded: int(e.target.value, 2) })} />
                </label>
                <label>
                  Delay before the first hand (s)
                  <input type="number" min={0} max={900} step={30} value={sng.startDelaySeconds} onChange={(e) => setSng({ ...sng, startDelaySeconds: int(e.target.value) })} />
                </label>
                <label className="tn-check">
                  <input type="checkbox" checked={sng.autoSpawn} onChange={(e) => setSng({ ...sng, autoSpawn: e.target.checked })} />
                  Open a new one when this one fills
                </label>
              </div>
            )}
          </section>

          <section className="tn-card">
            <h2>Blind levels</h2>
            <StructureEditor rows={structure} onChange={setStructure} startingStack={startingStack} expectedEntrants={expectedEntrants} maxRebuys={rebuy.max} showGames={games.length > 1} rotation={settings} />
          </section>

          <section className="tn-card">
            <h2>At the tables</h2>
            <TableRulesFields rules={tableRules} onChange={setTableRules} />
          </section>

          <section className="tn-card">
            <h2>Entries</h2>
            <label className="tn-check">
              <input type="checkbox" checked={registrationApproval} onChange={(e) => setRegistrationApproval(e.target.checked)} />I approve each registration
            </label>
            <div className="tn-option">
              <label className="tn-check">
                <input type="checkbox" checked={lateReg.enabled} onChange={(e) => setLateReg({ ...lateReg, enabled: e.target.checked })} />
                Late registration
              </label>
              {lateReg.enabled && (
                <label className="tn-inline">
                  through level
                  <input type="number" min={1} placeholder="end" value={lateReg.throughLevel ?? ''} onChange={(e) => setLateReg({ ...lateReg, throughLevel: e.target.value ? int(e.target.value, 1) : null })} />
                </label>
              )}
            </div>
            <div className="tn-option">
              <label className="tn-check">
                <input type="checkbox" checked={rebuy.max > 0} onChange={(e) => {
                    setRebuy({ ...rebuy, max: e.target.checked ? 1 : 0, chips: rebuy.chips || startingStack });
                    // Rebuys need at least one rebuy level: default to the first four.
                    if (e.target.checked && !structure.some((r) => r.kind === 'level' && r.rebuy)) {
                      let n = 0;
                      setStructure(structure.map((r) => (r.kind === 'level' && n++ < 4 ? { ...r, rebuy: true } : r)));
                    }
                  }} />
                Rebuys (on levels marked Rebuys)
              </label>
              {rebuy.max > 0 && (
                <div className="tn-grid3">
                  <label>
                    Max per player
                    <input type="number" min={1} max={MAX_BUYS_PER_PLAYER} value={rebuy.max} onChange={(e) => setRebuy({ ...rebuy, max: int(e.target.value, 1) })} />
                  </label>
                  <label>
                    Chips
                    <input type="number" min={1} value={rebuy.chips} onChange={(e) => setRebuy({ ...rebuy, chips: int(e.target.value, 1) })} />
                  </label>
                  <label>
                    Offer lasts (s)
                    <input type="number" min={1} max={300} value={rebuy.offerSeconds} onChange={(e) => setRebuy({ ...rebuy, offerSeconds: int(e.target.value, 1) })} />
                  </label>
                  <label className="tn-check">
                    <input type="checkbox" checked={rebuy.approval} onChange={(e) => setRebuy({ ...rebuy, approval: e.target.checked })} />I approve rebuys
                  </label>
                </div>
              )}
            </div>
            <div className="tn-option">
              <label className="tn-check">
                <input type="checkbox" checked={addOn.max > 0} onChange={(e) => {
                    setAddOn({ ...addOn, max: e.target.checked ? 1 : 0, chips: addOn.chips || startingStack });
                    // Add-ons need a break that offers them: default to the first break, or add one after level 4 (RSDP has none).
                    const first = structure.findIndex((r) => r.kind === 'break');
                    if (e.target.checked && !structure.some((r) => r.kind === 'break' && r.addOn)) {
                      if (first >= 0) setStructure(structure.map((r, i) => (i === first ? { ...r, addOn: true } : r)));
                      else {
                        const at = Math.max(1, Math.min(4, structure.length - 1));
                        const added: StructureRow = { kind: 'break', minutes: 5, addOn: true };
                        addOnBreak.current = added;
                        setStructure([...structure.slice(0, at), added, ...structure.slice(at)]);
                      }
                    } else if (!e.target.checked && addOnBreak.current && structure.includes(addOnBreak.current)) {
                      // Unticked again: the break it added goes too, unless the host has changed it since.
                      const added = addOnBreak.current;
                      setStructure(structure.filter((r) => r !== added));
                    }
                    if (!e.target.checked) addOnBreak.current = null;
                  }} />
                Add-ons (on breaks marked Add-ons)
              </label>
              {addOn.max > 0 && (
                <div className="tn-grid3">
                  <label>
                    Max per player
                    <input type="number" min={1} max={MAX_BUYS_PER_PLAYER} value={addOn.max} onChange={(e) => setAddOn({ ...addOn, max: int(e.target.value, 1) })} />
                  </label>
                  <label>
                    Chips
                    <input type="number" min={1} value={addOn.chips} onChange={(e) => setAddOn({ ...addOn, chips: int(e.target.value, 1) })} />
                  </label>
                  <label className="tn-check">
                    <input type="checkbox" checked={addOn.approval} onChange={(e) => setAddOn({ ...addOn, approval: e.target.checked })} />I approve add-ons
                  </label>
                </div>
              )}
            </div>
            <div className="tn-option">
              <label className="tn-check">
                <input type="checkbox" checked={reEntry.enabled} onChange={(e) => setReEntry({ ...reEntry, enabled: e.target.checked })} />
                Re-entry after busting
              </label>
              {reEntry.enabled && (
                <div className="tn-grid3">
                  <label>
                    Through level
                    <input type="number" min={1} placeholder="end" value={reEntry.throughLevel ?? ''} onChange={(e) => setReEntry({ ...reEntry, throughLevel: e.target.value ? int(e.target.value, 1) : null })} />
                  </label>
                  <label>
                    Max re-entries
                    <input type="number" min={1} placeholder="no limit" value={reEntry.max ?? ''} onChange={(e) => setReEntry({ ...reEntry, max: e.target.value ? int(e.target.value, 1) : null })} />
                  </label>
                  <label className="tn-check">
                    <input type="checkbox" checked={reEntry.approval} onChange={(e) => setReEntry({ ...reEntry, approval: e.target.checked })} />I approve re-entries
                  </label>
                </div>
              )}
            </div>
            <label className="tn-check">
              <input type="checkbox" checked={allowQuit} onChange={(e) => setAllowQuit(e.target.checked)} />
              Players may leave for good before busting
            </label>
          </section>

          <section className="tn-card">
            <h2>Bounties, invites and check-in</h2>
            <FormatsEditor value={formats} onChange={setFormats} scheduled={startKind === 'scheduled'} sng={startKind === 'sng'} />
            {/* Seasons live on the server; a ?demo tournament has none. */}
            {!(tournamentClient() instanceof LocalTournamentClient) && <div className="tn-option">
              <label>
                Season leaderboard
                <select value={seasonPick} onChange={(e) => setSeasonPick(e.target.value)}>
                  <option value="">Not part of a season</option>
                  <option value="new">Start a new season</option>
                  {mySeasons.map((s) => (
                    <option key={s.id} value={s.id}>
                      Add to {s.name} ({s.events} {s.events === 1 ? 'event' : 'events'})
                    </option>
                  ))}
                </select>
              </label>
              {seasonPick === 'new' && (
                <label>
                  Season name
                  <input value={seasonName} maxLength={40} placeholder={name} onChange={(e) => setSeasonName(e.target.value)} />
                </label>
              )}
              {seasonPick !== '' && (
                <p className="muted">
                  Finished events in a season add up on one leaderboard: points, wins, cashes{formats.bounty ? ', knockouts' : ''} and display-only net.
                  {repeat !== 'none' && startKind === 'scheduled' ? ' Every event in this series joins the season.' : ''}
                </p>
              )}
            </div>}
          </section>

          <section className="tn-card">
            <h2>Prizes</h2>
            <label className="tn-check">
              <input type="checkbox" checked={payoutsOn} onChange={(e) => setPayoutsOn(e.target.checked)} />
              Show a prize pool and payouts (for display only; money is settled outside the app)
            </label>
            {payoutsOn && (
              <>
                <div className="tn-grid3">
                  <label>
                    Buy-in ($)
                    <input type="number" min={0} step="any" value={money.buyIn / 100} onChange={(e) => setMoney({ ...money, buyIn: Math.round(Number(e.target.value) * 100) })} />
                  </label>
                  {rebuy.max > 0 && (
                    <label>
                      Rebuy ($)
                      <input type="number" min={0} step="any" value={money.rebuy / 100} onChange={(e) => setMoney({ ...money, rebuy: Math.round(Number(e.target.value) * 100) })} />
                    </label>
                  )}
                  {addOn.max > 0 && (
                    <label>
                      Add-on ($)
                      <input type="number" min={0} step="any" value={money.addOn / 100} onChange={(e) => setMoney({ ...money, addOn: Math.round(Number(e.target.value) * 100) })} />
                    </label>
                  )}
                </div>
                <PayoutEditor value={payouts} onChange={setPayouts} maxEntrants={maxEntrants} pool={money.buyIn * Math.min(maxEntrants, 20)} reEntry={reEntry.enabled} />
              </>
            )}
          </section>

          {errors.length > 0 && (
            <div className="tn-card tn-errors">
              {errors.map((e) => (
                <p className="error" key={e}>
                  {e}
                </p>
              ))}
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <div className="tn-submit">
            <button className="primary big" disabled={busy || errors.length > 0}>
              Create tournament
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
