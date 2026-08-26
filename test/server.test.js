import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Env must be ready BEFORE importing server.js (it snapshots SFR_UPSTREAM at load).
process.env.SFR_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sfr-srv-state-"))
process.env.SFR_PORT_BASE = "43317"

const { createUpstream, json, sse, delay } = await import("./helpers/upstream.js")

const MODELS = [
  {
    id: "z-ai/glm-5:free",
    pricing: { prompt: "0", completion: "0" },
    context_length: 131072,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools"],
  },
  {
    id: "minimax/minimax-m3:free",
    pricing: { prompt: "0", completion: "0" },
    context_length: 1000000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools"],
  },
  {
    id: "nvidia/nemotron-3-ultra:free",
    pricing: { prompt: "0", completion: "0" },
    context_length: 262144,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools"],
  },
  {
    id: "google/gemma-4-26b:free",
    pricing: { prompt: "0", completion: "0" },
    context_length: 131072,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: [],
  },
  {
    id: "strict/no-params:free",
    pricing: { prompt: "0", completion: "0" },
    context_length: 262144,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: [],
  },
  {
    id: "full/kitchen-sink:free",
    pricing: { prompt: "0", completion: "0" },
    context_length: 262144,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools", "temperature", "top_p"],
  },
]

const handlers = {}
function resetHandlers() {
  for (const k of Object.keys(handlers)) delete handlers[k]
}

// Routing must be deterministic under test: disable epsilon exploration.
const REAL_RANDOM = Math.random
Math.random = () => 0.99

const upstream = await createUpstream({ models: MODELS, handlers })
process.env.SFR_UPSTREAM = upstream.url

const configMod = await import("../src/config.js")
const healthMod = await import("../src/health.js")
const serverMod = await import("../src/server.js")
const { HARNESS_TAG } = await import("../src/shim.js")

const BASE_CFG = { ...configMod.DEFAULTS, cacheTtlMin: 0.001 }

let portCounter = 0
function freshDeps(cfgOver = {}) {
  const cfg = { ...BASE_CFG, ...cfgOver }
  const health = healthMod.initHealth({ cfg, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "sfr-h-")) })
  serverMod.initRouter({ cfg, health })
  return { cfg, health }
}

const CODE_MESSAGES = [
  { role: "system", content: "You are a coding assistant." },
  { role: "user", content: "fix this bug:\n```\nundefined is not a function\n```" },
]

async function chat(body) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  return { status: res.status, parsed, text, contentType: res.headers.get("content-type") }
}

const echo = () => async (req, res, parsed) =>
  json(res, 200, { model: parsed.model, choices: [{ message: { role: "assistant", content: "ok" } }] })

freshDeps()
const baseUrl = await serverMod.ensureServer()

after(async () => {
  if (serverMod.dispose) await serverMod.dispose()
  await upstream.close()
})

test("explicit model choice passes through untouched", async () => {
  freshDeps()
  resetHandlers()
  handlers["vendor/custom-model"] = echo()
  upstream.seen.length = 0
  const r = await chat({ model: "vendor/custom-model", messages: CODE_MESSAGES })
  assert.equal(r.status, 200)
  assert.equal(r.parsed.model, "vendor/custom-model")
  assert.deepEqual(upstream.seen, ["vendor/custom-model"])
})

test("routed request goes to the top-ranked free model", async () => {
  freshDeps()
  resetHandlers()
  handlers["z-ai/glm-5:free"] = echo()
  upstream.seen.length = 0
  const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
  assert.equal(r.status, 200)
  assert.equal(r.parsed.model, "z-ai/glm-5:free")
})

test("500 on first choice fails over to next candidate", async () => {
  const { health } = freshDeps()
  resetHandlers()
  handlers["z-ai/glm-5:free"] = async (req, res) => json(res, 500, { error: { message: "boom" } })
  handlers["minimax/minimax-m3:free"] = echo()
  upstream.seen.length = 0
  const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
  assert.equal(r.status, 200)
  assert.equal(r.parsed.model, "minimax/minimax-m3:free")
  assert.deepEqual(upstream.seen.slice(0, 2), ["z-ai/glm-5:free", "minimax/minimax-m3:free"])
  assert.ok(health.cooldownInfo("z-ai/glm-5:free"), "failure must be remembered")
})

