import { useState } from 'react';
import { applyStarter, matchingStarter, savedStructureErrors, structureToSave, STARTERS, type TournamentSettings } from '@rsdp/tournament';
import { SETUP_NAME_MAX } from '@rsdp/engine/wire';
import { SavedSetupRow } from '../components/SavedSetupRow';
import { cleanSetupName } from '../savedSetups';
import { saveStructure, structureSettings, tournamentStructures } from './structures';

/**
 * The top of the new-tournament form: start from a built-in starter or a
 * structure you saved, and save the form as it stands for next time.
 */
export function SavedStructures({ current, onLoad }: { current: TournamentSettings; onLoad: (settings: TournamentSettings, note: string) => void }) {
  const saved = tournamentStructures.use();
  const onAccount = tournamentStructures.useOnAccount();
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  // The starter the form is on now, so the host can see it without opening the levels.
  const onStarter = STARTERS.find((s) => s.id === matchingStarter(current));
  const say = (text: string, error?: boolean) => setMsg({ text, error });
  const fail = (e: unknown) => say(e instanceof Error ? e.message : String(e), true);

  const save = () => {
    const label = cleanSetupName(name) || current.name;
    if (!tournamentStructures.ready()) return say('Still loading your saved structures. Try again in a moment.', true);
    const errors = savedStructureErrors(structureToSave(current));
    if (errors.length) return say(`Fix this first: ${errors[0]}`, true);
    if (saved.some((s) => s.name === label) && !confirm(`Replace your saved structure “${label}”?`)) return;
    saveStructure(label, current).then((kept) => {
      setName('');
      say(`Saved “${kept}”. It's here next time you make a tournament.`);
    }, fail);
  };
  const load = (setupName: string) => {
    const setup = saved.find((s) => s.name === setupName);
    if (!setup) return;
    try {
      onLoad(structureSettings(setup), `Loaded your saved structure “${setup.name}”. Check the start time, then create.`);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section className="tn-card tn-saved">
      <h2>Start from</h2>
      <div className="tn-chips" role="group" aria-label="Starter structures">
        {STARTERS.map((s) => (
          <button
            type="button"
            key={s.id}
            className={`tn-chip ${s === onStarter ? 'on' : ''}`}
            aria-pressed={s === onStarter}
            title={s.blurb}
            onClick={() => onLoad(applyStarter(current, s.id), `${s.name}: ${s.blurb}. Everything else stays as you had it.`)}
          >
            {s === onStarter && <span aria-hidden="true">✓ </span>}
            {s.name}
          </button>
        ))}
      </div>
      {onStarter ? (
        <p className="tn-note tn-saved-hint">
          Set to <b>{onStarter.name}</b>: {onStarter.blurb}. Your games, start time and everything else are up to you.
        </p>
      ) : (
        <p className="muted tn-saved-hint">Starters set the stack, blind levels and late registration, and keep your games. Your saved structures bring back everything.</p>
      )}
      {saved.length > 0 && (
        <div className="tn-saved-list">
          <h3>Your saved structures</h3>
          {saved.map((s) => (
            <SavedSetupRow key={s.name} setup={s} list={tournamentStructures} what="saved structure" onMessage={say}>
              <button type="button" className="primary" aria-label={`Load ${s.name}`} onClick={() => load(s.name)}>
                Load
              </button>
            </SavedSetupRow>
          ))}
        </div>
      )}
      <div className="row tn-saved-save">
        <input aria-label="Name for this structure" value={name} maxLength={SETUP_NAME_MAX} placeholder={current.name || 'Name, e.g. Friday turbo'} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), save())} />
        <button type="button" onClick={save}>
          Save this setup
        </button>
      </div>
      <p className="muted tn-saved-hint">
        {onAccount ? 'Saved structures are kept on your account, so they follow you to any device.' : 'Saved structures live in this browser. Sign in to keep them on every device.'}
      </p>
      {msg && <p className={msg.error ? 'error' : 'tn-note'} role="status">{msg.text}</p>}
    </section>
  );
}
