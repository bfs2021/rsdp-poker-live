import { useEffect, useState } from 'react';
import type { AuditEntry } from '@rsdp/engine';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';
import { checkRecord, GITHUB_COPY, LIVE_HOST, recordProblem } from '../audit';
import './fairness.css';

const REPO = 'https://github.com/jcolter11374/rsdp-poker-live';
const WATCHER = 'https://raw.githubusercontent.com/jcolter11374/rsdp-poker-live/transparency/deploys/current.json';
/** A watcher report older than this means it has stopped: GitHub starts its hourly schedule late, 3 to 8 hours apart in practice. */
const STALE_HOURS = 12;

type Version = { commit: string | null; image: string | null; startedAt: string };
type Head = { seq: number; hash: string; copied?: string };
type Watcher = { checked: string; machines: { id: string; state: string; digest: string | null; lastStart: string | null; signed: { commit: string | null } | null }[]; problems: string[]; notes?: string[] };

const json = <T,>(url: string) => fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`${r.status}`))));
const when = (t: string | number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'unknown');

function describe(e: AuditEntry): string {
  if (e.kind === 'boot') return `The server started${e.data.commit ? `, running commit ${short(String(e.data.commit))}` : ''}`;
  if (e.kind === 'deleted') {
    if (e.data.by === 'player') return 'A practice table was deleted by the only person who played at it';
    return `A table was deleted by ${e.data.by === 'admin' ? 'the admin (John)' : 'its host'}`;
  }
  if (e.data.action === 'backup') return 'Backup: a copy of the whole database was downloaded with the admin key';
  if (e.data.action === 'read-table-chat') return 'Chat read: the admin (John) read one table’s chat with the admin key';
  if (e.data.action === 'read-tournament-chat') return 'Chat read: the admin (John) read the chat at one tournament’s tables with the admin key';
  return `Admin (John): ${e.data.action}${e.data.target ? ` (${e.data.target})` : ''}`;
}

