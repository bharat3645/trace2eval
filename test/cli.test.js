import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/sample-traces.json', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('--version and --help exit 0', () => {
  const v = run(['--version']);
  assert.equal(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const h = run(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage:/);
});

test('no input files → exit 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no input files/);
});

test('unknown option → exit 2', () => {
  const r = run(['--bogus', FIXTURE]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option/);
});

test('invalid JSON input → exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 't2e-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    const r = run([bad]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing file → exit 2', () => {
  const r = run(['/nonexistent/trace.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read/);
});

test('fixture → 5 JSONL cases, coverage file, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 't2e-'));
  try {
    const out = join(dir, 'eval.jsonl');
    const cov = join(dir, 'coverage.json');
    const r = run([FIXTURE, '-o', out, '--coverage', cov]);
    assert.equal(r.status, 0, r.stderr);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    for (const line of lines) {
      const c = JSON.parse(line);
      assert.match(c.id, /^c-[0-9a-f]{12}$/);
      assert.ok(Array.isArray(c.input.messages) && c.input.messages.length > 0);
      assert.ok(c.expected);
    }
    const coverage = JSON.parse(readFileSync(cov, 'utf8'));
    assert.equal(coverage.totals.cases, 5);
    assert.equal(coverage.totals.duplicates_removed, 1);
    assert.match(r.stderr, /cases: 5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSONL goes to stdout when -o omitted', () => {
  const r = run([FIXTURE, '-q']);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 5);
  JSON.parse(lines[0]);
  assert.equal(r.stderr, '');
});

test('--no-scrub keeps raw PII, default scrubs it', () => {
  const scrubbed = run([FIXTURE, '-q']);
  assert.ok(!scrubbed.stdout.includes('alice@example.com'));
  const raw = run([FIXTURE, '-q', '--no-scrub']);
  assert.ok(raw.stdout.includes('alice@example.com'));
});

test('--keep-duplicates emits 6 cases', () => {
  const r = run([FIXTURE, '-q', '--keep-duplicates']);
  assert.equal(r.stdout.trim().split('\n').length, 6);
});

test('--json stats with -o', () => {
  const dir = mkdtempSync(join(tmpdir(), 't2e-'));
  try {
    const out = join(dir, 'eval.jsonl');
    const r = run([FIXTURE, '-o', out, '--json', '-q']);
    assert.equal(r.status, 0);
    const stats = JSON.parse(r.stdout);
    assert.equal(stats.cases, 5);
    assert.equal(stats.totals.duplicates_removed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--json without -o → exit 2', () => {
  const r = run([FIXTURE, '--json']);
  assert.equal(r.status, 2);
});

test('input with no GenAI spans → exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 't2e-'));
  try {
    const f = join(dir, 'http-only.json');
    writeFileSync(
      f,
      JSON.stringify({
        spans: [{ traceId: 't', spanId: 's', name: 'GET /', attributes: { 'http.request.method': 'GET' } }],
      })
    );
    const r = run([f, '-q']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multiple input files merge', () => {
  const r = run([FIXTURE, FIXTURE, '-q']);
  // same fixture twice → all extra cases are duplicates → still 5
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split('\n').length, 5);
});

test('execFileSync round-trip sanity (dataset is valid JSONL)', () => {
  const out = execFileSync(process.execPath, [CLI, FIXTURE, '-q'], { encoding: 'utf8' });
  const cases = out
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const withTools = cases.find((c) => c.tools.length > 0);
  assert.equal(withTools.tools[0].name, 'get_weather');
});
