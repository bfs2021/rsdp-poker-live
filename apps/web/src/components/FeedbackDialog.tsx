import { useState, type FormEvent } from 'react';
import { call } from '../socket';
import { Modal } from './SeatDialog';

export const FEEDBACK_MAX = 1000;

const KINDS = [
  { id: 'problem', label: 'Something’s wrong' },
  { id: 'idea', label: 'An idea' },
  { id: 'other', label: 'Something else' },
] as const;
type Kind = (typeof KINDS)[number]['id'];

const PLACEHOLDER: Record<Kind, string> = {
  problem: 'What happened, and what did you expect? e.g. "My timer ran out while I was raising."',
  idea: 'What would make the site better?',
  other: 'Anything you’d like to tell us.',
};

/** Send feedback: private words to the admin, saved with which table and hand this is. */
export function FeedbackDialog({ portrait, onClose }: { portrait: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>('problem');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    call('feedback:send', { kind, text, screen: portrait ? 'phone' : 'desktop' })
      .then(() => setSent(true))
      .catch((err: Error) => setError(err.message.charAt(0).toUpperCase() + err.message.slice(1)))
      .finally(() => setBusy(false));
  }

  if (sent)
    return (
      <Modal title="Thanks!" onClose={onClose}>
        <p>Got it, and thank you. John reads these and follows up on anything that’s broken.</p>
        <div className="row">
          <button className="primary" autoFocus onClick={onClose}>
            Back to the table
          </button>
        </div>
      </Modal>
    );

  return (
    <Modal title="Send feedback" onClose={onClose}>
      <form className="form feedback-form" onSubmit={submit}>
        <div className="row wrap" role="radiogroup" aria-label="What kind of feedback">
          {KINDS.map((k) => (
            <label key={k.id} className="toggle">
              <input type="radio" name="feedback-kind" checked={kind === k.id} onChange={() => setKind(k.id)} />
              {k.label}
            </label>
          ))}
        </div>
        <label>
          Your message
          <textarea rows={5} maxLength={FEEDBACK_MAX} value={text} placeholder={PLACEHOLDER[kind]} autoFocus onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="muted">
          Only John sees this, with your table name, this table and the hand number, so he can look into it. Other players don’t. For ideas you’d like everyone to see, use the{' '}
          <a href="/roadmap" target="_blank" rel="noreferrer">
            suggestion box
          </a>
          .
        </p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !text.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
