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
  // Block-device writers, or ANY redirect straight onto a raw disk device.
  // `r?disk` covers the macOS device names (/dev/disk0, /dev/rdisk0) too.
  '\\b(dd|shred|wipefs)\\s.*\\/dev\\/(sd|nvme|hd|r?disk)',
  '>\\s*\\/dev\\/(sd|nvme|hd|r?disk)',
  // rm hitting an absolute/home root. Order-independent: flags may appear in any
  // order and `--no-preserve-root` may sit before OR after `-rf` (so the exact
  // "rm --no-preserve-root" substring alone is not enough).
  'rm\\s+-[rf]+\\s+\\/(?!home\\/[a-z]|tmp\\/|var\\/tmp)',
  'rm\\s+(-\\S+\\s+)+\\/(\\s|$)',
  'rm\\s+(-\\S+\\s+)+~(\\/\\S*)?(\\s|$)',
  // rm with LONG flags (--recursive/--force) and/or a deep absolute SYSTEM path
  // (`-[rf]+` above only matches short flags, and the `/(\\s|$)` form only matches
  // a bare root). Excludes the common-safe user/temp locations so legit dev
  // deletes (project dirs, /tmp, macOS /var/folders) don't nag.
  'rm\\s+(-\\S+\\s+)+\\/(?!home\\/[a-z]|tmp\\/|var\\/(tmp|folders)|private\\/|users\\/[a-z]|dev\\/null)',
  '\\brm\\b.*--no-preserve-root',
  // Mass deletion via find: the `-delete` idiom, and `find / -exec rm …` (rooted
  // at `/` so `find . -exec rm {}` cleanup in the cwd stays unflagged).
  '\\bfind\\b.*\\s-delete\\b',
  '\\bfind\\s+\\/\\S*\\s.*-exec\\b.*\\brm\\b',
  // Recursive chmod that rewrites perms on a system root (ANY mode, not just 777).
  'chmod\\s+-\\S*r\\S*\\s+[0-7]{3,4}\\s+\\/(?!home\\/|tmp\\/|var\\/(tmp|folders)|private\\/|users\\/)',
  // Pipe-to-shell RCE. NOT end-anchored (a trailing `-s -- foo` used to slip past
  // an `sh$`/`bash$` anchor): token-match a pipe into any sh variant, optionally
  // through sudo/env, and the `bash <(curl …)` process-substitution form too.
  'curl.*\\|\\s*(sudo\\s+)?(env\\s+\\S+\\s+)*(ba|z|da|k|c|tc)?sh\\b',
  'wget.*\\|\\s*(sudo\\s+)?(env\\s+\\S+\\s+)*(ba|z|da|k|c|tc)?sh\\b',
  '(ba|z|da|k|c|tc)?sh\\s+<\\(\\s*(curl|wget)\\b',
  // Remote fetch fed straight into eval (RCE with no pipe / no process-sub).
  '\\beval\\b.*(curl|wget|fetch)\\b',
  // git clean with force (irreversibly deletes untracked/ignored files).
  '\\bgit\\s+clean\\b.*-\\S*f',
  // truncate zeroing a system file.
  '\\btruncate\\b.*\\/(etc|usr|s?bin|system|library|boot)\\b',
  // Fork bomb, whitespace-tolerant (the exact-string form is brittle).
  ':\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&',
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
