// SFR proxy engine: intercepts openrouter/free requests, classifies the task,
// ranks live free models, applies harness aids (continuity shim, param
// sanitization, tool-arg repair), and fails over down the list — including
// before the first streamed byte. Everything else passes through untouched.

import http from "node:http"
import crypto from "node:crypto"
import { Readable } from "node:stream"
import { classifyTask } from "./classify.js"
import { filterFreeModels, rankModels } from "./rank.js"
import { applyHarnessShim } from "./shim.js"
import { sanitizeBodyForModel } from "./sanitize.js"
import { repairToolArgs } from "./repair.js"
import { log } from "./log.js"

const PORTS = [43117, 43118, 43119, 43120, 43121].map(
  (p, i) => (parseInt(process.env.SFR_PORT_BASE) || 0 ? parseInt(process.env.SFR_PORT_BASE) + i : p),
)
const ROUTER_MODEL_IDS = new Set(["openrouter/free", "openrouter/openrouter/free", "smart-free"])
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504])
const OVERFLOW_RE = /context_length_exceeded|maximum context length|context window|too many tokens|input.*exceed/i

const STREAM_SCAN_BYTES = 16384 // inspect at most this much before trusting the stream
const STREAM_SCAN_MS = 5000

const UPSTREAM = process.env.SFR_UPSTREAM || "https://openrouter.ai/api/v1"

let deps = null // { cfg, health }
let modelCache = { at: 0, models: [] }
let stats = null

function freshStats() {
  return {
    startedAt: Date.now(),
    routed: 0,
    passthrough: 0,
    failovers: 0,
    timeouts: 0,
    sanitizedParams: 0,
    repairs: 0,
    malformedResponses: 0,
    exhausted: 0,
    recentDecisions: [],
  }
}

function recordDecision(obj) {
  if (!stats) return
  stats.recentDecisions.push({ ts: new Date().toISOString(), ...obj })
  if (stats.recentDecisions.length > 20) stats.recentDecisions.shift()
  log.decision(obj)
}

async function fetchFreeModels() {
  const ttlMs = deps.cfg.cacheTtlMin * 60 * 1000
  if (modelCache.models.length && Date.now() - modelCache.at < ttlMs) return modelCache.models
  const res = await fetch(`${UPSTREAM}/models`, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`models fetch failed: ${res.status}`)
  const json = await res.json()
  const models = filterFreeModels(json.data)
  if (models.length) modelCache = { at: Date.now(), models }
  return models.length ? models : modelCache.models
}

function hashKey(str) {
  return crypto.createHash("md5").update(str).digest("hex")
}

function stickyKeyFor(body) {
  let sys = ""
  let firstUser = ""
  for (const m of body.messages || []) {
    if (m.role === "system") sys += typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    if (!firstUser && m.role === "user")
      firstUser = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
  }
  return hashKey(sys.slice(0, 2000) + "::" + firstUser.slice(0, 500))
}

// Fetch that gives up after timeoutMs until response headers arrive. Client
// disconnects propagate through externalSignal; streams are unaffected once
// headers land (timer is cleared).
function fetchWithTimeout(url, opts, timeoutMs, externalSignal) {
  const ctrl = new AbortController()
  let timedOut = false
  const onExternalAbort = () => ctrl.abort(externalSignal.reason)
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort()
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort(new Error(`attempt timeout after ${timeoutMs}ms`))
  }, timeoutMs)
  const cleanup = () => {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort)
  }
  const response = fetch(url, { ...opts, signal: ctrl.signal })
  // observe the outcome so the caller's await isn't the only handler
  response.then(cleanup, cleanup)
  return { response, timedOut: () => timedOut }
}

function pickHeaders(req) {
  const headers = { "content-type": "application/json", accept: req.headers.accept || "*/*" }
  if (req.headers["authorization"]) headers["authorization"] = req.headers["authorization"]
  if (req.headers["http-referer"]) headers["HTTP-Referer"] = req.headers["http-referer"]
  if (req.headers["x-title"]) headers["X-Title"] = req.headers["x-title"]
  return headers
}

