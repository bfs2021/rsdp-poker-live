import { useEffect, useState, type FormEvent } from 'react';
import { StatusPill } from './Suggestions';
import { ApiError, checkAdminKey, deleteSuggestion, fetchSuggestions, logOrder, shortDate, STATUS_LABEL, STATUSES, updateSuggestion, type Suggestion } from './suggestions';
import { deleteFeedback, feedbackOrder, fetchFeedback, KIND_LABEL, markFeedback, type Feedback } from './feedback';
import { adminDeleteTable, adminLookUpTable, issueResetCode, type AdminTable } from '../account/api';
import './roadmap.css';
import { SiteHeader } from '../components/SiteHeader';

const KEY = 'rsdp.adminKey';

function savedKey(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** /roadmap/admin: the admin sets each suggestion's status and an optional public reply. */
export function RoadmapAdminPage() {
  const [key, setKey] = useState(savedKey);
  /** Bumped on every Open, so trying the same key again re-checks it. */
  const [attempt, setAttempt] = useState(0);
  const [entered, setEntered] = useState('');
  const [ok, setOk] = useState(false);
  const [error, setError] = useState('');
  const [list, setList] = useState<Suggestion[]>([]);

  useEffect(() => {
    if (!key) return;
    checkAdminKey(key)
      .then(() => fetchSuggestions())
      .then((l) => (setList(l), setOk(true), setError('')))
      .catch((e: Error) => {
        setOk(false);
        setError(e.message);
        // Forget a saved key only when it is wrong, not when the server is briefly unreachable.
        if (e instanceof ApiError && e.status === 401) {
          try {
            localStorage.removeItem(KEY);
          } catch {
            // ignore
          }
        }
      });
  }, [key, attempt]);

  function signIn(e: FormEvent) {
    e.preventDefault();
    try {
      localStorage.setItem(KEY, entered);
    } catch {
      // The key then lasts only for this visit.
    }
    setKey(entered);
    setAttempt((n) => n + 1);
  }

  function signOut() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    setKey('');
    setOk(false);
  }

  const replace = (s: Suggestion) => setList((l) => l.map((x) => (x.id === s.id ? s : x)));

  return (
    <div className="site-page">
      <SiteHeader />
        <main className="roadmap-page">
        <p className="muted">
          <a href="/roadmap">Back to the roadmap</a>
        </p>
        <h1>Admin</h1>
        {!ok ? (
          <form className="suggest-form" onSubmit={signIn}>
            <label>
              Admin key
              <input type="password" value={entered} onChange={(e) => setEntered(e.target.value)} autoComplete="current-password" />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={!entered}>
              Open
            </button>
          </form>
        ) : (
          <>
            <p className="muted">
              Suggestion changes show on the public roadmap right away. <button onClick={signOut}>Sign out</button>
            </p>
            <FeedbackList adminKey={key} />
            <ResetCodeForm adminKey={key} />
            <DeleteTableForm adminKey={key} />
            <h2>Suggestions</h2>
            {error && <p className="error">{error}</p>}
            {list.length === 0 && <p className="muted">No suggestions yet.</p>}
            <ul className="admin-list">
              {logOrder(list).map((s) => (
                <AdminRow key={s.id} s={s} adminKey={key} onSaved={replace} onDeleted={() => setList((l) => l.filter((x) => x.id !== s.id))} onError={setError} />
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

function AdminRow(props: { s: Suggestion; adminKey: string; onSaved: (s: Suggestion) => void; onDeleted: () => void; onError: (m: string) => void }) {
  const { s, adminKey } = props;
  const [reply, setReply] = useState(s.reply);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      props.onError('');
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <div className="suggest-head">
        <strong>{s.title}</strong>
        <StatusPill status={s.status} />
      </div>
      {s.detail && <span className="suggest-detail">{s.detail}</span>}
      <span className="suggest-meta">
        #{s.id} · {s.name} · {shortDate(s.createdAt)}
      </span>
      <div className="admin-controls">
        <label>
          Status
          <select value={s.status} disabled={busy} onChange={(e) => run(async () => props.onSaved(await updateSuggestion(adminKey, s.id, { status: e.target.value as Suggestion['status'] })))}>
            {STATUSES.map((st) => (
              <option key={st} value={st}>
                {STATUS_LABEL[st]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Public reply (optional)
          <input value={reply} maxLength={300} onChange={(e) => setReply(e.target.value)} />
        </label>
        <div className="admin-buttons">
          <button disabled={busy || reply === s.reply} onClick={() =>
              run(async () => {
                const saved = await updateSuggestion(adminKey, s.id, { reply });
                // The server tidies spacing; show what actually went public.
                setReply(saved.reply);
                props.onSaved(saved);
              })
            }>
            Save reply
          </button>
          <button
            disabled={busy}
            onClick={() => confirm(`Delete "${s.title}" for good? Use this for spam.`) && run(async () => (await deleteSuggestion(adminKey, s.id), props.onDeleted()))}
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

/** Someone forgot their password: make them a one-time code to send in WhatsApp. */
function ResetCodeForm({ adminKey }: { adminKey: string }) {
  const [username, setUsername] = useState('');
  const [issued, setIssued] = useState<{ username: string; code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setIssued(null);
    try {
      setIssued(await issueResetCode(adminKey, username.trim()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="suggest-form" onSubmit={submit}>
      <strong>Password reset code</strong>
      <span className="muted">For a player who forgot their password. Send them the code; they enter it on the Forgot password page. It works once, for 24 hours.</span>
      <label>
        Their username
        <input value={username} maxLength={24} autoCapitalize="none" spellCheck={false} required onChange={(e) => setUsername(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      {issued && (
        <p className="suggest-thanks">
          Code for {issued.username}: <strong className="reset-code">{issued.code}</strong> (until {new Date(issued.expiresAt).toLocaleString()}). They go to{' '}
          {location.origin}/reset.
        </p>
      )}
      <button disabled={busy || !username.trim()}>Make a code</button>
    </form>
  );
}

/** A table's id from a pasted link (…/t/abc123) or the id itself. */
function tableIdFrom(text: string) {
  const t = text.trim();
  return /\/t\/([\w-]+)/.exec(t)?.[1] ?? t;
}

/** Test tables and mistakes: look a cash table up by its link, then delete it for good. */
function DeleteTableForm({ adminKey }: { adminKey: string }) {
  const [link, setLink] = useState('');
  const [found, setFound] = useState<AdminTable | null>(null);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function lookUp(e: FormEvent) {
    e.preventDefault();
    setFound(null);
    setDone('');
    void run(async () => setFound(await adminLookUpTable(adminKey, tableIdFrom(link))));
  }

  function remove(t: AdminTable) {
    const warning = t.realGame
      ? `"${t.name || 'Table'}" had a real game (${t.players.join(', ') || 'several people'}). Deleting it removes it from everyone's profile and ledger. Delete it for good?`
      : `Delete "${t.name || 'Table'}" for good?`;
    if (!confirm(warning)) return;
    void run(async () => {
      await adminDeleteTable(adminKey, t.id);
      setFound(null);
      setLink('');
      setDone(`Deleted "${t.name || 'Table'}".`);
    });
  }

  return (
    <form className="suggest-form" onSubmit={lookUp}>
      <strong>Delete a table</strong>
      <span className="muted">For test tables and mistakes. Paste the table's link. Real games stay unless you're sure: friends' records and ledgers depend on them.</span>
      <label>
        Table link or id
        <input value={link} spellCheck={false} autoCapitalize="none" required onChange={(e) => (setLink(e.target.value), setFound(null))} />
      </label>
      {error && <p className="error">{error}</p>}
      {done && <p className="suggest-thanks">{done}</p>}
      {found && (
        <div className="suggest-thanks">
          <strong>{found.name || 'Table'}</strong> · {found.mode === 'tournament' ? 'tournament table' : 'cash'} · made {shortDate(found.createdAt)} · {found.hands}{' '}
          {found.hands === 1 ? 'hand' : 'hands'}
          {found.players.length > 0 && ` · ${found.players.join(', ')}`}
          {found.realGame ? ' · real game' : ' · no real game'}
          {found.live && ' · open now (anyone there is sent away)'}
          {found.mode === 'cash' && (
            <div>
              <button type="button" className="danger" disabled={busy} onClick={() => remove(found)}>
                Delete for good
              </button>
            </div>
          )}
        </div>
      )}
      <button disabled={busy || !link.trim()}>Look it up</button>
    </form>
  );
}

/** Feedback players sent from tables: private, so only here. */
function FeedbackList({ adminKey }: { adminKey: string }) {
  const [list, setList] = useState<Feedback[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchFeedback(adminKey)
      .then(setList)
      .catch((e: Error) => setError(e.message));
  }, [adminKey]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const open = list?.filter((f) => !f.done).length ?? 0;
  return (
    <section className="feedback-admin">
      <h2>
        Feedback from tables{open > 0 && <span className="suggest-status in_progress">{open} new</span>}
      </h2>
      <p className="muted">Private: only the admin sees this. Kept for a year, and deleted with the sender's account.</p>
      {error && <p className="error">{error}</p>}
      {list?.length === 0 && <p className="muted">No feedback yet.</p>}
      <ul className="admin-list">
        {feedbackOrder(list ?? []).map((f) => (
          <li key={f.id} className={f.done ? 'done' : ''}>
            <div className="suggest-head">
              <strong>{f.name}</strong>
              <span className={`suggest-status ${f.kind === 'problem' ? 'declined' : f.kind === 'idea' ? 'approved' : ''}`}>{KIND_LABEL[f.kind]}</span>
              {f.done && <span className="suggest-status shipped">Done</span>}
            </div>
            <span className="feedback-text">{f.text}</span>
            <span className="suggest-meta">
              #{f.id} · {new Date(f.createdAt).toLocaleString()} · <a href={`/t/${f.tableId}`}>{f.tableName || 'Table'}</a> ({f.mode}
              {f.game && `, ${f.game}`}) · {f.handNumber > 0 ? `hand ${f.handNumber}` : 'before the first hand'} · {f.seated ? 'seated' : 'not seated'}
              {f.screen && ` · ${f.screen}`}
              {f.commit && ` · build ${f.commit.slice(0, 7)}`}
            </span>
            <div className="admin-buttons">
              <button disabled={busy} onClick={() => run(async () => {
                const saved = await markFeedback(adminKey, f.id, !f.done);
                setList((l) => l && l.map((x) => (x.id === saved.id ? saved : x)));
              })}>
                {f.done ? 'Mark not done' : 'Mark done'}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  confirm(`Delete feedback #${f.id} from ${f.name} for good?`) &&
                  run(async () => {
                    await deleteFeedback(adminKey, f.id);
                    setList((l) => l && l.filter((x) => x.id !== f.id));
                  })
                }
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