test("shared-pool 429 fails over and is classified distinctly", async () => {
  const { health } = freshDeps()
  resetHandlers()
  handlers["z-ai/glm-5:free"] = async (req, res) =>
    json(res, 429, { error: { message: "shared pool exhausted", metadata: { shared_pool: true } } })
  handlers["minimax/minimax-m3:free"] = echo()
  upstream.seen.length = 0
  const r = await chat({ model: "smart-free", messages: CODE_MESSAGES })
  assert.equal(r.status, 200)
  assert.equal(health.cooldownInfo("z-ai/glm-5:free").reason, "shared429")
})

test("context overflow reroutes to the largest-context candidate", async () => {
  freshDeps()
  resetHandlers()
  handlers["z-ai/glm-5:free"] = async (req, res) =>
    json(res, 400, { error: { message: "This model's maximum context length is 131072 tokens (context_length_exceeded)" } })
  handlers["minimax/minimax-m3:free"] = echo()
  upstream.seen.length = 0
  const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
  assert.equal(r.status, 200)
  assert.deepEqual(upstream.seen.slice(0, 2), ["z-ai/glm-5:free", "minimax/minimax-m3:free"])
})

test("exhausted candidates hit the terminal openrouter/free fallback, then 502", async () => {
  freshDeps({ maxAttempts: 2 })
  resetHandlers()
  handlers["*"] = async (req, res) => json(res, 500, { error: { message: "down" } })
  upstream.seen.length = 0
  const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
  assert.equal(r.status, 502)
  assert.match(r.text, /all candidates failed/)
  assert.equal(upstream.seen.at(-1), "openrouter/free")
  assert.ok(upstream.seen.length <= 3)
})

test("hung model is abandoned after the attempt timeout (regression)", async () => {
  freshDeps({ attemptTimeoutMs: 400 })
  resetHandlers()
  delete handlers["*"]
  handlers["z-ai/glm-5:free"] = async (req, res) => {
    await delay(4000)
    echo()(req, res, { model: "z-ai/glm-5:free" })
  }
  handlers["minimax/minimax-m3:free"] = echo()
  upstream.seen.length = 0
  const t0 = Date.now()
  const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
  const elapsed = Date.now() - t0
  assert.equal(r.status, 200, `expected quick success, got ${r.status}`)
  assert.ok(elapsed < 2500, `should not wait for hung model, took ${elapsed}ms`)
  assert.equal(r.parsed.model, "minimax/minimax-m3:free")
})

test("SSE streams are relayed with their content type", async () => {
  freshDeps()
  resetHandlers()
  const streamer = async (req, res) =>
    sse(res, [
      { choices: [{ delta: { content: "he" } }] },
      { choices: [{ delta: { content: "llo" } }] },
    ])
  handlers["z-ai/glm-5:free"] = streamer
  handlers["minimax/minimax-m3:free"] = streamer
  upstream.seen.length = 0
  const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
  assert.equal(r.status, 200)
  assert.match(String(r.contentType), /event-stream/)
  assert.match(r.text, /"he"/)
  assert.match(r.text, /"llo"/)
  assert.match(r.text, /\[DONE\]/)
})

test("GET /models is proxied through", async () => {
  freshDeps()
  resetHandlers()
  const res = await fetch(`${baseUrl}/models`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.data.length, MODELS.length)
})

