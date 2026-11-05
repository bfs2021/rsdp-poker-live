import { describe, expect, it } from 'vitest';
import { adminChatText, chatIdFrom } from './AdminPage';

describe('reading a table chat on the admin page', () => {
  it('takes a table or tournament link, or a bare id', () => {
    expect(chatIdFrom(' https://rsdp-poker-live.fly.dev/t/Ab3_x9-q ')).toBe('Ab3_x9-q');
    expect(chatIdFrom('https://rsdp-poker-live.fly.dev/tn/Zz9_k2?x=1')).toBe('Zz9_k2');
    expect(chatIdFrom('Ab3_x9-q')).toBe('Ab3_x9-q');
  });

  it('writes one line per message, with a heading per tournament table', () => {
    const when = (at: number) => `t${at}`;
    expect(adminChatText({ kind: 'table', name: 'Thursday', tables: [{ table: 1, name: 'Thursday', chat: [{ at: 1, name: 'Ana', text: 'gg' }] }] }, when)).toBe('Thursday\n\n[t1] Ana: gg\n');
    const t = adminChatText(
      {
        kind: 'tournament',
        name: 'Night',
        tables: [
          { table: 1, name: 'Table 1', chat: [{ at: 1, name: 'Ana', text: 'hi' }] },
          { table: 2, name: 'Table 2', chat: [{ at: 2, name: 'Bo', text: 'yo' }] },
        ],
      },
      when,
    );
    expect(t).toBe('Night\n\n== Table 1 ==\n[t1] Ana: hi\n\n== Table 2 ==\n[t2] Bo: yo\n');
    expect(adminChatText({ kind: 'table', name: 'Empty', tables: [] })).toContain('Nothing was said');
  });
});