// Passthrough streaming: no failover possible once bytes flow, so relay raw.
function relayPassthroughStream(res, up) {
  res.writeHead(200, { "content-type": up.headers.get("content-type") || "text/event-stream" })
  Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res)
  return true
}

// Routed streaming: peek at the head of the stream so an upstream that opens
// an SSE connection just to emit an error can be failed over for free.
// Returns { error } when the first event is an error object, else a reader
// positioned after the scanned bytes plus those bytes themselves.
async function scanStreamHead(up) {
  const reader = up.body.getReader()
  const head = []
  let size = 0
  const deadline = Date.now() + STREAM_SCAN_MS
  while (size < STREAM_SCAN_BYTES && Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    head.push(Buffer.from(value))
    size += value.byteLength
    const text = Buffer.concat(head).toString("utf8")
    const m = /data:\s*(\{[^\n]*\})/.exec(text)
    if (m) {
      try {
        const obj = JSON.parse(m[1])
        if (obj && obj.error) return { reader, head, error: obj.error }
      } catch {}
      return { reader, head, error: null }
    }
    if (text.includes("[DONE]")) return { reader, head, error: null }
  }
  return { reader, head, error: null }
}

// Pump the remainder of a scanned stream, guaranteeing the client sees a
// terminator: synthetic error+[DONE] when upstream dies mid-flight, so SDKs
// never hang waiting forever.
async function pumpStream(reader, res, contentType, head, isClientAborted) {
  res.writeHead(200, { "content-type": contentType || "text/event-stream" })
  let sawDone = false
  const write = (b) => {
    try {
      if (!res.writableEnded) res.write(b)
    } catch {}
  }
  for (const b of head) {
    if (!sawDone && b.toString("utf8").includes("[DONE]")) sawDone = true
    write(b)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      if (!sawDone && buf.toString("utf8").includes("[DONE]")) sawDone = true
      write(buf)
    }
  } catch {
    if (isClientAborted()) {
      res.destroy()
      return true // treat client-cancel as complete from our perspective
    }
  }
  if (!sawDone) {
    write(`data: ${JSON.stringify({ error: { message: "sfr: upstream stream ended prematurely" } })}\n\n`)
    write("data: [DONE]\n\n")
  }
  if (!res.writableEnded) res.end()
  return sawDone
}

// Inspect/repair tool_calls in a buffered JSON response. Mutates json.
// Returns { repairs, malformed }.
function processToolCalls(json) {
  let repairs = 0
  let malformed = 0
  const calls = json?.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(calls)) return { repairs, malformed }
  for (const tc of calls) {
    const raw = tc?.function?.arguments
    if (typeof raw !== "string") continue
    try {
      JSON.parse(raw)
      continue
    } catch {}
    const fixed = repairToolArgs(raw)
    if (fixed !== null) {
      tc.function.arguments = fixed
      repairs++
    } else {
      malformed++
    }
  }
  return { repairs, malformed }
}

