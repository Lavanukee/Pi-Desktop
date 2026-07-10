import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSearchArgs, parseContacts, runContactsSearch } from './contacts.js';
import type { OsascriptProcessResult, OsascriptRunner } from './osascript.js';

const contactsOut = readFileSync(new URL('./fixtures/contacts.txt', import.meta.url), 'utf8');

function fakeOsa(over: Partial<OsascriptProcessResult> = {}): {
  runner: OsascriptRunner;
  count: () => number;
} {
  let n = 0;
  return {
    runner: {
      async run() {
        n += 1;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, ...over };
      },
    },
    count: () => n,
  };
}
const darwin = { platform: 'darwin' as const };

describe('buildSearchArgs', () => {
  it('passes the query and clamps the limit', () => {
    expect(buildSearchArgs({ query: 'ada', limit: 999 })).toEqual(['ada', '100']);
    expect(buildSearchArgs({ query: 'ada' })).toEqual(['ada', '25']);
  });
});

describe('parseContacts', () => {
  it('parses names, GS-joined emails/phones, and optional org', () => {
    const contacts = parseContacts(contactsOut);
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toEqual({
      name: 'Ada Lovelace',
      emails: ['ada@example.com', 'ada@work.example.com'],
      phones: ['+1 555 0100', '+1 555 0199'],
      org: 'Analytical Engines',
    });
    expect(contacts[1]).toEqual({
      name: 'Bob Stone',
      emails: ['bob@example.com'],
      phones: [],
    });
  });
});

describe('runContactsSearch', () => {
  it('rejects an empty query without spawning', async () => {
    const { runner, count } = fakeOsa();
    const outcome = await runContactsSearch(runner, { query: '  ' }, darwin);
    expect(outcome.error).toContain('non-empty query');
    expect(count()).toBe(0);
  });
  it('gates off non-darwin', async () => {
    const { runner } = fakeOsa();
    const outcome = await runContactsSearch(runner, { query: 'ada' }, { platform: 'linux' });
    expect(outcome.error).toContain('macOS-only');
  });
  it('returns parsed contacts', async () => {
    const { runner } = fakeOsa({ stdout: contactsOut });
    const outcome = await runContactsSearch(runner, { query: 'a' }, darwin);
    expect(outcome.contacts).toHaveLength(2);
    expect(outcome.contacts[0]?.emails).toHaveLength(2);
  });
});
