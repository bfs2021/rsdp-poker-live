import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSocket = vi.hoisted(() => ({ connected: false, emit: (..._: unknown[]) => {} }));
vi.mock('./socket', () => ({ socket: mockSocket }));
const { contributeSeed, liveRecordFor, liveSeedProblem, proofSeeds, recordSeedProblem, seedListPassed, seedListProblem, seedProblem, shownAs, watchCommitments, watchNextSeen } = await import('./fair');

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
});

const C = 'commit';
const sent = (s: object) => store.set('rsdp.fairSent', JSON.stringify({ [C]: JSON.stringify(s) }));
const accepted = (seed: string) => store.set('rsdp.fairSeeds', JSON.stringify({ [C]: seed }));
const listed = (seed?: string) => (seed ? [{ playerId: 'me', seed }] : []);

describe('the seed under my name', () => {
  it('is fine when it is the one the server accepted', () => {
    sent({ seed: 'aa', at: 0 });
    accepted('aa');
    expect(seedProblem(C, listed('aa'), 'me', true, 10_000)).toBeNull();
  });

  it('warns about a seed this browser never sent', () => {
    sent({ seed: 'aa', at: 0 });
    accepted('aa');
    expect(seedProblem(C, listed('bb'), 'me', true, 10_000)).toMatch(/didn't send/);
    expect(seedProblem(C, listed('bb'), 'me', false, 10_000)).toMatch(/didn't send/);
  });

  it('says a seed from your other device is harmless, and still warns (#209)', () => {
    // The same browser storage can't tell your phone's seed from one a server made up, so it still warns, but says which is which.
    sent({ seed: 'aa', at: 0 });
    accepted('aa');
    const problem = seedProblem(C, listed('bb'), 'me', true, 10_000)!;
    expect(problem).toMatch(/another device .* that's expected and you can ignore it/);
    expect(problem).toMatch(/If you aren't, the deck may have been steered/);
  });

  it('warns when an accepted seed, or one sent in good time, is left out', () => {
    sent({ seed: 'aa', at: 0, table: 't1' });
    accepted('aa');
    expect(seedProblem(C, listed(), 'me', true, 10_000)).toMatch(/dealt without it/);
    store.delete('rsdp.fairSeeds');
    // No answer at all, then dealt 10 s later.
    expect(seedProblem(C, listed(), 'me', true, 10_000)).toMatch(/dealt without it/);
    // Sent just before the deal: it could honestly miss.
    store.set('rsdp.fairNextSeen', JSON.stringify({ [`t1#${C}`]: '-5000' }));
    expect(seedProblem(C, listed(), 'me', true, 1_000)).toBeNull();
    // Not dealt in: nothing to say.
    expect(seedProblem(C, listed(), 'me', false, 10_000)).toBeNull();
  });

  it('catches a server that turns seeds down and then picks which to use', () => {
    sent({ seed: 'aa', at: 0, table: 't1', rejected: { after: 50 } });
    expect(seedProblem(C, listed('aa'), 'me', true, 10_000)).toMatch(/turned down .* but used it/);
    // Refused at once, whatever the reason given, yet the hand came seconds later: the seed was there in time.
    expect(seedProblem(C, listed(), 'me', true, 10_000)).toMatch(/dealt without it/);
    // Refused because the hand had just been dealt: this browser sees that hand right away.
    store.set('rsdp.fairNextSeen', JSON.stringify({ [`t1#${C}`]: '-5000' }));
    expect(seedProblem(C, listed(), 'me', true, 400)).toBeNull();
    expect(seedProblem(C, listed(), 'me', true, -200)).toBeNull();
  });

  it('catches a commitment shown only at the last moment, so every seed is late', () => {
    store.set('rsdp.fairNextSeen', JSON.stringify({ [`t1#${C}`]: '0' }));
    sent({ seed: 'aa', at: 0, table: 't1', rejected: { after: 50 } });
    expect(seedProblem(C, listed(), 'me', true, 1_000)).toMatch(/too soon/);
    expect(seedProblem(C, listed('aa'), 'me', true, 1_000)).toMatch(/but used it/);
  });
});

describe('a commitment swapped before the deal', () => {
  type V = Parameters<ReturnType<typeof watchCommitments>>[0];
  /** A table view: the next commitment offered, and the hand shown as [handNumber, commitment]. */
  const view = (next: string | null, hand: [number, string | null] | null, o: { table?: string; delay?: number | null; blocked?: boolean } = {}) =>
    ({
      id: o.table ?? 't1',
      me: { seat: o.delay == null ? 2 : null, playerId: 'me' },
      spectator: o.delay == null ? null : { delaySeconds: o.delay, seeAll: false, blocked: !!o.blocked },
      fair: next === null ? undefined : { nextCommit: next, handCommit: hand?.[1] ?? null },
      // A blocked spectator sees no hand at all.
      hand: hand && !o.blocked ? { handNumber: hand[0], phase: 'betting', names: { 2: 'me' }, ...(hand[1] ? { fair: { commit: hand[1], clientSeeds: [] } } : {}) } : null,
    }) as unknown as V;
  const quiet = (...commits: string[]) => {
    for (const c of commits) expect(seedProblem(c, listed(), 'me', false, 10_000), c).toBeNull();
  };
  const flagged = (c: string, re = /never dealt from/) => expect(seedProblem(c, listed(), 'me', false, 10_000), c).toMatch(re);
  let sock: string | undefined = 's1';
  beforeEach(() => {
    sock = 's1';
  });

  it('is quiet when every commitment is dealt from, in order', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z'])); // joined after hand 7 (from a commitment offered before I looked)
    watch(view('A', null));
    watch(view('B', [8, 'A']));
    watch(view('B', [8, 'A']));
    watch(view(null, [8, 'A'])); // a view with no commitment changes nothing
    watch(view('C', [9, 'B']));
    quiet('Z', 'A', 'B', 'C');
  });

  it('warns about the hand dealt after a commitment that was replaced without a deal', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('A2', [7, 'Z']));
    quiet('A2');
    watch(view('B', [8, 'A2']));
    flagged('A2');
    // Everything after it in the same watch is marked too.
    watch(view('C', [9, 'B']));
    flagged('B');
  });

  it('is not fooled by a summary field, a blank commitment or a moment as a seated-looking spectator', () => {
    let watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    // A view claiming hand A was dealt, while the hand shown is still hand 7.
    watch({ ...view('A2', [7, 'Z']), fair: { nextCommit: 'A2', handCommit: 'A' } } as unknown as V);
    watch(view('B', [8, 'A2']));
    flagged('A2');
    store.clear();
    watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view(null, [7, 'Z']));
    watch({ ...view('', [7, 'Z']) } as V);
    watch(view('A2', [7, 'Z']));
    watch(view('B', [8, 'A2']));
    flagged('A2');
    store.clear();
    watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('A2', [7, 'Z'], { delay: 0 })); // stood up, live spectator: still watching
    watch(view('B', [8, 'A2']));
    flagged('A2');
  });

  it('warns about a hand from a commitment never offered, and a hand number dealt twice', () => {
    let watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('B', [8, 'X']));
    flagged('X', /never showed as the next hand's/);
    store.clear();
    watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('B', [8, 'A']));
    watch(view('C', [8, 'B'])); // hand 8 shown again, from another commitment
    flagged('B', /shown again from a different commitment/);
  });

  it('marks the hands after one shown without its commitment', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('A', [8, null]));
    watch(view('B', [9, 'A']));
    flagged('A', /shown without its commitment/);
  });

  it('lets a hand from before provably fair dealing finish quietly when it is the one in play on arrival', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, null]));
    watch(view('A', [7, null]));
    watch(view('A', [7, null]));
    watch(view('B', [8, 'A']));
    quiet('A');
  });

  it('never lets a second commitment for a hand number replace the first, across a reconnect too', () => {
    let watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('B', [8, 'A']));
    sock = 's2'; // forced reconnect, then hand 8 again from another commitment
    watch = watchCommitments(() => sock);
    watch(view('C', [8, 'A2']));
    // Kept for Check this hand, which compares the record with it; not a live alarm, as a crash that lost a save looks the same.
    expect(shownAs('t1', 8)).toBe('A');
    quiet('A2');
  });

  it('writes nothing from views that hide or delay the hands', () => {
    const watch = watchCommitments(() => sock);
    watch(view('B', [8, 'A'], { delay: 30 }));
    watch(view('C', [9, 'B'], { delay: 0, blocked: true }));
    expect(shownAs('t1', 8)).toBeNull();
    expect(shownAs('t1', 9)).toBeNull();
  });

  it('remembers which commitment each hand number was shown under, for Check this hand', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('B', [8, 'A']));
    expect(shownAs('t1', 8)).toBe('A');
    expect(shownAs('t1', 9)).toBeNull();
    expect(shownAs('t2', 8)).toBeNull();
    watch(view('B', [9, null]));
    expect(shownAs('t1', 9)).toBe('none');
  });

  it('starts over when hands were hidden: watching turned off, then a seat', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', null, { delay: 0, blocked: true }));
    watch(view('B', [7, 'A'], { delay: 0, blocked: true }));
    watch(view('C', [8, 'B'], { delay: 0, blocked: true }));
    watch(view('D', [9, 'C'])); // sat down: the first hand seen is from C
    watch(view('E', [10, 'D']));
    quiet('C', 'D');
  });

  it('starts over after a reconnect, a new page, another table, or a delayed view turning live', () => {
    let watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    sock = 's2'; // the server restarted: a fresh commitment is honest
    watch(view('A2', [7, 'Z']));
    watch(view('B', [8, 'A2']));
    watch = watchCommitments(() => sock); // page left and opened again
    watch(view('A3', [8, 'A2']));
    watch(view('X', [3, 'W'], { table: 't2' }));
    watch(view('A4', [8, 'A2']));
    watch(view('B4', [9, 'A4']));
    // A delayed spectator sees hands late; sitting down, the live hand is newer.
    watch(view('C4', [9, 'A4'], { delay: 30 }));
    watch(view('D4', [10, 'C4'], { delay: 30 }));
    watch(view('E4', [11, 'D4']));
    sock = undefined; // offline: nothing to compare
    watch(view('F4', [11, 'D4']));
    sock = 's3';
    watch(view('G4', [12, 'F4']));
    quiet('A2', 'A3', 'X', 'A4', 'B4', 'C4', 'D4', 'E4', 'F4', 'G4');
  });
});