test("malformed tool-call responses are relayed but penalized", async () => {
  const { health } = freshDeps()
  resetHandlers()
  handlers["z-ai/glm-5:free"] = async (req, res) =>
    json(res, 200, {
      model: "z-ai/glm-5:free",
      choices: [{ message: { role: "assistant", tool_calls: [{ function: { name: "bash", arguments: "{not-json" } }] } }],
    })
  upstream.seen.length = 0
  const r = await chat({
    model: "openrouter/free",
    messages: CODE_MESSAGES,
    tools: [{ type: "function", function: { name: "bash" } }],
  })
  assert.equal(r.status, 200, "client still receives the raw response")
  assert.match(r.text, /\{not-json/)
  const snap = health.snapshot()
  const entry = snap.models["code|z-ai/glm-5:free"]
  assert.ok(entry, "outcome should be recorded")
  assert.ok(entry.toolFails >= 1, "malformed tool call must be penalized")
})
test("repeated identical conversation sticks to the same model", async () => {
  const { health } = freshDeps()
  resetHandlers()
  handlers["z-ai/glm-5:free"] = echo()
  upstream.seen.length = 0
  const body = { model: "openrouter/free", messages: CODE_MESSAGES }
  const r1 = await chat(body)
  const r2 = await chat(body)
  assert.equal(r1.parsed.model, "z-ai/glm-5:free")
  assert.equal(r2.parsed.model, "z-ai/glm-5:free")
  assert.deepEqual(upstream.seen, ["z-ai/glm-5:free", "z-ai/glm-5:free"])
  // the router remembered this conversation's model
  const snapKeys = Object.keys(health.snapshot().sticky)
  assert.ok(snapKeys.length >= 1, "sticky state should exist for the conversation")
})

test("unsupported params are stripped per model before sending (harness)", async () => {
  const { health } = freshDeps({ pins: { code: "strict/no-params" } })
  resetHandlers()
  const captured = []
  handlers["strict/no-params:free"] = async (req, res, parsed) => {
    captured.push(parsed)
    json(res, 200, { model: parsed.model })
  }
  upstream.seen.length = 0
  const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES, temperature: 0.7, top_p: 0.9 })
  assert.equal(r.status, 200)
  assert.equal(upstream.seen[0], "strict/no-params:free")
  assert.equal(captured[0].temperature, undefined, "temperature must be stripped")
  assert.equal(captured[0].top_p, undefined, "top_p must be stripped")

  // a model that supports them keeps them
  freshDeps({ pins: { code: "full/kitchen-sink" } }).health
  resetHandlers()
  const kept = []
  handlers["full/kitchen-sink:free"] = async (req, res, parsed) => {
    kept.push(parsed)
    json(res, 200, { model: parsed.model })
  }
  upstream.seen.length = 0
  await chat({ model: "openrouter/free", messages: CODE_MESSAGES, temperature: 0.7, top_p: 0.9 })
  assert.equal(kept[0].temperature, 0.7)
  assert.equal(kept[0].top_p, 0.9)
  void health
})

test("harness shim injected exactly once on routed requests", async () => {
  freshDeps()
  resetHandlers()
  const captured = []
  handlers["z-ai/glm-5:free"] = async (req, res, parsed) => {
    captured.push(parsed)
    json(res, 200, { model: parsed.model })
  }
  const convo = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "list the files please" },
    { role: "assistant", content: "done" },
    { role: "user", content: "again please" },
  ]
  const body = { model: "openrouter/free", messages: structuredClone(convo), tools: [{ type: "function", function: { name: "bash" } }] }
  upstream.seen.length = 0
  await chat(structuredClone(body))
  await chat(structuredClone(body))
  assert.equal(captured.length, 2)
  for (const req of captured) {
    const tags = req.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).split(HARNESS_TAG).length - 1)
      .reduce((a, b) => a + b, 0)
    assert.equal(tags, 1, "exactly one harness tag per request")
  }
})

test("passthrough requests never get the shim", async () => {
  freshDeps()
  resetHandlers()
  const captured = []
  handlers["vendor/custom-model"] = async (req, res, parsed) => {
    captured.push(parsed)
    json(res, 200, { model: parsed.model })
  }
  await chat({ model: "vendor/custom-model", messages: CODE_MESSAGES })
  const all = JSON.stringify(captured[0].messages)
  assert.ok(!all.includes(HARNESS_TAG), "explicit model choice must not be touched")
})

