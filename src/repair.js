// Best-effort repair of tool-call argument strings emitted by free models:
// code fences, trailing commas, and unclosed brackets. Conservative by design:
// anything not provably parseable after repair returns null so the caller can
// penalize the outcome instead of guessing.

export function repairToolArgs(raw) {
  if (raw === undefined || raw === null) return null
  let s = String(raw).trim()
  if (!s) return null

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s)
  if (fenced) s = fenced[1].trim()

  if (parses(s)) return s

  // trailing commas: {"a":1,} / [1,2,]
  const noTrailing = s.replace(/,(\s*[}\]])/g, "$1")
  if (parses(noTrailing)) return noTrailing

  // unclosed brackets/braces: close them in reverse order, respecting strings
  const closed = closeBrackets(noTrailing)
  if (closed !== null && parses(closed)) return closed

  return null
}

function parses(s) {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

function closeBrackets(s) {
  const pairs = { "{": "}", "[": "]" }
  const stack = []
  let inString = false
  let escaped = false
  for (const ch of s) {
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (pairs[ch]) stack.push(pairs[ch])
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null // mismatched: do not guess
    }
  }
  if (inString) return null // unterminated string: do not guess
  while (stack.length) s += stack.pop()
  return s
}
