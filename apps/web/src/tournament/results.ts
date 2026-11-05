import { standings, type TournamentState, type TournamentTableChat } from '@rsdp/tournament';
import { download, fullLogLines } from '../records';

/** A spreadsheet cell: quoted when needed, and never read as a formula. */
function cell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** Standings as CSV: finishing order, entries, rebuys, add-ons, knockouts, bounties, prizes, and chips for those still in. */
export function resultsCsv(s: TournamentState): string {
  const rows = standings(s);
  const money = !!s.settings.payouts;
  const bounties = rows.some((r) => r.bounties || r.knockouts) || !!s.settings.bounty;
  const live = rows.some((r) => r.place === null);
  const head = ['Place', 'Player', 'Entries', 'Rebuys', 'Add-ons', 'Knockouts', ...(bounties ? ['Bounties'] : []), ...(money ? ['Prize'] : []), ...(live ? ['Chips'] : [])];
  const lines = rows.map((r) =>
    [
      r.place ?? '',
      r.displayName,
      r.entryNo,
      r.rebuys,
      r.addOns,
      r.knockouts ?? 0,
      ...(bounties ? [dollars(r.bounties ?? 0)] : []),
      ...(money ? [dollars(r.prize)] : []),
      ...(live ? [r.place === null ? r.stack : ''] : []),
    ].map(cell),
  );
  return [head.map(cell), ...lines].map((l) => l.join(',')).join('\r\n') + '\r\n';
}

/** "Friday Night 2026-10-30.csv" */
export function resultsFileName(s: TournamentState): string {
  const day = new Date(s.startedAt ?? s.createdAt).toISOString().slice(0, 10);
  const name = s.settings.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Tournament';
  return `${name} ${day}.csv`;
}

export function downloadResults(s: TournamentState) {
  // The byte-order mark makes Excel read names with accents and emoji correctly.
  const blob = new Blob(['﻿', resultsCsv(s)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = resultsFileName(s);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Every table's chat and log of a finished tournament as one text file, table by table, each in time order. */
export function tableChatText(s: TournamentState, tables: TournamentTableChat[], when: (at: number) => string = (at) => new Date(at).toLocaleString()): string {
  const chats = tables.reduce((n, t) => n + t.chat.length, 0);
  const out = [`${s.settings.name}: table chat and log (${tables.length} ${tables.length === 1 ? 'table' : 'tables'}, ${chats} chat ${chats === 1 ? 'message' : 'messages'})`, ''];
  if (!tables.length) out.push('Nothing was said or logged at the tables.');
  for (const t of tables) {
    out.push(`=== Table ${t.table} ===`);
    // No hands: each table's hand history is its own download while it is open.
    for (const l of fullLogLines(t.log, t.chat, [], '', String)) out.push(`${when(l.at)}  ${l.kind === 'chat' ? '[chat] ' : ''}${l.text}`);
    out.push('');
  }
  return out.join('\n') + '\n';
}

export function downloadTableChat(s: TournamentState, tables: TournamentTableChat[]) {
  download(resultsFileName(s).replace(/\.csv$/, ' table chat.txt'), tableChatText(s, tables));
}
