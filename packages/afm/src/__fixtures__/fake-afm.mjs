#!/usr/bin/env node
/**
 * A fake `pi-afm` binary: a plain-Node script that speaks the same NDJSON
 * protocol as the real Swift helper, so the wrapper's unit tests exercise the
 * real spawn / stdin / stdout / line-framing path without Apple Intelligence.
 *
 * Behavior is driven by the prompt for the `--respond` path:
 *   - "ERROR" → emit an `error` line (recoverable) and exit.
 *   - "HANG"  → stream one delta then hang forever (for AbortSignal tests).
 *   - "CRASH" → exit 3 after one delta, WITHOUT a done/error (premature close).
 *   - else    → stream the prompt back one word per delta, then `done`.
 *
 * `--check` reflects the FAKE_AFM_REASON env var (default: available).
 */
import process from 'node:process';

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const subcommand = process.argv[2];

if (subcommand === '--check') {
  const reason = process.env.FAKE_AFM_REASON ?? 'available';
  writeLine({ available: reason === 'available', reason, contextWindow: 4096, model: 'fake-afm' });
  process.exit(0);
} else if (subcommand === '--respond') {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let request;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      writeLine({ type: 'error', message: 'Invalid request JSON', recoverable: false });
      process.exit(0);
    }

    const prompt = String(request.prompt ?? '');
    if (prompt === 'ERROR') {
      writeLine({ type: 'error', message: 'Context window exceeded.', recoverable: true });
      process.exit(0);
    } else if (prompt === 'HANG') {
      writeLine({ type: 'delta', text: 'partial' });
      // Never emit done — the test aborts and SIGKILLs us. Keep the event loop
      // alive so Node doesn't exit 0 on its own the moment stdin ends.
      setInterval(() => {}, 60_000);
    } else if (prompt === 'CRASH') {
      writeLine({ type: 'delta', text: 'partial' });
      process.stderr.write('boom\n');
      process.exit(3);
    } else {
      const words = prompt.split(' ').filter((w) => w.length > 0);
      for (let i = 0; i < words.length; i++) {
        writeLine({ type: 'delta', text: i === 0 ? words[i] : ` ${words[i]}` });
      }
      writeLine({ type: 'done' });
      process.exit(0);
    }
  });
} else {
  process.stderr.write('usage: fake-afm [--check | --respond]\n');
  process.exit(2);
}