describe('when this browser saw the next commitment appear', () => {
  type V = Parameters<ReturnType<typeof watchNextSeen>>[0];
  const view = (next: string, table = 't1') => ({ id: table, fair: { nextCommit: next, handCommit: null } }) as unknown as V;
  let t = 0;
  let sock: string | undefined = 's1';
  let tick = () => {};
  const seen = () =>
    watchNextSeen(
      () => sock,
      () => t,
      (fn) => {
        tick = fn;
        return () => (tick = () => {});
      },
    );
  // Time passing while the page runs normally: its heartbeat ticks every 250 ms.
  const run = (to: number) => {
    while (t < to) {
      t = Math.min(to, t + 250);
      tick();
    }
  };
  // My seed for commitment C went out at `sentAt` at table t1, the server turned it down (the hand was already dealt),
  // and the hand from C came without it at `dealtAt`.
  const lateSeed = (sentAt: number, table: string | null = 't1') =>
    store.set('rsdp.fairSent', JSON.stringify({ C: JSON.stringify({ seed: 'aa', at: sentAt, table, rejected: { after: 80 } }) }));
  const problem = (dealtAt: number) => seedProblem('C', [], 'me', true, dealtAt);
  beforeEach(() => {
    t = 0;
    sock = 's1';
  });

  it('catches a server that shows a commitment at the last moment to a browser already watching', () => {
    const watch = seen();
    run(1_000);
    watch(view('B'));
    run(20_000);
    watch(view('C')); // appears...
    lateSeed(20_000);
    expect(problem(20_400)).toMatch(/too soon/); // ...and is dealt 0.4 s later
    // After an honest 2.5 s lead the deal isn't too soon (dropping a seed sent that early is caught another way).
    expect(problem(22_600)).not.toMatch(/too soon/);
  });

  it('says nothing when the commitment was already up as this page arrived, reconnected or sat down', () => {
    // Arrived (or reconnected after a restart) with C already up; the deal followed at once, before my seed got there.
    let watch = seen();
    run(20_000);
    watch(view('C'));
    lateSeed(20_000);
    expect(problem(20_100)).toBeNull();
    // Same after a reconnect on a page that was already watching: the new connection can't tell how long C was up.
    store.clear();
    watch = seen();
    watch(view('B'));
    sock = 's2';
    run(30_000);
    watch(view('C'));
    lateSeed(30_000);
    expect(problem(30_100)).toBeNull();
    // Watching as a spectator counts: C appeared 10 s before I sat down, just before the host started.
    store.clear();
    sock = 's1';
    watch = seen();
    run(40_000);
    watch(view('B'));
    run(41_000);
    watch(view('C'));
    run(51_000);
    lateSeed(51_000);
    expect(problem(51_100)).toBeNull();
    // Offline (no socket id) notes nothing.
    store.clear();
    watch = seen();
    watch(view('B'));
    sock = undefined;
    run(60_000);
    watch(view('C'));
    sock = 's1';
    lateSeed(60_000);
    expect(problem(60_100)).toBeNull();
  });

  it('says nothing after the page itself stalled and its views arrive in a bunch', () => {
    const watch = seen();
    run(1_000);
    watch(view('B'));
    // The tab froze for 8 s (an app switch on a phone): no heartbeat. C appeared and was dealt meanwhile; the backlog
    // arrives at once on waking.
    t = 9_000;
    watch(view('C'));
    lateSeed(9_000);
    expect(problem(9_010)).toBeNull();
    // Waking by the heartbeat first is the same.
    run(10_000);
    watch(view('D'));
    t = 20_000;
    tick();
    watch(view('E'));
    // Once running again the watch picks up.
    run(21_000);
    watch(view('F'));
    expect(Object.keys(JSON.parse(store.get('rsdp.fairNextSeen')!))).toEqual(['t1#D', 't1#F']);
  });

  it('notes only the first appearance, per table, and keeps going through views with no commitment', () => {
    const watch = seen();
    run(1_000);
    watch(view('B'));
    run(2_000);
    watch({ id: 't1' } as unknown as V); // a view without a commitment changes nothing
    run(3_000);
    watch(view('C'));
    run(9_000);
    watch(view('C'));
    expect(JSON.parse(store.get('rsdp.fairNextSeen')!)).toEqual({ 't1#C': '3000' });
  });

  it("won't take another table's timing for this one's", () => {
    // A server shows C early as another table's next commitment, in a tab only watching that table...
    const other = seen();
    run(1_000);
    other(view('B', 't2'));
    run(2_000);
    other(view('C', 't2'));
    // ...and at my table only at the last moment, leaving my seed out.
    const watch = seen();
    watch(view('B'));
    run(30_000);
    watch(view('C'));
    lateSeed(30_000);
    expect(problem(30_300)).toMatch(/too soon/);
    // A seed record from before tables were noted can't be matched to a table, so it stays quiet.
    lateSeed(30_000, null);
    expect(problem(30_300)).toBeNull();
  });

  it('no longer notes the commitment just for being seated (the old false alarm)', () => {
    contributeSeed({ id: 't1', fair: { nextCommit: 'C', handCommit: null }, me: { seat: 2, playerId: 'me' }, hand: null } as unknown as V);
    expect(store.get('rsdp.fairNextSeen')).toBeUndefined();
  });
});

