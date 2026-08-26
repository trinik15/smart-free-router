# Changelog

## 0.1.0 — initial packaging

First packaged release of Smart Free Router.

- Task classifier (code/reason/agent/vision/fast/general), zero latency
- Ranking: per-category priors + EWMA bandit with idle decay + epsilon exploration + pins/exclusions
- Health system: exponential cooldowns, shared-pool vs account 429 distinction, session stickiness, disk persistence with concurrent-writer merging
- Harness: continuity/tool-discipline system-prompt shim (idempotent), per-model parameter sanitization, conservative tool-call argument repair
- Streaming: pre-first-byte error failover, synthetic termination on premature stream death
- Per-attempt upstream timeout; client-disconnect aware
- Terminal fallback to OpenRouter's random free router; graceful degradation when /models is unavailable
- Ops endpoints: `/__sfr/healthz`, `/__sfr/stats`
- CLI: `sfr serve`, `sfr init`
- 121+ tests incl. full-ladder integration against a scripted mock upstream; CI matrix linux/macOS/windows × Node 20/22