async function handleChatCompletions(req, res, rawBody) {
  const t0 = Date.now()
  let body
  try {
    body = JSON.parse(rawBody.toString("utf8"))
  } catch {
    forward("/chat/completions", req, res, rawBody)
    return
  }

  if (!ROUTER_MODEL_IDS.has(body.model)) {
    stats.passthrough++
    forward("/chat/completions", req, res, rawBody) // explicit choice wins
    return
  }
  stats.routed++

  const { cfg, health } = deps
  const task = classifyTask({ messages: body.messages || [], tools: body.tools })
  const bandit = health.getBandit()

  let ranked
  let models = []
  try {
    models = await fetchFreeModels()
    ranked = rankModels(task, models, { bandit, cfg })
  } catch (e) {
    log.warn(`model list unavailable (${e.message}); using random router`)
  }
  const healthy = (ranked || []).filter((c) => health.isHealthy(c.id))
  if (ranked && healthy.length === 0 && ranked.length > 0)
    log.warn("all candidates cooling down; using them anyway in score order")

  // session stickiness: prefer the model already serving this conversation.
  // Computed BEFORE harness injection so keys stay stable across requests.
  const sKey = stickyKeyFor(body)
  const stickyModel = cfg.stickiness ? health.stickyGet(sKey) : null

  // harness continuity shim: one idempotent system-prompt injection per request
  applyHarnessShim(body, task.category, cfg.harnessShim !== false)

  const metaById = new Map(models.map((m) => [m.id, m]))

  let order = healthy.length ? healthy : ranked || []
  if (stickyModel) {
    const i = order.findIndex((c) => c.id === stickyModel)
    if (i > 0) {
      const [m] = order.splice(i, 1)
      order.unshift(m)
      log.debug(`sticky: keeping ${stickyModel} for this conversation`)
    }
  }

  const baseLog = {
    category: task.category,
    approxTokens: task.approxTokens,
    tools: task.needsTools,
    images: task.images,
    audio: task.audio,
    sticky: !!stickyModel,
  }

  let attemptIds = order.slice(0, cfg.maxAttempts).map((c) => c.id)
  attemptIds.push("openrouter/free") // terminal fallback: OpenRouter's own random router

  const abort = new AbortController()
  req.on("close", () => {
    if (!res.writableEnded) abort.abort()
  })

  let overflowHandled = false
  let bad400Retried = false
  let lastError = "no attempts made"
  const attemptTimeoutMs = deps.cfg.attemptTimeoutMs ?? 60000

  for (let i = 0; i < attemptIds.length; i++) {
    const modelId = attemptIds[i]
    const attemptT0 = Date.now()

    const { body: sendBody, removed } = sanitizeBodyForModel(
      { ...body, model: modelId },
      metaById.get(modelId),
    )
    if (removed.length) {
      stats.sanitizedParams += removed.length
      log.debug(`${modelId}: stripped unsupported params: ${removed.join(", ")}`)
    }

    let up
    let timedOut = () => false
    try {
      const r = fetchWithTimeout(
        `${UPSTREAM}/chat/completions`,
        {
          method: "POST",
          headers: pickHeaders(req),
          body: JSON.stringify(sendBody),
        },
        attemptTimeoutMs,
        abort.signal,
      )
      timedOut = r.timedOut
      up = await r.response
    } catch (e) {
      if (abort.signal.aborted && !timedOut()) return // client went away; not the model's fault
      lastError = timedOut() ? `${modelId}: timeout after ${attemptTimeoutMs}ms` : `${modelId}: ${e.message}`
      if (timedOut()) stats.timeouts++
      health.failure(modelId, "error")
      stats.failovers++
      log.info(`${lastError}; failing over`)
      continue
    }

    if (RETRY_STATUS.has(up.status)) {
      lastError = `${modelId}: HTTP ${up.status}`
      const ra = parseInt(up.headers.get("retry-after") || "") * 1000 || 0
      const shared = await isSharedPoolLimit(up)
      health.failure(modelId, shared.kind, ra || shared.retryHintMs)
      stats.failovers++
      log.info(`${lastError} (${shared.reason}); failing over`)
      recordDecision({ ...baseLog, picked: modelId, outcome: `retry:${up.status}`, ms: Date.now() - attemptT0 })
      continue
    }

    // context overflow: our sizing was wrong -> immediately try largest-context healthy candidate
    if (up.status === 400 && !overflowHandled) {
      const buf = Buffer.from(await up.arrayBuffer())
      if (OVERFLOW_RE.test(buf.toString("utf8").slice(0, 4000))) {
        overflowHandled = true
        lastError = `${modelId}: context overflow`
        const bigger = order
          .filter((c) => c.ctxLen > (ranked.find((x) => x.id === modelId)?.ctxLen || 0))
          .sort((a, b) => b.ctxLen - a.ctxLen)[0]
        if (bigger && !attemptIds.includes(bigger.id)) {
          attemptIds.splice(i + 1, 0, bigger.id)
          log.warn(`overflow on ${modelId}; rerouting to largest-context ${bigger.id} (${bigger.ctxLen} ctx)`)
        } else {
          log.warn(`overflow on ${modelId}; no larger candidate available`)
        }
        continue
      }
      // non-overflow 400: some free endpoints reject certain params -> allow exactly one retry
      if (!bad400Retried && i < attemptIds.length - 2) {
        bad400Retried = true
        lastError = `${modelId}: HTTP 400`
        log.info(`${lastError}; trying one alternate endpoint`)
        continue
      }
      relayBuffer(res, up.status, buf)
      recordDecision({ ...baseLog, picked: modelId, outcome: `http:${up.status}`, ms: Date.now() - attemptT0 })
      return
    }

    // ---- success paths ------------------------------------------------------
    const ms = () => Date.now() - attemptT0
    const isStream =
      up.status === 200 && (up.headers.get("content-type") || "").includes("event-stream") && up.body

    if (isStream) {
      let scan
      try {
        scan = await scanStreamHead(up)
      } catch (e) {
        // socket died before we could even inspect it: treat as attempt failure
        lastError = `${modelId}: stream scan failed (${e.message})`
        health.failure(modelId, "error")
        stats.failovers++
        log.info(`${lastError}; failing over`)
        recordDecision({ ...baseLog, picked: modelId, outcome: "stream-scan-error", ms: ms() })
        continue
      }
      if (scan.error) {
        lastError = `${modelId}: stream opened then errored (${scan.error.message || "unknown"})`
        health.failure(modelId, "error")
        stats.failovers++
        log.info(`${lastError}; failing over before first byte`)
        recordDecision({ ...baseLog, picked: modelId, outcome: "stream-error", ms: ms() })
        try {
          await scan.reader.cancel()
        } catch {}
        continue
      }
      const sawDone = await pumpStream(
        scan.reader,
        res,
        up.headers.get("content-type"),
        scan.head,
        () => abort.signal.aborted,
      )
      health.clearFailures(modelId)
      health.recordOutcome({
        category: task.category,
        modelId,
        ok: sawDone,
        latencyMs: ms(),
      })
      if (!stickyModel && cfg.stickiness) health.stickySet(sKey, modelId)
      recordDecision({
        ...baseLog,
        picked: modelId,
        outcome: sawDone ? "streaming" : "stream-truncated",
        ms: ms(),
      })
      return
    }

    const buf = Buffer.from(await up.arrayBuffer())
    let outBuf = buf
    let repairs = 0
    let malformedCalls = 0
    if (up.status === 200) {
      try {
        const parsed = JSON.parse(buf.toString("utf8"))
        const result = processToolCalls(parsed)
        repairs = result.repairs
        malformedCalls = result.malformed
        if (repairs > 0) outBuf = Buffer.from(JSON.stringify(parsed))
      } catch {}
    }
    relayBuffer(res, up.status, outBuf)

    if (up.status === 200) {
      stats.repairs += repairs
      if (malformedCalls > 0) stats.malformedResponses++
      health.clearFailures(modelId)
      health.recordOutcome({
        category: task.category,
        modelId,
        ok: malformedCalls === 0,
        latencyMs: ms(),
        toolMalformed: malformedCalls > 0,
      })
      if (malformedCalls === 0 && !stickyModel && cfg.stickiness) health.stickySet(sKey, modelId)
      recordDecision({
        ...baseLog,
        picked: modelId,
        outcome: "ok",
        ms: ms(),
        repairedArgs: repairs,
        malformedArgs: malformedCalls,
      })
    } else {
      recordDecision({ ...baseLog, picked: modelId, outcome: `http:${up.status}`, ms: ms() })
    }
    return
  }

  stats.exhausted++
  log.error(`all candidates failed (${lastError})`)
  recordDecision({ ...baseLog, picked: null, outcome: "exhausted", error: lastError })
  if (res.writableEnded) return
  res.writeHead(502, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message: `smart-free-router: all candidates failed (${lastError})` } }))
}

