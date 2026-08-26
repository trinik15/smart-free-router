import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Redirect the global config dir BEFORE importing config.js (path is computed
// at module load). SFR_CONFIG_DIR works on every OS, unlike $HOME.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sfr-home-"))
process.env.SFR_CONFIG_DIR = fakeHome

const { loadConfig } = await import("../src/config.js")

test("defaults apply when no config files exist", () => {
  const cfg = loadConfig({ projectDir: path.join(fakeHome, "empty-project") })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.epsilon, 0.15)
  assert.equal(cfg.maxAttempts, 4)
  assert.deepEqual(cfg.excludedModels, [])
})

test("global config overrides defaults", () => {
  const dir = fakeHome // SFR_CONFIG_DIR points directly at the config dir
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "smart-free-router.json"),
    JSON.stringify({ epsilon: 0.3, excludedModels: ["liquid/"] }),
  )
  const cfg = loadConfig({ projectDir: path.join(fakeHome, "empty-project") })
  assert.equal(cfg.epsilon, 0.3)
  assert.deepEqual(cfg.excludedModels, ["liquid/"])
})

test("project config overrides global config", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "sfr-proj-"))
  fs.mkdirSync(path.join(proj, ".opencode"), { recursive: true })
  fs.writeFileSync(path.join(proj, ".opencode", "smart-free-router.json"), JSON.stringify({ maxAttempts: 6 }))
  const cfg = loadConfig({ projectDir: proj })
  assert.equal(cfg.maxAttempts, 6)
  assert.equal(cfg.epsilon, 0.3) // still from global
})

test("pins are merged, not replaced", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "sfr-proj2-"))
  fs.mkdirSync(path.join(proj, ".opencode"), { recursive: true })
  fs.writeFileSync(
    path.join(proj, ".opencode", "smart-free-router.json"),
    JSON.stringify({ pins: { fast: "lightning" } }),
  )
  const cfg = loadConfig({ projectDir: proj })
  assert.equal(cfg.pins.fast, "lightning")
  delete cfg.pins.fast
  // global had no pins yet; add one and confirm merge semantics
  const gdir = fakeHome
  fs.writeFileSync(
    path.join(gdir, "smart-free-router.json"),
    JSON.stringify({ pins: { code: "glm" } }),
  )
  const cfg2 = loadConfig({ projectDir: proj })
  assert.equal(cfg2.pins.code, "glm")
  assert.equal(cfg2.pins.fast, "lightning")
})

test("env overrides win and are clamped", () => {
  process.env.SFR_DISABLE = "1"
  process.env.SFR_DEBUG = "1"
  process.env.SFR_MAX_ATTEMPTS = "99"
  process.env.SFR_EPSILON = "5"
  try {
    const cfg = loadConfig({ projectDir: path.join(fakeHome, "empty-project") })
    assert.equal(cfg.enabled, false)
    assert.equal(cfg.logLevel, "debug")
    assert.equal(cfg.maxAttempts, 8) // clamped to max
    assert.equal(cfg.epsilon, 0.9) // clamped to max
  } finally {
    delete process.env.SFR_DISABLE
    delete process.env.SFR_DEBUG
    delete process.env.SFR_MAX_ATTEMPTS
    delete process.env.SFR_EPSILON
  }
})

test("nonsense values are sanitized", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "sfr-proj3-"))
  fs.mkdirSync(path.join(proj, ".opencode"), { recursive: true })
  fs.writeFileSync(
    path.join(proj, ".opencode", "smart-free-router.json"),
    JSON.stringify({
      maxAttempts: -3,
      epsilon: "not-a-number",
      cooldownMaxSecs: 1,
      excludedModels: "oops",
      pins: "nope",
    }),
  )
  const cfg = loadConfig({ projectDir: proj })
  assert.equal(cfg.maxAttempts, 1)
  assert.equal(cfg.epsilon, 0)
  assert.ok(cfg.cooldownMaxSecs >= cfg.cooldownSecs)
  assert.deepEqual(cfg.excludedModels, [])
  assert.deepEqual(cfg.pins, {})
})
