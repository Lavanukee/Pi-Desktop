/**
 * The AppleScript seam shared by every app connector (Calendar, Reminders,
 * Contacts, Mail, and Messages *send*).
 *
 * Design, learned from real `osascript` behaviour on macOS 26:
 *
 *  - **Injection-safe parameters via `argv`.** User-supplied values (titles,
 *    queries, addresses, dates) are NEVER interpolated into the script text.
 *    The script body is a fixed `on run argv … end run`, and dynamic values are
 *    passed as trailing process arguments that AppleScript exposes as `argv`.
 *    A literal `--` separates them so a value beginning with `-` is not parsed
 *    as an `osascript` option. Because we `spawn` (never a shell) there is no
 *    shell-quoting surface at all.
 *
 *  - **Robust output via control-char delimiters.** Building valid JSON in
 *    AppleScript is error-prone (quote/backslash/newline escaping); instead each
 *    tool emits records joined by ASCII RS (0x1e) and fields by US (0x1f), with
 *    GS (0x1d) for sub-lists (a person's several emails). These bytes never occur
 *    in human calendar/contact text, so parsing is a plain split — and newlines
 *    inside a notes field survive untouched.
 *
 *  - **A shared handler prelude.** `pad2/pad4/isoOf/parseISO/safeText` are
 *    prepended to every script so dates round-trip as locale-independent
 *    `YYYY-MM-DD HH:MM:SS` strings and `missing value` never crashes a coercion.
 *
 * The {@link OsascriptRunner} is injectable so all argument-composition and
 * output-parsing logic unit-tests without touching a real app (the same
 * injectable-runner style as web-tools' spotlight/python runners). `runOsascript`
 * never throws: platform gating, spawn failure, and script errors all come back
 * as an outcome with an `error` string.
 */
import { spawnCapture } from './exec.js';

/** Field separator inside one record (ASCII US, 0x1f). */
export const FIELD_SEP = '\u001f';
/** Record separator between rows (ASCII RS, 0x1e). */
export const RECORD_SEP = '\u001e';
/** Sub-field separator inside a single field's list (ASCII GS, 0x1d). */
export const SUBFIELD_SEP = '\u001d';

/** AppleScript expressions that produce the three delimiters. */
export const AS_FIELD_SEP = '(character id 31)';
export const AS_RECORD_SEP = '(character id 30)';
export const AS_SUBFIELD_SEP = '(character id 29)';

export const DEFAULT_OSASCRIPT_TIMEOUT_MS = 30_000;
export const DEFAULT_OSASCRIPT_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Shared AppleScript handlers prepended to every composed script. They make
 * dates locale-independent and coercions crash-proof; call them with a `my`
 * prefix from inside a `tell application …` block.
 */
export const APPLESCRIPT_PRELUDE: readonly string[] = [
  'on pad2(n)',
  'set s to (n as integer) as text',
  'if length of s < 2 then set s to "0" & s',
  'return s',
  'end pad2',
  'on pad4(n)',
  'set s to (n as integer) as text',
  'repeat while length of s < 4',
  'set s to "0" & s',
  'end repeat',
  'return s',
  'end pad4',
  'on isoOf(dt)',
  'if dt is missing value then return ""',
  'set y to year of dt',
  'set mo to (month of dt) as integer',
  'set d to day of dt',
  'set hh to hours of dt',
  'set mm to minutes of dt',
  'set ss to seconds of dt',
  'return my pad4(y) & "-" & my pad2(mo) & "-" & my pad2(d) & " " & my pad2(hh) & ":" & my pad2(mm) & ":" & my pad2(ss)',
  'end isoOf',
  'on parseISO(s)',
  'set y to (text 1 thru 4 of s) as integer',
  'set mo to (text 6 thru 7 of s) as integer',
  'set d to (text 9 thru 10 of s) as integer',
  'set hh to (text 12 thru 13 of s) as integer',
  'set mm to (text 15 thru 16 of s) as integer',
  'set ss to (text 18 thru 19 of s) as integer',
  'set dt to current date',
  'set day of dt to 1',
  'set year of dt to y',
  'set month of dt to mo',
  'set day of dt to d',
  'set hours of dt to hh',
  'set minutes of dt to mm',
  'set seconds of dt to ss',
  'return dt',
  'end parseISO',
  'on safeText(x)',
  'if x is missing value then return ""',
  'return x as text',
  'end safeText',
];

export interface OsascriptRunOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface OsascriptProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** True when stdout hit the byte cap (results may be partial). */
  readonly truncated: boolean;
}

/**
 * Injectable process seam so connectors run without a real `osascript` in unit
 * tests. `scriptLines` become one `-e` flag each; `args` are passed after a `--`
 * so AppleScript exposes them as `argv`.
 */
export interface OsascriptRunner {
  run(
    scriptLines: readonly string[],
    args: readonly string[],
    opts: OsascriptRunOptions,
  ): Promise<OsascriptProcessResult>;
}