async function isSharedPoolLimit(up) {
  // peek at the small error body without losing it
  let kind = "error"
  let reason = "server error"
  try {
    const txt = await up.text()
    if (up.status === 429) {
      kind = /shared_pool|upstream_429|provider.*rate/i.test(txt) ? "shared429" : "account429"
      reason = kind === "shared429" ? "upstream shared-pool limit" : "account rate limit"
      const hint = /retry after (\d+)/i.exec(txt)
      return { kind, reason, retryHintMs: hint ? parseInt(hint[1]) * 1000 : 0 }
    }
    reason = `HTTP ${up.status}`
  } catch {}
  return { kind, reason, retryHintMs: 0 }
}

function relayBuffer(res, status, buf) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(buf)
}

function forward(path, req, res, rawBody) {
  fetch(`${UPSTREAM}${path}`, {
    method: req.method,
    headers: pickHeaders(req),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : rawBody,
  })
    .then(async (up) => {
      const isStream =
        up.status === 200 && (up.headers.get("content-type") || "").includes("event-stream")
      if (isStream && up.body) {
        relayPassthroughStream(res, up)
        return
      }
      const buf = Buffer.from(await up.arrayBuffer())
      relayBuffer(res, up.status, buf)
    })
    .catch((e) => {
      if (!res.writableEnded) {
        res.writeHead(502, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: `smart-free-router upstream error: ${e}` } }))
      }
    })
}

