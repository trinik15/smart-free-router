// SFR — Smart Free Router plugin entry for opencode.
//
// Routes openrouter/free (and a selectable virtual "smart-free" model) through
// a local proxy that picks the best free OpenRouter model per task, with
// health-aware failover, harness shims and self-learning rankings.
//
// Loaded by opencode directly from this npm package via:
//   { "plugin": ["smart-free-router"] }

import os from "node:os"
import { initLog, log } from "./log.js"
import { loadConfig } from "./config.js"
import { initHealth } from "./health.js"
import { initRouter, ensureServer } from "./server.js"

const VIRTUAL_MODEL_ID = "smart-free"

function virtualModel(providerId: string) {
  return {
    id: VIRTUAL_MODEL_ID,
    providerID: providerId,
    api: {
      id: VIRTUAL_MODEL_ID,
      url: "https://openrouter.ai/api/v1",
      npm: "@openrouter/ai-sdk-provider",
    },
    name: "Smart Free Router",
    family: "openrouter",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false as const,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, output: 16000 },
    status: "active" as const,
    options: {},
    headers: {},
    release_date: new Date().toISOString().slice(0, 10),
  }
}

export default async function sfrPlugin() {
  // The loader may evaluate this module more than once (auto-discovery + config
  // entry). Assemble the router exactly once per process via a global singleton.
  const g = globalThis as any
  if (g.__sfrPlugin) return g.__sfrPlugin
  g.__sfrPlugin = (async () => {
    const cfg = loadConfig()
    if (!cfg.enabled) {
      console.log("[sfr] disabled via config/env; passthrough mode")
      return {}
    }

    initLog({ level: cfg.logLevel, cacheDir: `${os.homedir()}/.cache/opencode/sfr` })
    const health = initHealth({ cfg })
    initRouter({ cfg, health })

    let url: string
    try {
      url = await ensureServer()
    } catch (e) {
      log.error(`not engaging: ${e}`)
      return {}
    }
    log.info(`ready (epsilon=${cfg.epsilon}, maxAttempts=${cfg.maxAttempts}, ${url})`)

    return {
      config: (cfgLive: any) => {
        cfgLive.provider = cfgLive.provider || {}
        const p = (cfgLive.provider.openrouter = cfgLive.provider.openrouter || {})
        p.options = p.options || {}
        // Only override when unset or previously set by us.
        if (!p.options.baseURL || String(p.options.baseURL).includes("127.0.0.1:431")) {
          p.options.baseURL = url
        }
      },
      provider: {
        id: "openrouter",
        models: async (provider: any) => ({
          ...provider.models,
          [VIRTUAL_MODEL_ID]: virtualModel("openrouter"),
        }),
      },
    }
  })()
  return g.__sfrPlugin
}

export { loadConfig, initHealth }
