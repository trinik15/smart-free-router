// Ranking: static priors (cold start) + learned bandit overlay + pins/exclusions.
// Deterministic given inputs; exploration randomness is injected via rng param
// so tests can be deterministic.

import { log } from "./log.js"

// Ordered preference lists; entries are substrings matched against model ids.
const PREFERENCE = {
  code: [
    "z-ai/glm",
    "minimax/minimax-m3",
    "nvidia/nemotron-3-ultra",
    "poolside/laguna-s",
    "cohere/north-mini-code",
    "minimax/minimax-m2",
    "nvidia/nemotron-3-super",
  ],
  agent: [
    "minimax/minimax-m3",
    "z-ai/glm",
    "nvidia/nemotron-3-super",
    "minimax/minimax-m2",
    "nvidia/nemotron-3-ultra",
  ],
  reason: [
    "nvidia/nemotron-3-ultra",
    "z-ai/glm",
    "minimax/minimax-m3",
    "thinkingmachines/inkling",
    "nvidia/nemotron-3-nano-omni",
    "nvidia/nemotron-3-super",
  ],
  vision: [
    "nvidia/nemotron-3-nano-omni",
    "google/gemma-4",
    "thinkingmachines/inkling",
    "minimax/minimax-m3",
  ],
  fast: [
    "nvidia/nemotron-3.5-lightning",
    "liquid/lfm",
    "google/gemma-4-26b",
    "cohere/north-mini-code",
    "dots-studio/dots-3-note",
  ],
  general: [
    "z-ai/glm",
    "minimax/minimax-m3",
    "nvidia/nemotron-3-super",
    "thinkingmachines/inkling",
    "google/gemma-4-31b",
    "nvidia/nemotron-3-ultra",
    "dots-studio/dots-3-note",
    "google/gemma-4-26b",
  ],
}

function isZeroPrice(v) {
  if (v === undefined || v === null) return false
  const n = Number(v)
  return !Number.isNaN(n) && n === 0
}

export function filterFreeModels(rawModels) {
  return (rawModels || []).filter((m) => {
    const pricing = m.pricing || {}
    if (!isZeroPrice(pricing.prompt) || !isZeroPrice(pricing.completion)) return false
    if (m.id.startsWith("openrouter/")) return false // routers/meta, never candidates
    if (/content-safety|guard|moderation/i.test(m.id)) return false
    const out = (m.architecture && m.architecture.output_modalities) || ["text"]
    if (!out.includes("text")) return false
    return true
  })
}

function prefIndex(list, id) {
  for (let i = 0; i < list.length; i++) if (id.includes(list[i])) return i
  return list.length
}

function passesFilters(m, task, excluded) {
  const ctxLen = m.context_length || m.top_provider?.context_length || 8192
  if (task.approxTokens > ctxLen * 0.9) return false
  const inp = (m.architecture && m.architecture.input_modalities) || ["text"]
  if (task.images && !inp.includes("image")) return false
  if (task.audio && !inp.includes("audio")) return false
  for (const ex of excluded) if (idMatches(m.id, ex)) return false
  return true
}

function idMatches(id, pattern) {
  return id.toLowerCase().includes(String(pattern).toLowerCase())
}

// models: filtered free models; bandit: health.getBandit(); cfg: config; rng: () -> [0,1)
export function rankModels(task, models, { bandit, cfg, rng } = {}) {
  if (!models.length) return []
  const cat = task.category
  const prefs = PREFERENCE[cat] || PREFERENCE.general
  const excluded = (cfg && cfg.excludedModels) || []

  let candidates = models.filter((m) => passesFilters(m, task, excluded))
  if (!candidates.length) {
    // degrade gracefully: ignore context/modality filters, keep exclusions
    candidates = models.filter((m) => {
      for (const ex of excluded) if (idMatches(m.id, ex)) return false
      const inp = (m.architecture && m.architecture.input_modalities) || ["text"]
      if ((task.images || task.audio) && !inp.includes(task.audio && !task.images ? "audio" : "image"))
        return false
      return true
    })
  }
  if (!candidates.length) return []

  const scored = candidates.map((m) => {
    const ctxLen = m.context_length || m.top_provider?.context_length || 8192
    const rank = prefs.length - prefIndex(prefs, m.id)
    const ctxBonus = Math.min(ctxLen / 100000, 3)
    const toolBonus =
      task.needsTools &&
      Array.isArray(m.supported_parameters) &&
      m.supported_parameters.includes("tools")
        ? 6
        : 0
    const learned = bandit ? bandit(cat, m.id) : { bonus: 0 }
    return { id: m.id, score: rank * 10 + ctxBonus + toolBonus + learned.bonus, ctxLen }
  })
  scored.sort((a, b) => b.score - a.score)

  // pin: force a pinned model for this category to the front (if present & eligible)
  const pin = cfg && cfg.pins && cfg.pins[cat]
  let pinnedAtTop = false
  if (pin) {
    const i = scored.findIndex((s) => idMatches(s.id, pin))
    if (i > 0) {
      const [pinned] = scored.splice(i, 1)
      scored.unshift(pinned)
    }
    pinnedAtTop = i !== -1 && !!scored[0] && idMatches(scored[0].id, pin)
  }

  // epsilon-greedy exploration: occasionally promote a random other candidate.
  // A pinned model holds slot 0 — exploration must not evict it.
  const epsilon = (cfg && cfg.epsilon) ?? 0.15
  const r = rng ? rng() : Math.random()
  if (scored.length > 1 && !pinnedAtTop && r < epsilon) {
    const j = 1 + Math.floor((rng ? rng() : Math.random()) * Math.min(scored.length - 1, 5))
    ;[scored[0], scored[j]] = [scored[j], scored[0]]
    log.debug(`explore: promoted ${scored[0].id} to slot 1`)
  }
  return scored
}
