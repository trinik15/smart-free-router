// Task classification: fast regex/heuristic pass over the conversation.
// No LLM calls, no latency. Output feeds the ranker.

// Known source/config file extensions; avoids false "code" hits like ".com" or "u.s."
const FILE_EXT_SRC =
  "\\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|json|ya?ml|toml|ini|html|css|scss|vue|svelte|lua|r|jl|hs|ex|exs|erl|dart|scala|pl|pm)\\b"

const CODE_RE = new RegExp(
  "```|\\b(function|class|def |const |let |var |import |export |npm |pip |cargo |git |error|exception|traceback|stack ?trace|bug|debug|refactor|compile|runtime|typescript|javascript|python|rust|golang|java|sql|regex|api endpoint)\\b|" +
    FILE_EXT_SRC,
  "i",
)
const REASON_RE =
  /\b(prove|proof|theorem|solve|derivation|derive|calculate|compute|equation|integral|probability|logic|riddle|puzzle|step[- ]by[- ]step|analy[sz]e|compare|trade[- ]offs?|strategy)\b|(\d+\s*[+\-*/^]\s*\d+)/i
// opencode's plan agent produces distinctive planning language in the system prompt
const PLAN_SYS_RE = /\b(planning (mode|agent)|strategic plan|implementation plan|do not make any edits?)\b/i

export const LONG_CHARS = 48000 // ~12k tokens
const SHORT_CHARS = 160

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .filter((p) => p && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ")
  return ""
}

function modalityOf(content) {
  const found = new Set()
  if (!Array.isArray(content)) return found
  for (const p of content) {
    if (!p || typeof p !== "object") continue
    if (["image_url", "image", "input_image", "file"].includes(p.type)) found.add("image")
    if (p.type === "input_audio" || p.type === "audio") found.add("audio")
  }
  return found
}

// ctx: { messages, tools }
export function classifyTask(ctx) {
  const messages = ctx.messages || []
  const tools = ctx.tools || []
  let all = ""
  let lastUser = ""
  let system = ""
  let totalChars = 0
  const modalities = new Set()

  for (const m of messages) {
    const t = textOf(m.content)
    totalChars += t.length + (t ? 1 : 0) // +1 ≈ per-message delimiter overhead
    all += t + "\n"
    for (const mod of modalityOf(m.content)) modalities.add(mod)
    if (m.role === "user") lastUser = t
    else if (m.role === "system") system += t + "\n"
  }

  let category = "general"
  const codeish = CODE_RE.test(all)
  const reasonish = REASON_RE.test(all)
  if (codeish) category = "code"
  else if (reasonish) category = "reason"

  // short prompts that carry no signal default to fast; plan-agent bias to reason
  if (!codeish && !reasonish && lastUser && lastUser.length < SHORT_CHARS) category = "fast"
  if (!codeish && PLAN_SYS_RE.test(system)) category = "reason"

  const needsTools = Array.isArray(tools) && tools.length > 0
  if (totalChars > LONG_CHARS) category = "general" // long-context: capability matters most, ctx filter does the work
  if (modalities.has("image") || modalities.has("audio")) category = "vision"
  if (needsTools && (category === "fast" || category === "general")) category = "agent"

  return {
    category,
    images: modalities.has("image"),
    audio: modalities.has("audio"),
    needsTools,
    totalChars,
    approxTokens: Math.ceil(totalChars / 4),
  }
}
