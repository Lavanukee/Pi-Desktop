/**
 * The ONE definition of how an agent's live work is shown on a canvas surface —
 * shared by the normal chat's routers and the corp (multi-agent) router.
 *
 * jedd, having watched a run: "make sure first and foremost that these are
 * totally in sync, you can change something about one and it reflects on the
 * other ... use the regular chat thing, not the subagents thing, as the good
 * starting point." They were two implementations of the same idea that had
 * drifted — the chat mirrored a command one way, the corp another, and a fix to
 * either left the other exactly as wrong as before.
 *
 * So the primitives live here, and both routers import them. There is no corp
 * spelling of a terminal mirror any more; there is one spelling.
 */

/**
 * Patterns that mark a command as interactive or long-running enough to warrant
 * a live terminal of its own in the normal chat. Deliberately narrow so a
 * routine `ls` / `git status` never pops a terminal — only clearly persistent or
 * interactive processes do.
 */
const INTERACTIVE_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|watch|serve|preview)\b/,
  /\bvite\b/,
  /\bnodemon\b/,
  /\bwebpack(?:-dev-server)?\b/,
  /\bnext\s+(?:dev|start)\b/,
  /\b(?:tail|watch|top|htop|less|vim|nano|ssh|irb|psql)\b/,
  /\btail\s+-f\b/,
  /--watch\b/,
  /\bpython3?\s+-m\s+http\.server\b/,
  /\bhttp-server\b/,
  /\bjest\s+--watch\b/,
  /\bdocker\s+(?:run|compose\s+up)\b/,
  /&\s*$/,
];

/** True when a bash command is interactive / long-running (→ live terminal). */
export function isInteractiveCommand(command: string): boolean {
  const c = command.trim();
  if (c === '') return false;
  return INTERACTIVE_PATTERNS.some((re) => re.test(c));
}

/**
 * The xterm text for one command in a mirror terminal: the prompt line, then its
 * output, exactly as it looked in the shell.
 *
 * A command with no output yet reads "(running…)" — it is genuinely still going.
 * A FINISHED command that printed nothing reads "(no output)", which is a
 * different fact and used to be reported as the first one by the corp's copy of
 * this function: every quiet `mkdir` sat there claiming to be running forever.
 */
export function mirrorCommandText(command: string, output: string, running: boolean): string {
  const body = output.length > 0 ? output : running ? '(running…)' : '(no output)';
  return `$ ${command}\n\n${body}\n`;
}

/** First few words of a command, clipped — a terminal tab's short title. */
export function shortCommandTitle(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 3).join(' ');
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}
