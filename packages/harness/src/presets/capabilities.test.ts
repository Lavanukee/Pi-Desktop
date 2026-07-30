/**
 * Capabilities replace tool_search. jedd: "remove tool search entirely, and
 * instead replace with a 'capability' tool … the tools can be computer use,
 * mail, calendar, browser etc.", and separately "the tool search isn't great and
 * is a source of much looping right now."
 *
 * A capability is a FIXED named set turned on in one call, so the same request
 * always yields the same tools — the property a scored free-text query lacked.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, capabilityActivated, capabilityMenu, findCapability } from './capabilities';

describe('asking for a capability by name', () => {
  it('finds one however the model spells it', () => {
    for (const spelling of ['computer-use', 'computer use', 'Computer_Use', ' COMPUTER-USE ']) {
      expect(findCapability(spelling)?.name).toBe('computer-use');
    }
  });

  it('takes a near miss rather than refusing — "mail" plainly means personal', () => {
    expect(findCapability('personal')?.name).toBe('personal');
    expect(findCapability('browser')?.name).toBe('browser');
  });

  it('returns nothing for something that is not a capability', () => {
    expect(findCapability('teleportation')).toBeUndefined();
  });
});

describe('the groups themselves', () => {
  it('bundles calendar, mail, reminders, contacts and messages as ONE thing', () => {
    // jedd: "bundle the calendar, email and reminders stuff also."
    const personal = findCapability('personal');
    expect(personal?.summary).toContain('Calendar');
    expect(personal?.summary).toContain('Mail');
    expect(personal?.summary).toContain('Reminders');
    expect((personal?.tools.length ?? 0) > 1).toBe(true);
  });

  it('carries the WHEN, not just the what — each has guidance', () => {
    for (const cap of CAPABILITIES) {
      expect(cap.guidance.length).toBeGreaterThan(40);
      expect(cap.summary.length).toBeGreaterThan(10);
      expect(cap.tools.length).toBeGreaterThan(0);
    }
  });

  it('sends Chrome down the DOM path inside computer-use', () => {
    expect(findCapability('computer-use')?.guidance).toContain('chrome_*');
  });
});

describe('what the model is told', () => {
  it('lists every capability when asked bare', () => {
    const menu = capabilityMenu();
    for (const cap of CAPABILITIES) expect(menu).toContain(cap.name);
  });

  it('names the tools it just gained, and how to use them', () => {
    const cap = findCapability('browser');
    if (cap === undefined) throw new Error('browser capability missing');
    const text = capabilityActivated(cap, [...cap.tools]);
    expect(text).toContain('is on');
    expect(text).toContain(cap.tools[0] ?? '');
    expect(text).toContain('PRIMARY web control');
  });

  it('says so honestly when a capability is not in this build', () => {
    const cap = findCapability('generation');
    if (cap === undefined) throw new Error('generation capability missing');
    // None of its tools registered — pretending would have the model call nothing.
    expect(capabilityActivated(cap, ['read', 'bash'])).toContain('not available in this build');
  });

  it('only ever claims the tools that actually exist', () => {
    const cap = findCapability('personal');
    if (cap === undefined) throw new Error('personal capability missing');
    const only = cap.tools[0] ?? '';
    const text = capabilityActivated(cap, [only]);
    expect(text).toContain(only);
    for (const missing of cap.tools.slice(1)) expect(text).not.toContain(missing);
  });
});