test("fast category skips the shim", async () => {
  freshDeps()
  resetHandlers()
  const captured = []
  handlers["*"] = async (req, res, parsed) => {
    captured.push(parsed)
    json(res, 200, { model: parsed.model })
  }
  const r = await chat({ model: "openrouter/free", messages: [{ role: "user", content: "hello there friend" }] })
  assert.equal(r.status, 200)
  assert.ok(captured.length >= 1, "request must be served")
  assert.ok(!JSON.stringify(captured[0].messages).includes(HARNESS_TAG))
})

test("early stream error fails over before any byte is relayed", async () => {
  const { health } = freshDeps()
  resetHandlers()
  handlers["z-ai/glm-5:free"] = async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ error: { message: "model overloaded mid-stream-start" } })}\n\n`)
    res.end()
  }
  handlers["minimax/minimax-m3:free"] = async (req, res) =>
    sse(res, [
      { model: "minimax/minimax-m3:free", delta: "stream-ok" },
    ])
  upstream.seen.length = 0
  const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
  assert.equal(r.status, 200)
  assert.match(String(r.contentType), /event-stream/)
  assert.match(r.text, /stream-ok/)
  assert.ok(!r.text.includes("overloaded"), "error payload must never reach the client")
  assert.deepEqual(upstream.seen.slice(0, 2), ["z-ai/glm-5:free", "minimax/minimax-m3:free"])
  assert.ok(health.cooldownInfo("z-ai/glm-5:free"), "early stream error counts as failure")
})

test("premature stream end gets synthetic termination so clients never hang", async () => {
  freshDeps()
  resetHandlers()
  delete handlers["*"]
  handlers["z-ai/glm-5:free"] = async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`)
    await delay(80) // let the bytes flush like a real mid-stream death
    if (!res.writableEnded) res.destroy() // die without [DONE]
  }
  upstream.seen.length = 0
  const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
  assert.equal(r.status, 200)
  assert.match(r.text, /partial/)
  assert.match(r.text, /"error"/)
  assert.match(r.text, /\[DONE\]/)
})

test("/__sfr/stats and healthz expose operational state", async () => {
  freshDeps()
  resetHandlers()
  handlers["z-ai/glm-5:free"] = echo()
  await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
  const healthz = await fetch(`${baseUrl}/__sfr/healthz`)
  assert.equal(healthz.status, 200)
  assert.equal((await healthz.json()).ok, true)
  const stats = await (await fetch(`${baseUrl}/__sfr/stats`)).json()
  assert.ok(stats.routed >= 1)
  assert.equal(typeof stats.uptimeMs, "number")
  assert.ok(Array.isArray(stats.recentDecisions))
})

test("models outage degrades to terminal random router only", async () => {
  freshDeps()
  resetHandlers()
  handlers["*"] = echo()
  upstream.setModelsStatus(503)
  try {
    upstream.seen.length = 0
    await new Promise((r) => setTimeout(r, 150)) // let the model cache expire
    const r = await chat({ model: "openrouter/free", messages: CODE_MESSAGES })
    assert.equal(r.status, 200)
    assert.deepEqual(upstream.seen, ["openrouter/free"])
  } finally {
    upstream.setModelsStatus(200)
  }
})

test("cooled-down model is skipped on the next request", async () => {
  freshDeps()
  resetHandlers()
  handlers["z-ai/glm-5:free"] = async (req, res) => json(res, 500, { error: { message: "boom" } })
  handlers["minimax/minimax-m3:free"] = echo()
  const body = { model: "openrouter/free", messages: CODE_MESSAGES }
  const r1 = await chat(body)
  assert.equal(r1.status, 200)
  upstream.seen.length = 0
  const r2 = await chat(body)
  assert.equal(r2.status, 200)
  assert.ok(!upstream.seen.includes("z-ai/glm-5:free"), "cooled-down model must not be retried")
})
