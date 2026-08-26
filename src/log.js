// Leveled logger + JSONL decision audit for SFR.
// Quiet by default: only info+ to console. SFR_DEBUG=1 -> debug level.
// Decision audit always written (capped), so "why was X picked" is answerable.

import fs from "node:fs"
import path from "node:path"

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

let state = { level: "info", auditPath: null }

export function initLog({ level, cacheDir }) {
  if (process.env.SFR_DEBUG === "1") level = "debug"
  state.level = LEVELS[level] ?? LEVELS.info
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    state.auditPath = path.join(cacheDir, "decisions.jsonl")
    capAudit()
  } catch {
    state.auditPath = null // never let logging break routing
  }
}

function capAudit() {
  if (!state.auditPath) return
  try {
    const st = fs.statSync(state.auditPath)
    if (st.size > 2 * 1024 * 1024) fs.writeFileSync(state.auditPath, "")
  } catch {}
}

function emit(level, msg) {
  if ((LEVELS[level] ?? LEVELS.info) < state.level) return
  const line =
    level === "debug" ? `[sfr:debug] ${msg}` : level === "info" ? `[sfr] ${msg}` : `[sfr:${level}] ${msg}`
  ;(level === "error" ? console.error : console.log)(line)
}

export const log = {
  debug: (m) => emit("debug", m),
  info: (m) => emit("info", m),
  warn: (m) => emit("warn", m),
  error: (m) => emit("error", m),

  decision(obj) {
    if (!state.auditPath) return
    try {
      fs.appendFileSync(
        state.auditPath,
        JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n",
      )
    } catch {}
  },
}
