// Harness continuity shim: routed models are told they are continuing work
// that may have been produced by another model, and get discipline hints for
// the detected task category. Injection is idempotent via HARNESS_TAG so a
// client that replays history never accumulates duplicates.

export const HARNESS_TAG = "[sfr-harness]"

const BASE =
  "You are part of a resilient multi-model coding harness. Earlier turns in this conversation may have been produced by a different model; treat the full history as your own context and continue seamlessly without commenting on the switch."

const SECTIONS = {
  code: "When editing or writing code, output complete, syntactically correct code in fenced blocks with the correct language tag.",
  agent:
    "You have tools available. When you decide to use one, respond ONLY with a properly formatted tool_calls object whose function.arguments field is EXACTLY valid JSON - no prose around it.",
  reason: "Reason step by step before finalizing, and verify your own result once.",
}

function buildShim(category) {
  let text = `${HARNESS_TAG} ${BASE}`
  if (category === "code") text += ` ${SECTIONS.code}`
  else if (category === "agent") text += ` ${SECTIONS.agent}`
  else if (category === "reason") text += ` ${SECTIONS.reason}`
  return text
}

function hasTag(content) {
  if (typeof content === "string") return content.includes(HARNESS_TAG)
  if (Array.isArray(content)) return content.some((p) => p && typeof p.text === "string" && p.text.includes(HARNESS_TAG))
  return false
}

function prependToSystem(message, shim) {
  const content = message.content
  if (typeof content === "string") {
    message.content = `${shim}\n${content}`
  } else if (Array.isArray(content)) {
    message.content = [{ type: "text", text: shim }, ...content]
  } else {
    message.content = shim
  }
}

// body is mutated in place; returns the same body for convenience.
export function applyHarnessShim(body, category, enabled = true) {
  if (!enabled) return body
  if (category === "fast" || category === "vision") return body
  const messages = body.messages || []
  if (messages.some((m) => m.role === "system" && hasTag(m.content))) return body

  const shim = buildShim(category)
  const first = messages[0]
  if (first && first.role === "system") {
    prependToSystem(first, shim)
  } else {
    messages.unshift({ role: "system", content: shim })
    body.messages = messages
  }
  return body
}
