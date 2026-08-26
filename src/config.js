// Layered configuration: defaults < global json < project json < env vars.
// Every field optional; missing files are fine. Zero-config works.

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export const DEFAULTS = Object.freeze({
  enabled: true,
  excludedModels: [], // model id substrings, e.g. ["liquid/", "dots-studio/"]
  pins: {}, // { category: "model-id-substring" }
  maxAttempts: 4,
  attemptTimeoutMs: 60000, // per-attempt ceiling until response headers arrive
  cooldownSecs: 300, // base cooldown after a failure
  cooldownMaxSecs: 3600,
  cacheTtlMin: 10, // free-model list refresh
  stickiness: true,
  harnessShim: true, // inject continuity/tool-discipline system prompt on routed requests
  epsilon: 0.15, // bandit exploration probability
  logLevel: "info",
})

// SFR_CONFIG_DIR exists so tests (and sandboxed setups) can redirect the
// global config location portably; os.homedir() alone ignores $HOME on Windows.
const GLOBAL_CFG = path.join(
  process.env.SFR_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode"),
  "smart-free-router.json",
)
const PROJECT_CFG = ".opencode/smart-free-router.json"

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (e) {
    if (e.code !== "ENOENT")
      console.error(`[sfr] ignoring unreadable config ${file}: ${e.message}`)
    return null
  }
}

function merge(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    if (k === "pins" && v && typeof v === "object" && !Array.isArray(v))
      out.pins = { ...out.pins, ...v }
    else out[k] = v
  }
  return out
}

export function loadConfig({ projectDir } = {}) {
  let cfg = { ...DEFAULTS }
  const g = readJson(GLOBAL_CFG)
  if (g) cfg = merge(cfg, g)
  const p = readJson(path.join(projectDir || process.cwd(), PROJECT_CFG))
  if (p) cfg = merge(cfg, p)

  // env overrides
  if (process.env.SFR_DISABLE === "1") cfg.enabled = false
  if (process.env.SFR_DEBUG === "1") cfg.logLevel = "debug"
  if (process.env.SFR_MAX_ATTEMPTS) cfg.maxAttempts = parseInt(process.env.SFR_MAX_ATTEMPTS) || cfg.maxAttempts
  if (process.env.SFR_ATTEMPT_TIMEOUT_MS)
    cfg.attemptTimeoutMs = parseInt(process.env.SFR_ATTEMPT_TIMEOUT_MS) || cfg.attemptTimeoutMs
  if (process.env.SFR_EPSILON !== undefined)
    cfg.epsilon = Math.min(Math.max(0, parseFloat(process.env.SFR_EPSILON) || 0), 0.9)

  // sanitize
  cfg.maxAttempts = Math.min(Math.max(1, cfg.maxAttempts | 0), 8)
  cfg.attemptTimeoutMs = Math.max(250, Number(cfg.attemptTimeoutMs) || DEFAULTS.attemptTimeoutMs)
  cfg.epsilon = Math.min(Math.max(0, Number(cfg.epsilon) || 0), 0.9)
  cfg.cacheTtlMin = Math.max(1, Number(cfg.cacheTtlMin) || DEFAULTS.cacheTtlMin)
  cfg.cooldownSecs = Math.max(5, Number(cfg.cooldownSecs) || DEFAULTS.cooldownSecs)
  cfg.cooldownMaxSecs = Math.max(cfg.cooldownSecs, Number(cfg.cooldownMaxSecs) || DEFAULTS.cooldownMaxSecs)
  if (!Array.isArray(cfg.excludedModels)) cfg.excludedModels = []
  if (typeof cfg.pins !== "object" || !cfg.pins) cfg.pins = {}
  cfg.harnessShim = cfg.harnessShim !== false
  return cfg
}
