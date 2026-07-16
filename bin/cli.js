#!/usr/bin/env node
// trace2eval — production LLM traces → portable eval datasets.
// Zero dependencies, zero network calls. Reads OTel GenAI trace JSON,
// writes a JSONL eval set + coverage map.
//
// Exit codes: 0 = wrote ≥1 case · 1 = no eval cases found · 2 = usage/input error

'use strict';

import { readFileSync, writeFileSync } from 'node:fs';
import { convert, toJsonl } from '../lib/convert.js';
import { coverageSummary } from '../lib/coverage.js';

const VERSION = '0.1.0';

const USAGE = `trace2eval v${VERSION} — production LLM traces → eval datasets

Usage:
  trace2eval <trace.json> [more.json ...] [options]

Options:
  -o, --output FILE     write JSONL dataset to FILE (default: stdout)
  --coverage FILE       write coverage map JSON to FILE
  --no-scrub            disable PII/secret scrubbing (default: on)
  --keep-duplicates     keep duplicate inputs (default: dedupe, keep first)
  --json                print run stats as JSON to stdout instead of summary
  -q, --quiet           suppress the human summary on stderr
  -h, --help            show this help
  -v, --version         print version

Input: OTLP/JSON trace exports ({"resourceSpans":[…]}), pre-flattened
{"spans":[…]}, or a bare JSON array of spans. GenAI content is read from
gen_ai.input/output.messages, gen_ai.prompt/completion (attribute, indexed,
or event form), and gen_ai.*.message / gen_ai.choice span events.

Exit codes: 0 = dataset written, 1 = no eval cases found, 2 = error`;

function parseArgs(argv) {
  const opts = {
    inputs: [],
    output: null,
    coverage: null,
    scrub: true,
    keepDuplicates: false,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '-v' || a === '--version') return { version: true };
    if (a === '-o' || a === '--output') {
      if (i + 1 >= argv.length) throw new Error(`${a} requires a file argument`);
      opts.output = argv[++i];
    } else if (a === '--coverage') {
      if (i + 1 >= argv.length) throw new Error('--coverage requires a file argument');
      opts.coverage = argv[++i];
    } else if (a === '--no-scrub') {
      opts.scrub = false;
    } else if (a === '--keep-duplicates') {
      opts.keepDuplicates = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '-q' || a === '--quiet') {
      opts.quiet = true;
    } else if (a.startsWith('-') && a !== '-') {
      throw new Error(`unknown option: ${a}`);
    } else {
      opts.inputs.push(a);
    }
  }
  return { opts };
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (parsed.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  if (parsed.version) {
    process.stdout.write(VERSION + '\n');
    process.exit(0);
  }
  const opts = parsed.opts;
  if (opts.inputs.length === 0) {
    process.stderr.write(`error: no input files\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (opts.json && !opts.output) {
    process.stderr.write('error: --json requires -o/--output (stats and dataset both target stdout otherwise)\n');
    process.exit(2);
  }

  const docs = [];
  for (const file of opts.inputs) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      process.stderr.write(`error: cannot read ${file}: ${err.message}\n`);
      process.exit(2);
    }
    try {
      docs.push(JSON.parse(raw));
    } catch (err) {
      process.stderr.write(`error: ${file} is not valid JSON: ${err.message}\n`);
      process.exit(2);
    }
  }

  let result;
  try {
    result = convert(docs, { scrub: opts.scrub, keepDuplicates: opts.keepDuplicates });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  const jsonl = toJsonl(result.cases);
  if (opts.output) {
    writeFileSync(opts.output, jsonl);
  } else {
    process.stdout.write(jsonl);
  }

  if (opts.coverage) {
    writeFileSync(opts.coverage, JSON.stringify(result.coverage, null, 2) + '\n');
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          version: VERSION,
          inputs: opts.inputs,
          cases: result.cases.length,
          totals: result.coverage.totals,
        },
        null,
        2
      ) + '\n'
    );
  }

  if (!opts.quiet) {
    const dest = opts.output ? opts.output : 'stdout';
    process.stderr.write(`trace2eval v${VERSION} → ${dest}\n${coverageSummary(result.coverage)}\n`);
  }

  process.exit(result.cases.length > 0 ? 0 : 1);
}

main();