/** Build the concrete `osascript` argv (exported for unit assertions). */
export function buildOsascriptArgs(
  scriptLines: readonly string[],
  args: readonly string[],
): string[] {
  const out: string[] = ['-l', 'AppleScript'];
  for (const line of scriptLines) {
    out.push('-e', line);
  }
  // `--` guards against a user value that starts with '-' being read as an option.
  out.push('--', ...args);
  return out;
}

/** An {@link OsascriptRunner} backed by the real `osascript` binary. */
export function systemOsascriptRunner(): OsascriptRunner {
  return {
    async run(scriptLines, args, opts) {
      const r = await spawnCapture('osascript', buildOsascriptArgs(scriptLines, args), {
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
        signal: opts.signal,
      });
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        truncated: r.stdoutTruncated,
      };
    },
  };
}

/** Wrap a body in the shared prelude + an `on run argv … end run` handler. */
export function composeScript(bodyLines: readonly string[]): string[] {
  return [...APPLESCRIPT_PRELUDE, 'on run argv', ...bodyLines, 'end run'];
}

export interface AppleScriptOutcome {
  /** Raw stdout on success; empty string on error. */
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  /** Set when the script could not run or errored; `stdout` is then empty. */
  readonly error?: string;
}

export interface RunOsascriptOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Platform override (test seam / force-enable); defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** The macOS-only degrade message used by every connector when off-platform. */
export function macOnlyError(toolLabel: string, platform: NodeJS.Platform): string {
  return `${toolLabel} is macOS-only (it drives the osascript AppleScript bridge); current platform is "${platform}".`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a raw `osascript` script error (its stderr, e.g. an
 * `execution error: … (-1743)`) into a friendly, actionable message — most
 * commonly the TCC automation-permission prompt the user must accept once.
 */
export function friendlyScriptError(stderr: string, toolLabel: string): string {
  const s = stderr.trim();
  // -1743: "Not authorized to send Apple events" — the automation-consent prompt.
  if (/-1743|Not authorized to send Apple events|not allowed assistive/i.test(s)) {
    return `${toolLabel} needs permission to control the app. Grant it under System Settings › Privacy & Security › Automation (approve the prompt), then retry. (${s})`;
  }
  // -1728 / "Can't get" — a referenced object (calendar/list/mailbox) was missing.
  if (/-1728|Can’t get|Can't get/i.test(s)) {
    return `${toolLabel} could not find a referenced item (check the calendar/list/mailbox name). (${s})`;
  }
  return `${toolLabel} failed: ${s.length > 0 ? s : 'unknown osascript error'}`;
}

/**
 * Run a composed AppleScript (prelude + `on run argv` body) with `args` as
 * `argv`. Never throws: non-macOS, spawn failure, and script errors are all
 * returned as an {@link AppleScriptOutcome} carrying an `error` string.
 */
export async function runOsascript(
  runner: OsascriptRunner,
  bodyLines: readonly string[],
  args: readonly string[],
  toolLabel: string,
  opts: RunOsascriptOptions = {},
): Promise<AppleScriptOutcome> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      stdout: '',
      timedOut: false,
      truncated: false,
      error: macOnlyError(toolLabel, platform),
    };
  }

  const script = composeScript(bodyLines);
  let result: OsascriptProcessResult;
  try {
    result = await runner.run(script, args, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_OSASCRIPT_TIMEOUT_MS,
      maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_OSASCRIPT_MAX_OUTPUT_BYTES,
      signal: opts.signal,
    });
  } catch (err) {
    return {
      stdout: '',
      timedOut: false,
      truncated: false,
      error: `${toolLabel} could not start osascript: ${errMessage(err)}`,
    };
  }

  if (result.timedOut) {
    return {
      stdout: '',
      timedOut: true,
      truncated: result.truncated,
      error: `${toolLabel} timed out (the app may be launching or a permission prompt is waiting).`,
    };
  }

  if (result.exitCode !== 0) {
    return {
      stdout: '',
      timedOut: false,
      truncated: result.truncated,
      error: friendlyScriptError(result.stderr, toolLabel),
    };
  }

  return { stdout: result.stdout, timedOut: false, truncated: result.truncated };
}

/**
 * Split delimited `osascript` stdout into records of fields. Every emitted row
 * ends with a {@link RECORD_SEP}, and `osascript` appends a trailing newline to
 * the returned string, so the final split segment is a lone `"\n"` — a
 * whitespace-only row we drop. A real record always contains {@link FIELD_SEP}
 * bytes (not whitespace), so this only discards the trailing artifact.
 */
export function parseRecords(stdout: string): string[][] {
  const rows = stdout.split(RECORD_SEP);
  const out: string[][] = [];
  for (const row of rows) {
    if (row.trim().length === 0) continue;
    out.push(row.split(FIELD_SEP));
  }
  return out;
}

/** Split a single field into its GS-joined sub-values, dropping empties. */
export function parseSubfields(field: string | undefined): string[] {
  if (field === undefined || field.length === 0) return [];
  return field
    .split(SUBFIELD_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Clamp a requested limit to `[1, max]`, defaulting when unset/non-finite. */
export function boundLimit(requested: number | undefined, fallback: number, max: number): number {
  const n = requested ?? fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}
