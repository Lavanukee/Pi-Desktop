#!/usr/bin/env python3
"""
THE HELD-OUT ACCEPTANCE CHECK for the `converter` target.

WHY THIS EXISTS. Run 14's gate went green — `python3 -m pytest -q`, 20 passed,
verified independently. The product converted JSON->CSV, JSON->YAML, CSV->JSON,
CSV->YAML and YAML->JSON correctly on inputs it had never seen. It failed
YAML->CSV:

    Error: Conversion failed: YAML must contain a 'data' key for CSV conversion

and its own test suite tests exactly that: `yaml_to_csv` against a hand-made
"wrapper" file, plus a case asserting it fails for anything else. The team
encoded its own limitation as the specification and then tested that the
limitation holds. The tests are honest and they pass; they are simply not the
requirement, which said "any of the three to any other".

A gate made of the team's own tests can only ever ask "is this self-consistent?".
So the benchmark target gets a check written by the harness, never shown to the
team, run on inputs the product has never seen. This is the ordinary way to
evaluate a coding agent — a held-out set — and it is the only thing that makes
"DELIVERED" mean what it says.

FAIRNESS. This tests exactly what the task asked for and nothing more: flat
tabular records (the shape a CSV can carry) surviving a trip between all six
ordered pairs of JSON, CSV and YAML, through a command-line entry point that
takes an input file and an output file. It does not test nested data through
CSV — that is genuinely ill-posed, and the task never asked for it.

    python3 converter-acceptance.py <workspace>   # exit 0 = delivered
"""

import csv
import io
import json
import os
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:
    print("ACCEPTANCE SKIPPED: pyyaml is not installed on this machine")
    sys.exit(0)

# Flat records — exactly what a CSV can hold, so every pair is well posed.
RECORDS = [
    {"name": "Ada", "role": "engineer", "year": "1843"},
    {"name": "Grace", "role": "admiral", "year": "1952"},
]
FORMATS = ("json", "csv", "yaml")


def write_input(path, fmt):
    """Write RECORDS to `path` in `fmt`."""
    if fmt == "json":
        with open(path, "w") as f:
            json.dump(RECORDS, f, indent=2)
    elif fmt == "csv":
        with open(path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(RECORDS[0].keys()))
            w.writeheader()
            w.writerows(RECORDS)
    else:
        with open(path, "w") as f:
            yaml.safe_dump(RECORDS, f, default_flow_style=False, sort_keys=False)


def read_records(path, fmt):
    """Read whatever the product produced back into a list of flat dicts.

    Deliberately generous about SHAPE, strict about CONTENT: a single record may
    come back as a bare object, and a list may be wrapped in a one-key envelope
    (`{"data": [...]}`), both of which are reasonable choices the task never ruled
    on. Values are compared as strings because CSV has no types and the task did
    not ask anyone to infer them.
    """
    with open(path) as f:
        text = f.read()
    if text.strip() == "":
        raise ValueError("output file is empty")
    if fmt == "json":
        obj = json.loads(text)
    elif fmt == "yaml":
        obj = yaml.safe_load(text)
    else:
        obj = list(csv.DictReader(io.StringIO(text)))

    if isinstance(obj, dict):
        # Unwrap a single-key envelope around the actual rows.
        values = list(obj.values())
        if len(values) == 1 and isinstance(values[0], list):
            obj = values[0]
        else:
            obj = [obj]
    if not isinstance(obj, list):
        raise ValueError(f"expected a list of records, got {type(obj).__name__}")
    return [{str(k): str(v) for k, v in row.items()} for row in obj]


