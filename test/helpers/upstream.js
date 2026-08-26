// Shared mock OpenRouter upstream for SFR integration tests.
// Handlers are keyed by requested model id and get full control of the response.

import http from "node:http"

export function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body)
}

export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write("data: [DONE]\n\n")
  res.end()
}

// handlers: { [modelId]: async (req, res, parsedBody) => void }
// "*" matches any model without a specific handler.
// modelsStatus/modelsBody override the /models response (e.g. to simulate outage).
export function createUpstream({ models = [], handlers = {}, modelsStatus = 200, modelsBody = null } = {}) {
  const seen = [] // every model id the upstream was asked for, in order
  const modelsState = { status: modelsStatus, body: modelsBody }

  const setModelsStatus = (status) => {
    modelsState.status = status
  }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks)

    if (req.method === "GET" && req.url.endsWith("/models")) {
      if (modelsState.status !== 200)
        return json(res, modelsState.status, modelsState.body || { error: { message: "models unavailable" } })
      return json(res, 200, modelsState.body || { data: models })
    }
    if (req.method === "POST" && /\/(chat\/completions|completions|messages)$/.test(req.url)) {
      let parsed = {}
      try { parsed = JSON.parse(raw.toString("utf8")) } catch {}
      const modelId = parsed.model || "unknown"
      seen.push(modelId)
      const h = handlers[modelId] ?? handlers["*"]
      if (!h) return json(res, 500, { error: { message: `no handler for ${modelId}` } })
      try {
        await h(req, res, parsed)
      } catch {
        try { res.destroy() } catch {}
      }
      return
    }
    json(res, 404, { error: { message: "not found" } })
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        seen,
        setModelsStatus,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
