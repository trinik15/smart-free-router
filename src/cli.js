#!/usr/bin/env node
// SFR CLI: `sfr serve` starts the standalone proxy (any OpenAI-compatible
// client can point at it); `sfr init` verifies setup and prints config.
// Zero dependencies; Node >= 20.

import os from "node:os"
import path from "node:path"
import { loadConfig } from "./config.js"
import { initLog, log } from "./log.js"
import { initHealth } from "./health.js"
import { initRouter, ensureServer, dispose } from "./server.js"

const UPSTREAM = process.env.SFR_UPSTREAM || "https://openrouter.ai/api/v1"

const HELP = `
sfr — Smart Free Router

Usage:
  sfr serve     Start the proxy and print how to point tools at it
  sfr init      Verify setup (API key, upstream reachability) and print config
  sfr --help    This message

Env: OPENROUTER_API_KEY, SFR_UPSTREAM, SFR_PORT_BASE, SFR_DEBUG, SFR_DISABLE
`

async function cmdInit() {
  const hasKey = !!process.env.OPENROUTER_API_KEY
  console.log(`[sfr] API key: ${hasKey ? "found" : "MISSING — export OPENROUTER_API_KEY=sk-or-..."}`)
  if (!hasKey) {
    console.log("[sfr] get a free key at https://openrouter.ai/keys")
    process.exitCode = 1
    return
  }
  try {
    const res = await fetch(`${UPSTREAM}/models`, { headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const free = (json.data || []).filter(
      (m) => String(m.pricing?.prompt) === "0" && String(m.pricing?.completion) === "0",
    )
    console.log(`[sfr] upstream OK: ${free.length} free models available via ${UPSTREAM}`)
  } catch (e) {
    console.error(`[sfr] upstream unreachable (${e.message})`)
    process.exitCode = 1
    return
  }
  console.log(`
[sfr] Ready. For opencode, add to ~/.config/opencode/opencode.json:

  {
    "$schema": "https://opencode.ai/config.json",
    "model": "openrouter/openrouter/free",
    "plugin": ["smart-free-router"]
  }
`)
}

async function cmdServe() {
  const cfg = loadConfig()
  if (!cfg.enabled) {
    console.log("[sfr] disabled via config/env; nothing to do")
    return
  }
  initLog({ level: cfg.logLevel, cacheDir: `${os.homedir()}/.cache/opencode/sfr` })
  const health = initHealth({ cfg })
  initRouter({ cfg, health })
  let url
  try {
    url = await ensureServer()
  } catch (e) {
    console.error(`[sfr] failed to start: ${e.message}`)
    process.exitCode = 1
    return
  }
  console.log(`[sfr] proxy ready at ${url} (state: ${path.join(os.homedir(), ".cache", "opencode", "sfr")})`)
  console.log(`[sfr] stats: ${url.replace(/\/v1$/, "")}/__sfr/stats`)
  console.log(`
Point any OpenAI-compatible client at:
  base URL:  ${url}
  auth:      your OpenRouter key (passed through)

opencode (~/.config/opencode/opencode.json):
  { "model": "openrouter/openrouter/free", "plugin": ["smart-free-router"] }

aider:
  export OPENAI_API_BASE=${url}

Stop with Ctrl+C.`)
  process.on("SIGINT", async () => {
    log.info("shutting down")
    await dispose()
    process.exit(0)
  })
}

const cmd = process.argv[2]
if (cmd === "serve") await cmdServe()
else if (cmd === "init") await cmdInit()
else {
  console.log(HELP.trim())
  if (cmd && cmd !== "--help" && cmd !== "-h") process.exitCode = 1
}
