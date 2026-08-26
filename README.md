# SFR — Smart Free Router

An evidence-driven **multi-model harness** that turns OpenRouter's free tier into
one reliable, self-improving model. Point your agent at SFR; it classifies every
request, routes it to the best *currently alive* free model, repairs what free
models break, and learns from every outcome.

```
opencode / aider / any OpenAI-compatible client
        │
        ▼
SFR proxy (127.0.0.1:43117+)          ── stats: /__sfr/stats
   classify → rank → attempt ladder
        │  per-attempt: sanitize · timeout · failover · repair · observe
        ▼
openrouter.ai/api/v1 (free models)
```

Works natively as an [opencode](https://opencode.ai) plugin, standalone via
`sfr serve`, or embedded (`import { initRouter } from "smart-free-router/server"`).

## Why a harness, not just a router?

Switching models means switching context and switching quality. SFR compensates:

- **Continuity shim** — routed requests get one idempotent system prompt telling
  the model it's continuing another model's work; agent tasks add strict
  tool-call output discipline.
- **Param sanitization** — unsupported `temperature` / `top_p` / … are stripped
  per model using live metadata, instead of burning attempts on guaranteed 400s.
- **Tool-call repair** — malformed `tool_calls[].function.arguments` (fences,
  trailing commas, unbalanced brackets) are repaired locally when provably
  parseable; only unrepairable output penalizes the model's score.
- **Stream resilience** — an SSE connection that opens with an error event is
  failed over *before* the first byte reaches you; streams that die mid-flight
  still end with a synthetic error + `[DONE]` so clients never hang.

## Routing evidence, not vibes

Every decision is logged (console + `~/.cache/opencode/sfr/decisions.jsonl`) and
aggregated at `GET /__sfr/stats`: routed/passthrough/failovers/timeouts/repairs/
exhausted counters, recent decisions, cooldown state.

Learning signals per (category × model): success-rate EWMA with idle decay,
latency bonus, tool-malformation penalties, exponential cooldowns — with shorter
penalties for shared-pool 429s than account-level ones. State survives restarts
and merges safely across concurrent processes.

Failover ladder ends in OpenRouter's own random free router; if even `/models`
is unreachable, SFR degrades to that instead of failing.

## Install

**opencode plugin (recommended):**

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/openrouter/free",
  "plugin": ["smart-free-router"]
}
```

The proxy starts automatically inside opencode. Get a key at
[openrouter.ai/keys](https://openrouter.ai/keys), then:

```sh
export OPENROUTER_API_KEY=sk-or-...
npx smart-free-router init   # verifies setup
```

**Standalone (any OpenAI-compatible client):**

```sh
npx smart-free-router serve
# base URL: http://127.0.0.1:43117/v1  ← point aider/Cursor/scripts here
# auth: your OpenRouter key, passed through
```

## Configuration

`~/.config/opencode/smart-free-router.json`, `.opencode/smart-free-router.json`,
or env — later layers win:

```jsonc
{
  "excludedModels": ["liquid/"],      // model-id substrings never used
  "pins": { "code": "z-ai/glm" },     // force a model per category
  "maxAttempts": 4,                   // candidates tried per request (1–8)
  "attemptTimeoutMs": 60000,          // per-attempt header timeout
  "stickiness": true,                 // keep one model per conversation
  "harnessShim": true,                // continuity/tool-discipline prompt
  "epsilon": 0.15                     // exploration probability (0–0.9)
}
```

Env: `OPENROUTER_API_KEY`, `SFR_DISABLE=1`, `SFR_DEBUG=1`, `SFR_MAX_ATTEMPTS`,
`SFR_ATTEMPT_TIMEOUT_MS`, `SFR_EPSILON`, `SFR_UPSTREAM`, `SFR_PORT_BASE`,
`SFR_CONFIG_DIR`, `SFR_STATE_DIR`.

Explicit model ids bypass everything (passthrough).

## Tests

Zero dependencies beyond Node ≥ 20:

```sh
npm test    # unit coverage for every module + full-ladder integration tests
            # against a scripted mock upstream; deterministic RNG, isolated ports/state
```

CI matrix: linux/macOS/windows × Node 20/22.

## Limitations

- Mid-stream failures after the first relayed byte can't be retried
  transparently; clients receive partial content plus clean termination.
- Ranking priors are documented starting points; the bandit overrides them from
  live evidence as data accumulates.

## License

MIT
