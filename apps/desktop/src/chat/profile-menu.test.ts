import { describe, expect, it } from 'vitest';
import { PROFILE_MENU_ACTIONS, USER_MODE_OPTIONS, userModeBlurb } from './profile-menu';

describe('profile dropup contents', () => {
  it('renders Settings then Toggle theme, keeping their probe testids', () => {
    expect(PROFILE_MENU_ACTIONS.map((a) => a.id)).toEqual(['settings', 'theme']);
    expect(PROFILE_MENU_ACTIONS.map((a) => a.label)).toEqual(['Settings', 'Toggle theme']);
    const byId = Object.fromEntries(PROFILE_MENU_ACTIONS.map((a) => [a.id, a.testid]));
    expect(byId.settings).toBe('open-settings');
    expect(byId.theme).toBe('toggle-mode');
  });

  it('offers the User / Power-user toggle (user first) with a one-line blurb each', () => {
    expect(USER_MODE_OPTIONS.map((o) => o.value)).toEqual(['user', 'power']);
    expect(USER_MODE_OPTIONS.map((o) => o.label)).toEqual(['User', 'Power user']);
    for (const o of USER_MODE_OPTIONS) {
      expect(o.blurb.length).toBeGreaterThan(0);
    }
  });

  it('userModeBlurb returns the active mode blurb', () => {
    expect(userModeBlurb('user')).toBe('Simple — automatic model');
    expect(userModeBlurb('power')).toBe('Full model control');
  });
});
