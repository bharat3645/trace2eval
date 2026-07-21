# trace2eval

[![CI](https://github.com/bharat3645/trace2eval/actions/workflows/ci.yml/badge.svg)](https://github.com/bharat3645/trace2eval/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Turn production LLM traces into portable eval datasets.**

Most teams have observability for their LLM apps; far fewer run evals — and the evals that do exist are usually hand-written synthetic cases that drift away from real traffic. Your traces already contain the best eval set you'll ever get: real prompts, real tool calls, real model outputs. `trace2eval` extracts it.

```
OTel GenAI trace JSON  ──▶  trace2eval  ──▶  eval.jsonl + coverage.json
                                │
                                ├─ scrubs PII & secrets (stable typed placeholders)
                                ├─ dedupes repeated prompts (content-hash, whitespace-insensitive)
                                └─ builds a coverage map (models, tools, token buckets, error rates)
```

Zero dependencies. Zero network calls. Your traces never leave your machine.

## Quick start

Try it against the sample OTLP trace committed in this repo — no setup needed, clone and run:

```console
$ npx trace2eval test/fixtures/sample-traces.json -o eval.jsonl --coverage coverage.json
trace2eval v0.1.0 → eval.jsonl
cases: 5  (from 9 GenAI spans / 10 total; 1 duplicate removed, 1 incomplete, 1 errored skipped)
scrubbed: 6 PII/secret values in 1 case (API_KEY:1 CREDIT_CARD:1 EMAIL:2 IP:1 PHONE:1)
models: gpt-4o:3 gpt-4o-mini-2024-07-18:1 claude-sonnet-4-5:1
tools: 1 case(s) with tool activity (get_weather:2)
```

(That's real output from this exact command — `test/fixtures/sample-traces.json` is the same fixture the test suite and CI's dogfood job run against.) Swap in your own trace export once you've seen the shape of the output.

Input is an OTLP/JSON trace export (`{"resourceSpans":[…]}` — what an OTLP file exporter or `otel-cli` produces), a pre-flattened `{"spans":[…]}` document, or a bare JSON array of spans. Multiple input files merge into one dataset.

## What a case looks like

One JSON object per line, ready for your eval runner:

```json
{
  "id": "c-be7a45ba90d8",
  "input": {
    "messages": [
      {"role": "system", "content": "You are a helpful support agent."},
      {"role": "user", "content": "How do I reset my password?"}
    ]
  },
  "expected": {"role": "assistant", "content": "Click 'Forgot password' on the sign-in page and follow the email link."},
  "tools": [],
  "meta": {
    "model": "gpt-4o-mini-2024-07-18",
    "system": "openai",
    "operation": "chat",
    "trace_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    "span_id": "a1a1a1a1a1a1a1a1",
    "start_ms": 1752600000000,
    "latency_ms": 850,
    "usage": {"input_tokens": 42, "output_tokens": 31},
    "status": "ok"
  }
}
```

`id` is a content hash of the canonicalized input, so IDs are stable across runs and across machines — diffing two datasets tells you exactly which cases appeared or vanished. Tool-execution spans (`gen_ai.operation.name = execute_tool`) are attached to their parent inference case under `tools`, with parsed arguments and results.

The schema maps directly onto promptfoo (`input.messages` → `prompt`, `expected.content` → `assert`), OpenAI evals JSONL, and Braintrust datasets; `meta` carries provenance back to the originating span.

## Supported trace encodings

The OTel GenAI semantic conventions have gone through several content encodings; `trace2eval` reads all of them:

| Style | Where |
|---|---|
| `gen_ai.input.messages` / `gen_ai.output.messages` | span attributes (JSON, current semconv) |
| `gen_ai.prompt` / `gen_ai.completion` | span attributes (JSON array or plain string) |
| `gen_ai.prompt.0.role`, `gen_ai.prompt.0.content`, … | indexed span attributes (legacy) |
| `gen_ai.content.prompt` / `gen_ai.content.completion` | span events |
| `gen_ai.system.message`, `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.choice` | span events (message-event style) |

Message content given as parts arrays (`[{type:"text", content:"…"}]`) is joined; `tool_calls` on assistant messages are normalized to `{id, name, arguments}` with JSON arguments parsed.

## PII & secret scrubbing

On by default (`--no-scrub` to disable). Detectors, most specific first: JWTs, API keys (OpenAI `sk-`, GitHub `ghp_`/`github_pat_`, AWS `AKIA…`, Slack `xox*-`, Groq `gsk_`, bearer tokens), credit cards (Luhn-validated), SSNs, emails, IPv4 addresses (octet-validated), phone numbers (10–15 digits; space/dash/paren separators — dots are deliberately excluded so decimals and versions survive).

Replacement uses **stable typed placeholders**: every occurrence of the same value within a case becomes the same placeholder (`alice@example.com` → `<EMAIL_1>` in the prompt *and* in the expected output), so multi-turn conversations stay internally consistent and an eval grader can still check that the model echoed the right entity. Scrub counts land in `meta.scrubbed` per case and aggregate in the coverage map.

Honest limits: this is regex-based scrubbing — it will catch the classic shapes and it will miss free-text PII ("my name is Jane and I live at …") and may occasionally flag a 10-digit order number as a phone. For regulated data, treat it as one layer, not the whole story. Scrubbing happens *before* dedupe, so two prompts that differ only in their PII collapse into one case.

## Dedupe

Production traffic repeats itself; eval sets shouldn't. Inputs are canonicalized (whitespace collapsed — case and punctuation preserved, they matter for evals) and hashed; the first occurrence wins, deterministically. `--keep-duplicates` keeps everything with disambiguated IDs (`c-…-2`, `c-…-3`) if you want frequency-weighted sets.

## Coverage map

`--coverage coverage.json` writes what your eval set actually covers — and, more usefully, what it doesn't:

```json
{
  "totals": {"spans_seen": 10, "genai_spans": 9, "cases": 5, "duplicates_removed": 1,
             "skipped_no_output": 1, "skipped_error": 1,
             "scrub_counts": {"EMAIL": 2, "PHONE": 1, "CREDIT_CARD": 1, "IP": 1, "API_KEY": 1}},
  "by_model": {"gpt-4o": 3, "gpt-4o-mini-2024-07-18": 1, "claude-sonnet-4-5": 1},
  "by_operation": {"chat": 5},
  "tools": {"cases_with_tools": 1, "by_tool": {"get_weather": 2}},
  "input_token_buckets": {"0-100": 2, "101-500": 1, "501-2000": 2},
  "multi_turn": {"single_turn": 5, "multi_turn": 0},
  "time_range": {"first_ms": 1752600000000, "last_ms": 1752600700000}
}
```

Errored spans and spans without captured output are counted, not silently dropped — if 40% of your traces have no recorded completions, that's a telemetry gap you want to know about before trusting the eval set.

## CLI reference

```
trace2eval <trace.json> [more.json ...] [options]

  -o, --output FILE     write JSONL dataset to FILE (default: stdout)
  --coverage FILE       write coverage map JSON to FILE
  --no-scrub            disable PII/secret scrubbing
  --keep-duplicates     keep duplicate inputs (default: dedupe)
  --json                print run stats as JSON to stdout (requires -o)
  -q, --quiet           suppress the summary on stderr
  -v, --version / -h, --help

Exit codes: 0 = dataset written · 1 = no eval cases found · 2 = error
```

## Performance

Measured on the included synthetic benchmark (`npm run bench`), Node v22.22.3, single core, full pipeline (extract → scrub → dedupe → coverage → JSONL):

| spans | cases out | time | throughput |
|---|---|---|---|
| 11,000 | 8,001 | 60 ms | ~183,000 spans/s |
| 55,000 | 40,001 | 290 ms | ~189,000 spans/s |

A day of traces is a coffee-sip, not a batch job.

## Programmatic use

```js
import { convert, toJsonl } from 'trace2eval/lib/convert.js';

const { cases, coverage } = convert([JSON.parse(rawOtlpJson)], { scrub: true });
fs.writeFileSync('eval.jsonl', toJsonl(cases));
```

## Roadmap

LangSmith and Braintrust export formats as first-class inputs; sampling strategies (per-bucket caps, stratified by model/tool); output adapters that emit promptfoo/OpenAI-evals config directly; OTLP protobuf ingestion.

## Related tools

Part of an agent-trust toolchain: [agent-rules-audit](https://github.com/bharat3645/agent-rules-audit) scans agent instruction files for poisoning; [mcp-sentinel](https://github.com/bharat3645/mcp-sentinel) locks and verifies MCP server configs against rug-pulls. `trace2eval` closes the loop: what your agents *actually did* in production becomes the test suite for what they do next.

## License

MIT
