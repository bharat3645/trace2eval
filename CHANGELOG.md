# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed
- Quick Start's example command pointed at `traces.json`, a file that doesn't exist anywhere in the repo — not runnable as written. Now points at the real, committed `test/fixtures/sample-traces.json` (the same fixture the test suite and CI's dogfood job already exercise), with output re-captured from an actual `node bin/cli.js` run rather than hand-written.
- Pipeline diagram at the top of the README listed "dedupes" before "scrubs", the reverse of the real order (`lib/convert.js` scrubs each case before deduping) and inconsistent with the README's own later statement that "Scrubbing happens *before* dedupe." Bullet order now matches.

## [0.1.0] — 2026-07-16

Initial release.

### Added
- OTLP/JSON trace ingestion (`resourceSpans` exports, pre-flattened `{spans:[…]}`, bare span arrays), with full AnyValue decoding and BigInt-safe nanosecond timestamps.
- GenAI content extraction across five semconv encodings: `gen_ai.input/output.messages`, `gen_ai.prompt/completion` attributes, indexed `gen_ai.prompt.N.*` (legacy), `gen_ai.content.prompt/completion` events, and `gen_ai.*.message` / `gen_ai.choice` message events. Tool-call normalization with parsed JSON arguments.
- `execute_tool` span attachment to parent inference cases (by `parentSpanId`, traceId fallback).
- PII/secret scrubbing with stable typed placeholders: JWT, API keys (OpenAI/GitHub/AWS/Slack/Groq/bearer), Luhn-validated credit cards, SSN, email, octet-validated IPv4, phone (10–15 digits). Per-case counts in `meta.scrubbed`.
- Content-hash case IDs + whitespace-insensitive input dedupe (`--keep-duplicates` to opt out).
- Coverage map (`--coverage`): totals incl. skipped/errored spans, by-model/system/operation, tool usage, input-token buckets, multi-turn split, time range.
- CLI with JSONL to file or stdout, `--json` stats, `--no-scrub`, `-q`; exit codes 0/1/2.
- 55-test suite (`node --test`, zero dependencies), synthetic benchmark (~185k spans/s on Node 22), GitHub Actions CI (Node 18/20/22 matrix + dogfood job that converts the sample trace and asserts the dataset).
