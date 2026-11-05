import { describe, expect, it } from 'vitest';
import { apply, createTournament, defaultSettings, type TournamentState } from '@rsdp/tournament';
import { resultsCsv, resultsFileName, tableChatText } from './results';

const T0 = Date.parse('2026-10-30T02:00:00Z');

function field(names: string[]): TournamentState {
  let s = createTournament({ id: 'R', hostId: 'host', settings: defaultSettings({ name: 'Friday/Night', lateRegistration: { enabled: false, throughLevel: null } }), now: T0, seed: 1 });
  names.forEach((n, i) => (s = apply(s, { type: 'register', playerId: `p${i}`, displayName: n }, T0).state));
  return apply(s, { type: 'startNow', by: 'host' }, T0).state;
}

describe('results CSV', () => {
  it('lists everyone with chips while running, quoting awkward names and defusing formulas', () => {
    const csv = resultsCsv(field(['Ana', 'Bo, Jr.', '=HYPERLINK("x")']));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Place,Player,Entries,Rebuys,Add-ons,Knockouts,Chips');
    expect(lines).toHaveLength(4);
    expect(csv).toContain('"Bo, Jr."');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines).toContain(',Ana,1,0,0,0,10000');
  });

  it('names the file after the tournament and its day', () => {
    expect(resultsFileName(field(['Ana', 'Bo']))).toBe('Friday Night 2026-10-30.csv');
  });
});

describe('table chat download', () => {
  it('lists each table in turn, chat and log in time order, chat marked', () => {
    const at = (m: number) => T0 + m * 60_000;
    const text = tableChatText(
      field(['Ana', 'Bo']),
      [
        { table: 1, log: [{ at: at(0), text: 'Ana sat down' }], chat: [{ at: at(2), playerId: 'p0', name: 'Ana', text: 'gl all' }] },
        { table: 3, log: [], chat: [{ at: at(1), playerId: 'p1', name: 'Bo', text: 'blinds felt fast' }] },
      ],
      (t) => `+${(t - T0) / 60_000}m`,
    );
    expect(text).toBe(
      ['Friday/Night: table chat and log (2 tables, 2 chat messages)', '', '=== Table 1 ===', '+0m  Ana sat down', '+2m  [chat] Ana: gl all', '', '=== Table 3 ===', '+1m  [chat] Bo: blinds felt fast', '', ''].join('\n'),
    );
  });

  it('says so when nothing was said', () => {
    expect(tableChatText(field(['Ana', 'Bo']), [])).toContain('Nothing was said or logged at the tables.');
  });
});