function handleOpsEndpoint(pathName, res) {
  if (pathName === "/__sfr/healthz") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
    return true
  }
  if (pathName === "/__sfr/stats") {
    const snap = deps && deps.health ? deps.health.snapshot() : { cooldowns: {} }
    const cooldowns = {}
    for (const [k, v] of Object.entries(snap.cooldowns || {}))
      cooldowns[k] = { remainingSecs: Math.max(0, Math.round(((v.until || 0) - Date.now()) / 1000)), reason: v.reason, fails: v.fails }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        ...(stats || freshStats()),
        uptimeMs: Date.now() - ((stats && stats.startedAt) || Date.now()),
        cooldowns,
        modelsCached: modelCache.models.length,
      }),
    )
    return true
  }
  return false
}

function requestHandler(req, res) {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks)
    let pathName = req.url || "/"
    if (pathName.startsWith("/v1/")) pathName = pathName.slice(3)

    if (req.method === "GET" && pathName.startsWith("/__sfr/")) {
      handleOpsEndpoint(pathName, res)
      return
    }

    if (
      req.method === "POST" &&
      (pathName === "/chat/completions" || pathName === "/completions" || pathName === "/messages")
    ) {
      handleChatCompletions(req, res, rawBody).catch((e) => {
        log.error(`handler crash: ${e.stack || e}`)
        if (!res.writableEnded) {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: { message: String(e) } }))
        }
      })
      return
    }
    forward(pathName, req, res, rawBody)
  })
  req.on("error", () => res.destroy())
}

export function initRouter({ cfg, health }) {
  deps = { cfg, health }
  stats = freshStats()
}

export function getDeps() {
  return deps
}

let serverPromise = null
let baseUrl = null

export function ensureServer() {
  if (baseUrl) return Promise.resolve(baseUrl)
  if (serverPromise) return serverPromise
  serverPromise = new Promise((resolve, reject) => {
    const tryListen = (i) => {
      if (i >= PORTS.length) return reject(new Error("no free port"))
      const srv = http.createServer(requestHandler)
      srv.on("error", () => tryListen(i + 1))
      srv.listen(PORTS[i], "127.0.0.1", () => {
        currentServer = srv
        baseUrl = `http://127.0.0.1:${PORTS[i]}/v1`
        log.info(`proxy listening on ${baseUrl}`)
        resolve(baseUrl)
      })
    }
    tryListen(0)
  }).catch((e) => {
    serverPromise = null
    throw e
  })
  return serverPromise
}

let currentServer = null

// Test/teardown hook: stop the proxy and forget singleton state.
export async function dispose() {
  const srv = currentServer
  currentServer = null
  baseUrl = null
  serverPromise = null
  if (srv) await new Promise((r) => srv.close(r))
}
