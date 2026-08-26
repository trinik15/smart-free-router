// Health & learning state: circuit breakers, cooldowns, bandit outcomes,
// session stickiness, disk persistence. All failure knowledge lives here so
// the router stops picking dead models across restarts.

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const NEUTRAL_RATE = 0.7 // bandit neutral point; below this, bonuses go negative
const ALPHA = 0.2 // EWMA weight per outcome
const MIN_N = 3 // outcomes before a model's history counts
const STICKY_TTL_MS = 30 * 60 * 1000
const PRUNE_AGE_MS = 14 * 24 * 3600 * 1000

// All live instances flush on shutdown (debounced saves die with short-lived processes)
const LIVE = new Set()
let HOOKS_INSTALLED = false
function installShutdownHooks() {
  if (HOOKS_INSTALLED) return
  HOOKS_INSTALLED = true
  const flushAll = () => {
    for (const h of LIVE) {
      try {
        h.__saveNow()
      } catch {}
    }
  }
  process.on("beforeExit", flushAll)
  process.on("exit", flushAll)
}

export function initHealth({ cfg, stateDir } = {}) {
  const dir = stateDir || process.env.SFR_STATE_DIR || path.join(os.homedir(), ".cache/opencode/sfr")
  const file = path.join(dir, "state.json")
  const now = () => Date.now()

  let models = {} // `${cat}|${modelId}` -> { rate,n,toolFails,sumLat,cntLat,consecutiveFails,updatedAt }
  let cooldowns = {} // modelId -> { until, reason, fails }
  let sticky = {} // key -> { model, at }

  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"))
      models = raw.models || {}
      cooldowns = raw.cooldowns || {}
      sticky = raw.sticky || {}
    } catch {
      models = {}; cooldowns = {}; sticky = {}
    }
    prune()
  }

  function prune() {
    const t = now()
    for (const k of Object.keys(models)) if (t - (models[k].updatedAt || 0) > PRUNE_AGE_MS) delete models[k]
    for (const k of Object.keys(cooldowns)) if ((cooldowns[k].until || 0) < t) delete cooldowns[k]
    for (const k of Object.keys(sticky)) if (t - (sticky[k].at || 0) > STICKY_TTL_MS) delete sticky[k]
  }

  let saveTimer = null
  function saveSoon() {
    if (saveTimer) return
    // NOT unref'd: short-lived processes (opencode run) must still flush,
    // and they may be SIGKILLed before any exit hook fires.
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveNow()
    }, 400)
  }

  function better(a, b) {
    // prefer fresher evidence when another instance wrote concurrently
    return (a?.updatedAt || a?.until || a?.at || 0) >= (b?.updatedAt || b?.until || b?.at || 0) ? a : b
  }

  function saveNow() {
    try {
      fs.mkdirSync(dir, { recursive: true })
      let merged = { v: 2, models, cooldowns, sticky }
      try {
        // merge with whatever is on disk: protects against multiple instances
        const disk = JSON.parse(fs.readFileSync(file, "utf8"))
        merged = {
          v: 2,
          models: { ...disk.models },
          cooldowns: { ...disk.cooldowns },
          sticky: { ...disk.sticky },
        }
        for (const k of Object.keys(models)) {
          const cur = better(models[k], merged.models[k])
          if (cur === models[k]) merged.models[k] = models[k]
        }
        for (const k of Object.keys(cooldowns)) {
          const cur = better(cooldowns[k], merged.cooldowns[k])
          if (cur === cooldowns[k]) merged.cooldowns[k] = cooldowns[k]
        }
        for (const k of Object.keys(sticky)) {
          const cur = better(sticky[k], merged.sticky[k])
          if (cur === sticky[k]) merged.sticky[k] = sticky[k]
        }
      } catch {}
      const tmp = file + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(merged))
      fs.renameSync(tmp, file)
    } catch {
      /* best effort */
    }
  }

  loadState()
  installShutdownHooks()

  // ---- cooldowns / breakers -------------------------------------------------
  function isHealthy(modelId) {
    const c = cooldowns[modelId]
    return !c || c.until <= now()
  }

  function failure(modelId, kind, retryAfterMs) {
    if (kind === "overflow") return // context overflow is our routing miss, not the model's fault
    const c = cooldowns[modelId] || { fails: 0, reason: "" }
    c.fails = Math.min((c.fails || 0) + 1, 10)
    let mult = 1
    if (kind === "shared429") mult = 0.3
    else if (kind === "error") mult = 0.6
    const backoff = Math.min(
      cfg.cooldownSecs * 1000 * mult * 2 ** (c.fails - 1),
      cfg.cooldownMaxSecs * 1000,
    )
    c.until = now() + Math.max(backoff, retryAfterMs || 0)
    c.reason = kind
    cooldowns[modelId] = c
    saveNow() // failures are rare and critical: persist immediately
  }

  function clearFailures(modelId) {
    const c = cooldowns[modelId]
    if (c) {
      c.fails = 0
      c.until = 0 // model proved itself while serving anyway; lift the whole breaker
    }
    saveSoon()
  }

  function cooldownInfo(modelId) {
    const c = cooldowns[modelId]
    return c && c.until > now() ? { remainingMs: c.until - now(), reason: c.reason, fails: c.fails } : null
  }

  // ---- bandit ----------------------------------------------------------------
  function key(cat, id) {
    return `${cat}|${id}`
  }

  function recordOutcome({ category, modelId, ok, latencyMs = 0, toolMalformed = false }) {
    const k = key(category, modelId)
    const e =
      models[k] ||
      (models[k] = { rate: NEUTRAL_RATE, n: 0, toolFails: 0, sumLat: 0, cntLat: 0, consecutiveFails: 0, updatedAt: 0 })
    e.n += 1
    e.rate = (1 - ALPHA) * e.rate + ALPHA * (ok ? 1 : 0)
    if (toolMalformed) e.toolFails += 1
    if (latencyMs > 0) {
      e.sumLat += latencyMs
      e.cntLat += 1
    }
    e.consecutiveFails = ok ? 0 : (e.consecutiveFails || 0) + 1
    e.updatedAt = now()
    saveSoon()
  }

  function decayedRate(e) {
    const hoursIdle = (now() - (e.updatedAt || 0)) / 3600000
    const d = 0.99 ** hoursIdle // slow drift back toward neutral when unused
    return NEUTRAL_RATE + (e.rate - NEUTRAL_RATE) * d
  }

  // returns { bonus } for ranker
  function getBandit() {
    return (cat, modelId) => {
      const e = models[key(cat, modelId)]
      if (!e || e.n < MIN_N) return { bonus: 0, n: e ? e.n : 0 }
      const rate = decayedRate(e)
      let bonus = Math.max(-6, Math.min(6, ((rate - 0.75) / 0.25) * 6))
      if (e.cntLat > 0) {
        const avgLat = e.sumLat / e.cntLat
        bonus += Math.max(-1.5, Math.min(1.5, ((5000 - avgLat) / 5000) * 2))
      }
      bonus -= Math.min(e.toolFails * 0.75, 3)
      return { bonus, n: e.n, rate }
    }
  }

  // ---- stickiness --------------------------------------------------------------
  function stickyKeyOf(hash) {
    return String(hash)
  }

  function stickyGet(keyHash) {
    const s = sticky[stickyKeyOf(keyHash)]
    if (!s || now() - s.at > STICKY_TTL_MS) return null
    return s.model
  }

  function stickySet(keyHash, model) {
    sticky[stickyKeyOf(keyHash)] = { model, at: now() }
    saveSoon()
  }

  function snapshot() {
    return structuredClone({ models, cooldowns, sticky })
  }

  const api = {
    isHealthy,
    failure,
    clearFailures,
    cooldownInfo,
    recordOutcome,
    getBandit,
    stickyGet,
    stickySet,
    saveNow,
    snapshot,
  }
  api.__saveNow = saveNow
  LIVE.add(api)
  return api
}