def find_entry_points(ws):
    """Every plausible `<script> <input> <output>` entry point, best first.

    The task asked for "a command-line entry point"; it did not dictate a name,
    so this looks the way a user would: any runnable script, obvious names first.

    DELIBERATELY NOT CLEVER ABOUT THIS. The first version of this function also
    required the literal string `argv`, and reported "no command-line entry point
    found" for run 15 — whose `converter.py` used `argparse`, which reads
    `sys.argv` without ever naming it, and converted correctly when run by hand.
    A false negative from the acceptance check is worse than a false positive:
    it fails work that was done. So the only filter is "has a __main__ and is not
    a test"; whether it is really the entry point is decided by RUNNING it.
    """
    named, other = [], []
    for root, dirs, files in os.walk(ws):
        dirs[:] = [d for d in dirs if d not in (".pi", ".pytest_cache", "__pycache__", ".git")]
        for name in files:
            if not name.endswith(".py") or name.startswith("test_") or name == "conftest.py":
                continue
            full = os.path.join(root, name)
            try:
                body = open(full).read()
            except OSError:
                continue
            if "__main__" not in body:
                continue
            (named if any(k in name for k in ("convert", "cli", "main", "run")) else other).append(full)
    return named + other


# How a CLI might take "an input file and an output file". The task named the two
# arguments and said nothing about their form, so every one of these satisfies it.
#
# THE SECOND FALSE NEGATIVE THIS FILE HAS PRODUCED. Run 16's `convert.py` used
# `--input`/`--output` and was scored 6-of-6 WRONG by a checker that only tried
# positional arguments. An acceptance test that fails work for an interface choice
# the task never constrained is not measuring the team, it is measuring my
# assumptions. When in doubt, try the other reasonable thing.
ARG_STYLES = (
    lambda src, dst: [src, dst],
    lambda src, dst: ["--input", src, "--output", dst],
    lambda src, dst: ["-i", src, "-o", dst],
    lambda src, dst: ["--in", src, "--out", dst],
    lambda src, dst: [f"--input={src}", f"--output={dst}"],
    lambda src, dst: ["--input-file", src, "--output-file", dst],
    lambda src, dst: ["convert", src, dst],
)


def run(entry, ws, src, dst, style):
    return subprocess.run(
        [sys.executable, entry, *style(src, dst)],
        cwd=ws, capture_output=True, text=True, timeout=60,
    )


def try_entry(entry, ws, tmp, style):
    """Run all six ordered pairs through `entry`. Returns (passed, failures)."""
    failures = []
    for a in FORMATS:
        for b in FORMATS:
            if a == b:
                continue
            src = os.path.join(tmp, f"in_{a}_{b}.{a}")
            dst = os.path.join(tmp, f"out_{a}_{b}.{b}")
            if os.path.exists(dst):
                os.remove(dst)
            write_input(src, a)
            try:
                proc = run(entry, ws, src, dst, style)
            except subprocess.TimeoutExpired:
                failures.append(f"{a}->{b}: timed out")
                continue
            if proc.returncode != 0:
                err = (proc.stderr or proc.stdout or "").strip().splitlines()
                failures.append(f"{a}->{b}: exit {proc.returncode} — {err[-1] if err else 'no output'}")
                continue
            if not os.path.exists(dst):
                failures.append(f"{a}->{b}: exited 0 but wrote no {b} file")
                continue
            try:
                got = read_records(dst, b)
            except Exception as exc:  # noqa: BLE001 — any parse failure is a failure
                failures.append(f"{a}->{b}: output is not readable {b}: {exc}")
                continue
            want = [{str(k): str(v) for k, v in r.items()} for r in RECORDS]
            if got != want:
                failures.append(f"{a}->{b}: content changed — expected {want}, got {got}")
    return len(failures) == 0, failures


def main():
    if len(sys.argv) != 2:
        print("usage: converter-acceptance.py <workspace>")
        return 2
    ws = sys.argv[1]
    entries = find_entry_points(ws)
    if not entries:
        print("ACCEPTANCE FAIL: no command-line entry point found in the product")
        return 1

    best = None
    with tempfile.TemporaryDirectory() as tmp:
        for entry in entries:
            rel = os.path.relpath(entry, ws)
            for style in ARG_STYLES:
                ok, failures = try_entry(entry, ws, tmp, style)
                if ok:
                    print(f"ACCEPTANCE PASS: {rel} converts all six pairs correctly")
                    return 0
                # Keep whatever got furthest — that is the real product and its
                # real argument form, not the first thing that happened to fail.
                if best is None or len(failures) < len(best[1]):
                    best = (rel, failures)

    rel, failures = best
    print(f"ACCEPTANCE FAIL: {rel} — {len(failures)} of 6 conversions wrong")
    for f in failures:
        print(f"  {f}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
