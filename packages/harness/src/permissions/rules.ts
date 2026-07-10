/**
 * Reviewer-mode "scary bash" rules.
 *
 * Seeded from RemotePi's bash-guard.ts (per the plan's porting map). In reviewer
 * permission mode these flag destructive/irreversible shell commands so the
 * harness can require user confirmation before they run. An optional injectable
 * classifier-model hook (see permissions/modes.ts) can flag additional commands;
 * these regex/substring rules are the always-available heuristic fallback.
 */

/** Exact destructive substrings (matched case-insensitively). */
export const SCARY_EXACT: readonly string[] = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf $home',
  'rm -rf /*',
  'rm -rf ~/',
  'rm --no-preserve-root',
  'dd if=',
  'mkfs',
  'shred /dev',
  'wipefs',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init 0',
  'init 6',
  'npm uninstall -g',
  'pip uninstall',
  'kill -9 1',
  ':(){ :|:& };:',
  '> /etc/passwd',
  '> /etc/shadow',
  '> /etc/fstab',
  'chmod 777 /etc',
  'chmod -r 777 /',
  'git push --force origin main',
  'git push --force origin master',
  'git push -f origin main',
  'git push -f origin master',
  'drop database',
  'drop table',
];

/** Destructive command patterns (matched case-insensitively). */
export const SCARY_PATTERNS: readonly string[] = [
  '\\b(dd|shred|wipefs)\\s.*\\/dev\\/(sd|nvme|hd)',
  'rm\\s+-[rf]+\\s+\\/(?!home\\/[a-z]|tmp\\/|var\\/tmp)',
  'curl.*\\|.*sh$',
  'wget.*\\|.*sh$',
  'curl.*\\|.*bash$',
  'wget.*\\|.*bash$',
  'history\\s+-[cw]',
  '> ~\\/\\.bash_history',
  '> ~\\/\\.zsh_history',
];

export interface ScaryBashRules {
  readonly exact: readonly string[];
  readonly patterns: readonly string[];
}

/** The default (seeded) rule set. Callers may extend with their own. */
export const DEFAULT_SCARY_RULES: ScaryBashRules = {
  exact: SCARY_EXACT,
  patterns: SCARY_PATTERNS,
};

/**
 * Check a shell command against the scary-bash rules.
 * Returns a human-readable reason string when flagged, or `null` when it looks safe.
 */
export function checkScaryBash(
  command: string,
  rules: ScaryBashRules = DEFAULT_SCARY_RULES,
): string | null {
  const lower = command.toLowerCase();
  for (const phrase of rules.exact) {
    if (lower.includes(phrase.toLowerCase())) return `matches blocked phrase "${phrase}"`;
  }
  for (const pattern of rules.patterns) {
    try {
      if (new RegExp(pattern, 'i').test(command)) return `matches blocked pattern /${pattern}/`;
    } catch {
      // A malformed custom pattern should never break the gate.
    }
  }
  return null;
}

/** Merge extra user rules on top of the seeded defaults. */
export function extendScaryRules(extra: Partial<ScaryBashRules>): ScaryBashRules {
  return {
    exact: [...DEFAULT_SCARY_RULES.exact, ...(extra.exact ?? [])],
    patterns: [...DEFAULT_SCARY_RULES.patterns, ...(extra.patterns ?? [])],
  };
}