/** /transparency: what the site runs, the public record, and every admin action and server start, with GitHub's view of each beside it. */
export function TransparencyPage() {
  const [version, setVersion] = useState<Version | null>(null);
  const [head, setHead] = useState<Head | null>(null);
  const [copy, setCopy] = useState<Head | null | 'none'>(null);
  const [watcher, setWatcher] = useState<Watcher | null | 'none'>(null);
  const [actions, setActions] = useState<AuditEntry[] | null>(null);
  const [problem, setProblem] = useState(recordProblem);

  useEffect(() => {
    json<Version>('/api/version').then(setVersion, () => {});
    json<Head>('/api/audit/head').then(setHead, () => {});
    // GitHub only watches the live site: a copy of the site elsewhere has nothing to compare.
    if (location.hostname === LIVE_HOST) {
      json<Head>(GITHUB_COPY).then(setCopy, () => setCopy('none'));
      json<Watcher>(WATCHER).then(setWatcher, () => setWatcher('none'));
    } else {
      setCopy('none');
      setWatcher('none');
    }
    (async () => {
      const out: AuditEntry[] = [];
      for (let page = 0; page < 5; page++) {
        const { entries } = await json<{ entries: AuditEntry[] }>(`/api/audit/entries?after=${out.at(-1)?.seq ?? 0}&kind=admin,boot,deleted`);
        out.push(...entries);
        if (entries.length < 1000) break;
      }
      setActions(out.reverse());
    })().catch(() => setActions([]));
    checkRecord(true).then(() => setProblem(recordProblem()), () => {});
  }, []);

  const running = watcher && watcher !== 'none' ? watcher.machines.find((m) => m.state === 'started') : null;
  // The same limit as scripts/transparency/status.mjs, which opens an issue on GitHub.
  const stale = watcher && watcher !== 'none' && Date.now() - new Date(watcher.checked).getTime() > STALE_HOURS * 3_600_000;

  return (
    <div className="site-page">
      <SiteHeader />
      <main className="fairness-page transparency-page">
        <h1>Checking John</h1>
        <p>
          John runs this site, so he could in theory cheat. This page shows the checks that make that hard to do quietly. Most of them run on GitHub, outside John&rsquo;s server, so a
          changed server can&rsquo;t also change what they found. What they can&rsquo;t catch is on <a href="/fairness">Fair dealing</a>, under &ldquo;How the developer could cheat you&rdquo;.
        </p>

        {problem && (
          <p className="error">
            ✗ <b>Your browser found a problem on {when(problem.at)}:</b> {problem.text}
          </p>
        )}

        <h2>What the site runs</h2>
        <ul>
          <li>
            The server says it runs commit{' '}
            {version?.commit ? <a href={`${REPO}/commit/${version.commit}`}>{short(version.commit)}</a> : 'unknown (a build from before this was added, or a local copy)'}
            {version && <>, started {when(version.startedAt)}</>}. That is the server describing itself, so on its own it proves nothing.
          </li>
          <li>
            GitHub&rsquo;s watcher asks Fly which image the live machine runs, and checks GitHub&rsquo;s own signed record of how that image was built. It also
            checks the machine&rsquo;s start command, settings and secret names, which could otherwise make the same image run other code. It runs right after each
            release GitHub builds and deploys, and on a schedule set to every hour that GitHub starts hours late, so every few hours in practice. A change made any
            other way, say a release from John&rsquo;s own computer, would only be seen at the next of those checks.{' '}
            {watcher === null ? (
              'Loading…'
            ) : watcher === 'none' ? (
              'It hasn’t reported yet.'
            ) : watcher.problems.length ? (
              <span className="down">
                Last check ({when(watcher.checked)}) found a problem: {watcher.problems.join(' ')}
              </span>
            ) : running?.signed ? (
              <span className="up">
                Last check ({when(watcher.checked)}): the image was built and signed by GitHub from commit{' '}
                <a href={`${REPO}/commit/${running.signed.commit}`}>{short(running.signed.commit)}</a> on main
                {running.lastStart ? <>; the machine last started {when(running.lastStart)}</> : null}.
              </span>
            ) : (
              <>Last check: {when(watcher.checked)}.</>
            )}{' '}
            {watcher && watcher !== 'none' && watcher.notes?.length ? <>Noted: {watcher.notes.join(' ')} </> : null}
            {stale && <span className="down">That is more than {STALE_HOURS} hours ago, longer than GitHub&rsquo;s usual delays, so the watcher has stopped or can&rsquo;t get through. </span>}
            <a href={`${REPO}/tree/transparency/deploys`}>Every check</a>
          </li>
        </ul>

        <h2>The public record</h2>
        <p>
          Every hand, every change to a player&rsquo;s buy-ins and cash-outs, every admin action that changes something, every chat John reads from the admin page, and every server start goes into a chain where each entry includes a fingerprint of the one
          before. Editing or removing an old entry breaks every fingerprint after it. The record holds no names and no table links.
        </p>
        <ul>
          <li>The site&rsquo;s record has {head ? `${head.seq.toLocaleString()} entries` : '…'}.</li>
          <li>
            GitHub&rsquo;s watcher copies it each time it runs (every few hours):{' '}
            {copy === null ? '…' : copy === 'none' ? 'no copy yet.' : `up to entry ${copy.seq.toLocaleString()}, copied ${copy.copied ? when(copy.copied) : ''}.`}{' '}
            <a href={`${REPO}/tree/transparency/audit`}>The copy</a>
          </li>
          <li>
            Your browser remembers the latest entry it saw, and checks on every visit that the record still has it, unchanged{problem ? '' : ': so far, it does'}.
          </li>
          <li>&ldquo;Check this hand&rdquo; checks a revealed hand against the record, and the ledger checks every buy-in and cash-out.</li>
        </ul>

        <h2>Admin actions and server starts</h2>
        {actions === null ? (
          <p className="muted">Loading…</p>
        ) : actions.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul>
            {actions.map((e) => (
              <li key={e.seq}>
                <span className="muted">{when(e.at)}</span> · {describe(e)}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          The site&rsquo;s record can be wrong about itself, so GitHub&rsquo;s copy is the one to trust. A restart is normal after a release, or when Fly moves the machine. Admin actions are things like removing a test table, a nightly backup, or John reading a table&rsquo;s chat from the admin page (the entry holds only the table&rsquo;s fingerprint, so people with its link can tell it was theirs; nobody else can tell which table). A shell on the server (which John can open) is not
          recorded anywhere: Fly doesn&rsquo;t offer a way to show that publicly.
        </p>

        <h2>Check it yourself</h2>
        <pre>
          <code>{`git clone ${REPO}
cd rsdp-poker-live
git clone -b transparency ${REPO} copy
node scripts/verify-audit.mjs --copy copy --proof hand-12-proof.json`}</code>
        </pre>
        <p className="muted">
          It checks the record with Node&rsquo;s own SHA-256 and nothing from the app. Any problem the watcher finds also opens an issue on GitHub, so anyone watching the repo is told.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
