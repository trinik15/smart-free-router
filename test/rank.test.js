import { test } from "node:test"
import assert from "node:assert/strict"
import { filterFreeModels, rankModels } from "../src/rank.js"

// above epsilon (0.15): never explores
const DETERMINISTIC = () => 0.99

const m = (over = {}) => ({
  id: "vendor/model:free",
  pricing: { prompt: "0", completion: "0" },
  context_length: 128000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools"],
  ...over,
})

const task = (over = {}) =>
  ({ category: "general", approxTokens: 1000, images: false, audio: false, needsTools: false, ...over })

test("keeps only free text-output models", () => {
  const kept = filterFreeModels([
    m({ id: "a/free" }),
    m({ id: "b/paid", pricing: { prompt: "0.001", completion: "0.002" } }),
    m({ id: "openrouter/auto" }),
    m({ id: "x/content-safety-guard" }),
    m({ id: "c/image-only", architecture: { output_modalities: ["image"] } }),
  ])
  assert.deepEqual(kept.map((k) => k.id), ["a/free"])
})

test("accepts zero prices written as floats (regression)", () => {
  const kept = filterFreeModels([
    m({ id: "a/free-float", pricing: { prompt: "0.0", completion: "0.000000" } }),
    m({ id: "b/almost-free", pricing: { prompt: "0.000001", completion: "0" } }),
  ])
  assert.deepEqual(kept.map((k) => k.id), ["a/free-float"])
})

test("ranks preferred models above unknown ones per category", () => {
  const models = [
    m({ id: "unknown/random:free", context_length: 64000 }),
    m({ id: "z-ai/glm-5:free" }),
    m({ id: "minimax/minimax-m3:free" }),
  ]
  const scored = rankModels(task({ category: "code" }), models, { rng: DETERMINISTIC })
  assert.equal(scored[0].id, "z-ai/glm-5:free")
  assert.equal(scored[1].id, "minimax/minimax-m3:free")
})

test("models whose context is too small are excluded when alternatives exist", () => {
  const models = [
    m({ id: "big/x:free", context_length: 200000 }),
    m({ id: "tiny/x:free", context_length: 2000 }),
  ]
  const scored = rankModels(task({ approxTokens: 5000 }), models)
  assert.deepEqual(scored.map((s) => s.id), ["big/x:free"])
})

test("degrades gracefully when every candidate fails filters", () => {
  const models = [m({ id: "tiny/x:free", context_length: 2000 })]
  const scored = rankModels(task({ approxTokens: 999999 }), models)
  assert.equal(scored.length, 1) // context filter ignored rather than empty result
})

test("excluded model substrings are dropped", () => {
  const scored = rankModels(task(), [m({ id: "liquid/lfm:free" })], {
    rng: DETERMINISTIC,
    cfg: { excludedModels: ["liquid/"] },
    rng: DETERMINISTIC,
  })
  assert.equal(scored.length, 0)
})

test("tool support bonus lifts tool-capable models", () => {
  const models = [
    m({ id: "aaa/no-tools:free", supported_parameters: [] }),
    m({ id: "zzz/tools:free", supported_parameters: ["tools"] }),
  ]
  const scored = rankModels(task({ needsTools: true, category: "general" }), models, { rng: DETERMINISTIC })
  assert.equal(scored[0].id, "zzz/tools:free")
})

test("pin forces a model to the front", () => {
  const models = [m({ id: "z-ai/glm-5:free" }), m({ id: "big/big:free" })]
  const scored = rankModels(task({ category: "code" }), models, {
    cfg: { pins: { code: "big/big" } },
    rng: DETERMINISTIC,
  })
  assert.equal(scored[0].id, "big/big:free")
})

test("exploration swaps top candidate with rng below epsilon", () => {
  const models = [m({ id: "z-ai/glm-5:free" }), m({ id: "minimax/minimax-m3:free" })]
  let calls = 0
  const rng = () => (calls++ === 0 ? 0 : 0.5) // explore=true, pick index 1+floor(.5*min(1,5))=1
  const scored = rankModels(task({ category: "code" }), models, { cfg: {}, rng })
  assert.equal(calls, 2)
  assert.equal(scored[0].id, "minimax/minimax-m3:free")
})

test("no exploration when rng above epsilon", () => {
  const models = [m({ id: "z-ai/glm-5:free" }), m({ id: "minimax/minimax-m3:free" })]
  const scored = rankModels(task({ category: "code" }), models, { cfg: {}, rng: () => 0.9 })
  assert.equal(scored[0].id, "z-ai/glm-5:free")
})

test("pinned model survives exploration (regression)", () => {
  const models = [m({ id: "z-ai/glm-5:free" }), m({ id: "minimax/minimax-m3:free" }), m({ id: "nvidia/nemotron-3-super:free" })]
  const rng = () => 0 // always explore
  const scored = rankModels(task({ category: "code" }), models, {
    cfg: { pins: { code: "glm" }, epsilon: 0.15 },
    rng,
  })
  assert.equal(scored[0].id, "z-ai/glm-5:free")
})