describe('sending my seed', () => {
  type V = Parameters<typeof contributeSeed>[0];
  const seated = (next: string) => ({ id: 't1', fair: { nextCommit: next, handCommit: null }, me: { seat: 2, playerId: 'me' }, hand: null }) as unknown as V;
  const emitted: { commit: string; seed: string }[] = [];
  beforeEach(() => {
    emitted.length = 0;
    mockSocket.connected = true;
    mockSocket.emit = (_event: unknown, payload: unknown) => void emitted.push(payload as { commit: string; seed: string });
  });
  afterEach(() => {
    mockSocket.connected = false;
  });

  it('sends one seed per commitment, and repeats another tab\'s rather than making a second', () => {
    contributeSeed(seated('T1'));
    contributeSeed(seated('T1'));
    expect(emitted.map((e) => e.commit)).toEqual(['T1']);
    // Another tab of this browser (same storage), or this page before a reload, made 'aa' for T2: send that again,
    // so the server keeps it whether or not the first got there.
    store.set('rsdp.fairSent', JSON.stringify({ T2: JSON.stringify({ seed: 'aa', at: 0, table: 't1', player: 'me' }) }));
    contributeSeed(seated('T2'));
    expect(emitted.at(-1)).toEqual({ commit: 'T2', seed: 'aa' });
    expect(seedProblem('T2', [{ playerId: 'me', seed: 'aa' }], 'me', true, 10_000)).toBeNull();
  });

  it("doesn't repeat a refused seed, nor another player's", () => {
    store.set('rsdp.fairSent', JSON.stringify({ T3: JSON.stringify({ seed: 'aa', at: 0, table: 't1', player: 'me', rejected: { after: 9 } }) }));
    contributeSeed(seated('T3'));
    expect(emitted).toEqual([]);
    // Signed in as someone else in another tab: that seed isn't mine to repeat.
    store.set('rsdp.fairSent', JSON.stringify({ T4: JSON.stringify({ seed: 'bb', at: 0, table: 't1', player: 'other' }) }));
    contributeSeed(seated('T4'));
    expect(emitted.map((e) => e.commit)).toEqual(['T4']);
    expect(emitted[0].seed).not.toBe('bb');
  });

  it('a repeat turned down is no sign of a cheat, and two tabs that each made a seed at once are both mine', () => {
    mockSocket.emit = (_e: unknown, payload: unknown, ack?: unknown) => {
      emitted.push(payload as { commit: string; seed: string });
      (ack as (r: { ok: boolean }) => void)({ ok: false });
    };
    store.set('rsdp.fairSent', JSON.stringify({ T5: JSON.stringify({ seed: 'aa', at: 0, table: 't1', player: 'me' }) }));
    contributeSeed(seated('T5'));
    // The first got there and was used; the repeat came after the deal and was turned down.
    expect(seedProblem('T5', [{ playerId: 'me', seed: 'aa' }], 'me', true, 10_000)).toBeNull();
    // Two tabs raced: both made a seed, the other tab's write won here, the server kept mine.
    mockSocket.emit = (_e: unknown, payload: unknown) => void emitted.push(payload as { commit: string; seed: string });
    contributeSeed(seated('T6'));
    const mine = emitted.at(-1)!.seed;
    store.set('rsdp.fairSent', JSON.stringify({ T6: JSON.stringify({ seed: 'cc', at: 0, table: 't1', player: 'me' }) }));
    expect(seedProblem('T6', [{ playerId: 'me', seed: mine }], 'me', true, 10_000)).toBeNull();
    expect(seedProblem('T6', [{ playerId: 'me', seed: 'dd' }], 'me', true, 10_000)).toMatch(/didn't send/);
  });

  it("a seed refused in one tab but accepted from another is fine, and a repeat keeps the first send's time", () => {
    // Tab 2 repeated X and got in; tab 1's own copy arrived after the deal and was refused.
    store.set('rsdp.fairSent', JSON.stringify({ T7: JSON.stringify({ seed: 'aa', at: 0, table: 't1', player: 'me', rejected: { after: 3000 } }) }));
    store.set('rsdp.fairSeeds', JSON.stringify({ T7: 'aa' }));
    expect(seedProblem('T7', [{ playerId: 'me', seed: 'aa' }], 'me', true, 10_000)).toBeNull();
    // Refused everywhere and used anyway is still caught.
    store.delete('rsdp.fairSeeds');
    expect(seedProblem('T7', [{ playerId: 'me', seed: 'aa' }], 'me', true, 10_000)).toMatch(/but used it/);
    // A repeat seen late (the server picks when a second tab sees the commitment) can't make an early seed look late.
    store.set('rsdp.fairSent', JSON.stringify({ T8: JSON.stringify({ seed: 'bb', at: 1, table: 't1', player: 'me' }) }));
    contributeSeed(seated('T8'));
    expect(JSON.parse(JSON.parse(store.get('rsdp.fairSent')!).T8).at).toBe(1);
    expect(seedProblem('T8', [], 'me', true, 10_000)).toMatch(/in good time/);
  });

  it('takes a record from before players were noted as mine', () => {
    store.set('rsdp.fairSent', JSON.stringify({ T9: JSON.stringify({ seed: 'aa', at: 0, table: 't1' }) }));
    contributeSeed(seated('T9'));
    expect(emitted).toEqual([{ commit: 'T9', seed: 'aa' }]);
    store.set('rsdp.fairSent', JSON.stringify({ T10: JSON.stringify({ seed: 'aa', at: 0, rejected: { after: 5 } }) }));
    contributeSeed(seated('T10'));
    expect(emitted).toHaveLength(1);
  });
});

describe('seeds that nobody checks', () => {
  it('catches my own seed listed more than once: each copy changes the deck', () => {
    sent({ seed: 'aa', at: 0, table: 't1', player: 'me' });
    accepted('aa');
    expect(seedProblem(C, listed('aa'), 'me', true, 10_000)).toBeNull();
    expect(seedProblem(C, [...listed('aa'), ...listed('aa')], 'me', true, 10_000)).toMatch(/^2 seeds were listed under your name \(aa, aa\).*one seed per player.*steer/);
    expect(seedProblem(C, [1, 2, 3, 4, 5].flatMap(() => listed('aa')), 'me', true, 10_000)).toMatch(/^5 seeds/);
    // Mine plus one the server chose after seeing all the others, in either order.
    expect(seedProblem(C, [...listed('aa'), ...listed('ff')], 'me', true, 10_000)).toMatch(/^2 seeds were listed under your name \(aa, ff\).*steer/);
    expect(seedProblem(C, [...listed('ff'), ...listed('aa')], 'me', true, 10_000)).toMatch(/^2 seeds were listed under your name \(ff, aa\).*steer/);
    expect(seedProblem(C, [{ playerId: 'other', seed: 'ff' }, ...listed('aa')], 'me', true, 10_000)).toBeNull();
  });

  it('is quiet about an honest list: one seed each, from people dealt in', () => {
    const honest = [
      { playerId: 'me', seed: 'aa' },
      { playerId: 'p2', seed: 'bb' },
    ];
    expect(seedListProblem(honest, { bots: ['bot-1'], dealt: ['me', 'p2', 'bot-1', 'p3'] })).toBeNull();
    expect(seedListProblem(honest, { bots: [] })).toBeNull();
    expect(seedListProblem([], { bots: [], dealt: [] })).toBeNull();
  });

  it('catches a seed listed for a bot, for someone not dealt in, twice for one player, or one seed listed twice', () => {
    const dealt = ['me', 'p2', 'bot-1'];
    const bots = ['bot-1'];
    expect(seedListProblem([{ playerId: 'me', seed: 'aa' }, { playerId: 'bot-1', seed: 'ff' }], { bots, dealt })).toMatch(/\(ff\).*practice bot/);
    expect(seedListProblem([{ playerId: 'me', seed: 'aa' }, { playerId: 'ghost', seed: 'ff' }], { bots, dealt })).toMatch(/\(ff\).*wasn't dealt in/);
    expect(seedListProblem([{ playerId: 'p2', seed: 'bb' }, { playerId: 'p2', seed: 'ff' }], { bots, dealt })).toMatch(/more than one seed.*same player/);
    // My seed copied under another person's name: their browser would warn, but only if they look.
    expect(seedListProblem([{ playerId: 'me', seed: 'aa' }, { playerId: 'p2', seed: 'aa' }], { bots, dealt })).toMatch(/same seed \(aa\) was listed twice/);
  });

  it('warns at the table about a seed listed for a bot, or one seed listed twice', () => {
    sent({ seed: 'aa', at: 0, table: 't1', player: 'me' });
    accepted('aa');
    const view = (clientSeeds: { playerId: string; seed: string }[]) =>
      ({
        id: 't1',
        me: { playerId: 'me', seat: 0 },
        seats: [{ seat: 0, playerId: 'me' }, { seat: 1, playerId: 'bot-1', bot: { ownerId: 'me', ownerName: 'Me', look: 0 } }, null],
        hand: { names: { 0: 'Me', 1: 'Bot' }, fair: { commit: C, clientSeeds } },
      }) as unknown as Parameters<typeof liveSeedProblem>[0];
    store.set('rsdp.fairLive', JSON.stringify({ [C]: JSON.stringify({ at: 10_000, button: 0, seats: [0, 1], board: [], cards: {} }) }));
    expect(liveSeedProblem(view([{ playerId: 'me', seed: 'aa' }]))).toBeNull();
    expect(liveSeedProblem(view([{ playerId: 'me', seed: 'aa' }, { playerId: 'bot-1', seed: 'ff' }]))).toMatch(/\(ff\).*practice bot/);
    expect(liveSeedProblem(view([{ playerId: 'me', seed: 'aa' }, { playerId: 'p9', seed: 'aa' }]))).toMatch(/same seed \(aa\)/);
  });

  it('notes who was dealt in and who is a bot, so "Check this hand" need not take the record\'s word for it', () => {
    type V = Parameters<typeof contributeSeed>[0];
    const bot = { ownerId: 'me', ownerName: 'Me', look: 0 };
    const seat = (n: number, playerId: string, inHand: boolean, isBot = false) => ({ seat: n, playerId, inHand, cards: [], ...(isBot ? { bot } : {}) });
    const view = (seats: unknown[]) =>
      ({ id: 't1', fair: { nextCommit: null }, me: { playerId: 'me', seat: 0 }, seats, hand: { button: 0, boards: [], names: { 0: 'Me', 1: 'Bot', 2: 'P2' }, fair: { commit: C, clientSeeds: [] } } }) as unknown as V;
    contributeSeed(view([seat(0, 'me', true), seat(1, 'bot-1', true, true), seat(2, 'p2', true), seat(3, 'late', false)]));
    // Someone taking a seat later, or the bot leaving mid-hand, doesn't change what was noted.
    contributeSeed(view([seat(0, 'me', true), null, seat(2, 'p2', true), seat(3, 'late', false)]));
    const live = liveRecordFor(C)!;
    expect(live.players).toEqual({ 0: 'me', 1: 'bot-1', 2: 'p2' });
    expect(live.bots).toEqual(['bot-1']);

    const record = [
      { seat: 0, playerId: 'me' },
      { seat: 1, playerId: 'bot-1', bot: { ownerName: 'Me', look: 0 } },
      { seat: 2, playerId: 'p2' },
    ];
    const seeds = [
      { playerId: 'me', seed: 'aa' },
      { playerId: 'p2', seed: 'bb' },
    ];
    expect(recordSeedProblem(seeds, record, live)).toBeNull();
    // The record drops the bot mark to pass off a seed of its own as the bot's.
    const unmarked = record.map((x) => ({ seat: x.seat, playerId: x.playerId }));
    expect(recordSeedProblem([...seeds, { playerId: 'bot-1', seed: 'ff' }], unmarked, live)).toMatch(/\(ff\).*practice bot/);
    // Or lists someone else in a seat, or a seat nobody was dealt in, to make room for a seed nobody checks.
    expect(recordSeedProblem([...seeds, { playerId: 'ghost', seed: 'ff' }], [...record.slice(0, 2), { seat: 2, playerId: 'ghost' }], live)).toMatch(/seat 3/);
    expect(recordSeedProblem([...seeds, { playerId: 'ghost', seed: 'ff' }], [...record, { seat: 4, playerId: 'ghost' }], live)).toMatch(/seats/);
    // With nothing noted at the table (another browser, or a record from before this was noted), the record is all there is.
    expect(recordSeedProblem([...seeds, { playerId: 'bot-1', seed: 'ff' }], unmarked, null)).toBeNull();
    expect(recordSeedProblem([...seeds, { playerId: 'bot-1', seed: 'ff' }], unmarked, { at: 0, button: 0, seats: [0, 1, 2], board: [], cards: {} })).toBeNull();
    expect(recordSeedProblem([...seeds, { playerId: 'bot-1', seed: 'ff' }], record, null)).toMatch(/practice bot/);
    // So when the list passes, it only says no seed came from a bot when the table note backs that.
    expect(seedListPassed(2, live)).toBe('2 seeds, one per person your browser saw dealt in, none from a bot');
    for (const without of [null, { at: 0, button: 0, seats: [0, 1, 2], board: [], cards: {} }]) {
      expect(seedListPassed(1, without)).toMatch(/^1 seed, one per person the record shows dealt in.*record's own list/);
      expect(seedListPassed(1, without)).not.toMatch(/none from a bot/);
    }
  });

  it('puts whose each seed is, and who was dealt in, into the proof file', () => {
    const seats = [
      { seat: 0, playerId: 'me', name: 'Me' },
      { seat: 1, playerId: 'bot-1', name: 'Bot', bot: { ownerName: 'Me', look: 0 } },
      { seat: 3, playerId: 'p2', name: 'P2' },
    ];
    const seeds = [
      { playerId: 'p2', seed: 'bb', name: 'P2' },
      { playerId: 'me', seed: 'aa', name: 'Me' },
    ];
    expect(proofSeeds(seeds, seats, null)).toEqual({
      clientSeeds: ['bb', 'aa'],
      seedOwners: ['p2', 'me'],
      players: [
        { seat: 0, playerId: 'me' },
        { seat: 1, playerId: 'bot-1', bot: true },
        { seat: 3, playerId: 'p2' },
      ],
    });
    // A bot the record no longer marks is still marked when this browser saw it at the table.
    const unmarked = seats.map(({ bot: _, ...s }) => s);
    expect(proofSeeds(seeds, unmarked, null).players.filter((p) => 'bot' in p)).toEqual([]);
    const live = { at: 0, button: 0, seats: [0, 1, 3], board: [], cards: {}, players: { 0: 'me', 1: 'bot-1', 3: 'p2' }, bots: ['bot-1'] };
    expect(proofSeeds(seeds, unmarked, live).players[1]).toEqual({ seat: 1, playerId: 'bot-1', bot: true });
  });

  it('warns at the table about a seed listed for someone not dealt in, once it knows everyone who was', () => {
    sent({ seed: 'aa', at: 0, table: 't1', player: 'me' });
    accepted('aa');
    const view = (clientSeeds: { playerId: string; seed: string }[]) =>
      ({
        id: 't1',
        me: { playerId: 'me', seat: 0 },
        seats: [{ seat: 0, playerId: 'me' }, { seat: 1, playerId: 'p2' }, null],
        hand: { names: { 0: 'Me', 1: 'P2' }, fair: { commit: C, clientSeeds } },
      }) as unknown as Parameters<typeof liveSeedProblem>[0];
    const ghost = [
      { playerId: 'me', seed: 'aa' },
      { playerId: 'ghost', seed: 'ff' },
    ];
    store.set('rsdp.fairLive', JSON.stringify({ [C]: JSON.stringify({ at: 10_000, button: 0, seats: [0, 1], board: [], cards: {}, players: { 0: 'me', 1: 'p2' }, bots: [] }) }));
    expect(liveSeedProblem(view([{ playerId: 'me', seed: 'aa' }, { playerId: 'p2', seed: 'bb' }]))).toBeNull();
    expect(liveSeedProblem(view(ghost))).toMatch(/\(ff\).*wasn't dealt in/);
    // Not everyone dealt in was seen at the table (one left before this browser saw the hand): it can't tell.
    store.set('rsdp.fairLive', JSON.stringify({ [C]: JSON.stringify({ at: 10_000, button: 0, seats: [0, 1], board: [], cards: {}, players: { 0: 'me' }, bots: [] }) }));
    expect(liveSeedProblem(view(ghost))).toBeNull();
  });
});
