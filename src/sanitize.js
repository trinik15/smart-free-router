// Per-model request sanitization driven by live OpenRouter metadata.
// Sending params a model doesn't support is a guaranteed 400; stripping them
// converts wasted attempts into working ones.

const STRIPPABLE_PARAMS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "seed",
  "stop",
  "response_format",
  "reasoning_effort",
]

const TOOL_PARAMS = ["tools", "tool_choice", "parallel_tool_calls"]

function supportedSet(modelMeta) {
  const sp = modelMeta && modelMeta.supported_parameters
  if (!Array.isArray(sp)) return null // unknown metadata -> trust the caller
  return new Set(sp)
}

// Returns { body, removed: string[] }; input body is never mutated.
export function sanitizeBodyForModel(body, modelMeta) {
  const allowed = supportedSet(modelMeta)
  if (!allowed) return { body, removed: [] }

  const out = { ...body }
  const removed = []
  for (const key of STRIPPABLE_PARAMS) {
    if (out[key] !== undefined && !allowed.has(key)) {
      delete out[key]
      removed.push(key)
    }
  }
  if (allowed.has("tools")) {
    if (out.tools !== undefined && !Array.isArray(out.tools)) {
      delete out.tools // malformed tools field would 400 anyway
      removed.push("tools")
    }
  } else {
    for (const key of TOOL_PARAMS) {
      if (out[key] !== undefined) {
        delete out[key]
        removed.push(key)
      }
    }
  }
  return { body: out, removed }
}
