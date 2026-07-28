/**
 * THE CAPABILITY LEDGER — what this machine can actually do, measured.
 *
 * NOT a permission system. jedd's call is explicit: full capability, no
 * artificial constraints, guard destruction hard at the terminal layer. This
 * exists for a different reason — **planning**. A manager that writes twenty
 * pieces of work against Godot on a machine with no Godot has wasted the night,
 * and a team that discovers `pyyaml` is missing on the last turn instead of the
 * first has wasted it differently.
 *
 * So before the CEO is ever prompted, the toolchains the task plausibly needs are
 * PROBED — actually invoked, not guessed from a filesystem path — and the answer
 * is handed to the team as fact. Present things become assumptions they can rely
 * on; absent things become a named, visible gap.
 *
 * The second reason is the one that matters at 4am: when a capability is missing
 * and no human is awake, the run must not die. The gap is recorded, the team is
 * told to work around it or build what it can, and jedd comes back to a short
 * list of "these needed you" rather than a failed run or an agent that installed
 * something he did not sanction.
 *
 * Node child_process only. Never throws.
 */

import { execFileSync } from 'node:child_process';

/** One probed capability. */
export interface Capability {
  /** How the team refers to it — `python3`, `godot`, `ffmpeg`, `pyyaml`. */
  readonly name: string;
  readonly present: boolean;
  /** Version or identifying line, when it reported one. */
  readonly detail?: string;
  /** What the team should do about it being missing (shown only when absent). */
  readonly ifMissing?: string;
}

/** How to check one thing. `probe` must be cheap and side-effect free. */
interface Probe {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Words in the task that make this worth probing. Empty = always probe. */
  readonly relevantTo: readonly string[];
  readonly ifMissing: string;
}

const PROBES: readonly Probe[] = [
  {
    name: 'python3',
    command: 'python3',
    args: ['--version'],
    relevantTo: [],
    ifMissing: 'Write the product in a language this machine does have.',
  },
  {
    name: 'node',
    command: 'node',
    args: ['--version'],
    relevantTo: [],
    ifMissing: 'Write the product in a language this machine does have.',
  },
  {
    name: 'pyyaml',
    command: 'python3',
    args: ['-c', 'import yaml, sys; sys.stdout.write(yaml.__version__)'],
    relevantTo: ['yaml', 'yml'],
    ifMissing: 'Parse and emit YAML yourself rather than depending on a library that is not here.',
  },
  {
    name: 'pytest',
    command: 'python3',
    args: ['-c', 'import pytest, sys; sys.stdout.write(pytest.__version__)'],
    relevantTo: ['test', 'python'],
    ifMissing:
      'Write tests as a plain script that runs with `python3 <file>` and exits non-zero on failure. Do NOT depend on pytest.',
  },
  {
    name: 'godot',
    command: 'godot',
    args: ['--version'],
    relevantTo: ['godot'],
    ifMissing:
      'Godot is not installed, so nothing can be run or verified in it. Say so plainly rather than pretending the project works.',
  },
  {
    name: 'ffmpeg',
    command: 'ffmpeg',
    args: ['-version'],
    relevantTo: ['convert', 'video', 'audio', 'media'],
    ifMissing: 'Handle the formats you can without it, and name the ones you cannot.',
  },
  {
    name: 'git',
    command: 'git',
    args: ['--version'],
    relevantTo: [],
    ifMissing: '',
  },
];

/** Run one probe. Present only if it exits 0. */
function probe(p: Probe): Capability {
  try {
    const out = execFileSync(p.command, [...p.args], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const detail = out.trim().split('\n')[0]?.slice(0, 120) ?? '';
    return { name: p.name, present: true, ...(detail !== '' ? { detail } : {}) };
  } catch {
    return {
      name: p.name,
      present: false,
      ...(p.ifMissing !== '' ? { ifMissing: p.ifMissing } : {}),
    };
  }
}

/**
 * Probe the toolchains this task plausibly needs. Always probes the universal
 * ones; the rest only when the task mentions something they relate to, so a
 * "write me a CSV converter" run does not spend time looking for Godot.
 */
export function probeCapabilities(task: string): Capability[] {
  const lower = task.toLowerCase();
  return PROBES.filter(
    (p) => p.relevantTo.length === 0 || p.relevantTo.some((word) => lower.includes(word)),
  ).map(probe);
}

/**
 * The briefing handed to the team with the task. Deliberately concrete and
 * short: a small model acts on "pytest is NOT installed — write a plain script"
 * far more reliably than on a table it has to interpret.
 *
 * Returns an empty string when there is nothing worth saying.
 */
export function capabilityBriefing(caps: readonly Capability[]): string {
  const present = caps.filter((c) => c.present);
  const missing = caps.filter((c) => !c.present);
  if (present.length === 0 && missing.length === 0) return '';

  const lines: string[] = ['WHAT THIS MACHINE HAS (checked just now, these are facts):'];
  for (const c of present) lines.push(`  - ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  if (missing.length > 0) {
    lines.push('', 'NOT AVAILABLE — do not plan around these:');
    for (const c of missing) {
      lines.push(`  - ${c.name}${c.ifMissing ? ` — ${c.ifMissing}` : ''}`);
    }
    lines.push(
      '',
      'If something you genuinely need is missing, build what you can without it and',
      'say clearly in your final answer what was blocked and why. Do not pretend.',
    );
  }
  return lines.join('\n');
}

/** The blocked capabilities, for the run summary a human reads afterwards. */
export function blockedCapabilities(caps: readonly Capability[]): string[] {
  return caps.filter((c) => !c.present && (c.ifMissing ?? '') !== '').map((c) => c.name);
}
