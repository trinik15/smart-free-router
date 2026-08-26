import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const { initHealth } = await import("../src/health.js")

const CFG = { cooldownSecs: 300, cooldownMaxSecs: 3600 }

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sfr-health-"))
}

function writeState(dir, obj) {
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(obj))
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))
}

test("failure creates a cooldown with exponential growth, capped", () => {
  const dir = tmpState()
  const h = initHealth({ cfg: CFG, stateDir: dir })
  h.failure("m1", "account429")
  let info = h.cooldownInfo("m1")
  assert.ok(info, "expected active cooldown")
  assert.ok(info.remainingMs > 250_000 && info.remainingMs <= 305_000, `got ${info.remainingMs}`)
  assert.equal(h.isHealthy("m1"), false)

  for (let i = 0; i < 12; i++) h.failure("m1", "account429")
  info = h.cooldownInfo("m1")
  assert.equal(info.fails, 10) // capped counter
  assert.ok(info.remainingMs <= 3_605_000 && info.remainingMs >= 3_500_000)
})

test("shared-pool 429 cools down shorter than account 429", () => {
  const dir = tmpState()
  const h = initHealth({ cfg: CFG, stateDir: dir })
  h.failure("shared", "shared429")
  h.failure("account", "account429")
  const s = h.cooldownInfo("shared").remainingMs
  const a = h.cooldownInfo("account").remainingMs
  assert.ok(s < a, `shared ${s} should be shorter than account ${a}`)
  assert.ok(s > 80_000 && s <= 95_000)
})

test("bandit needs MIN_N outcomes before bonuses apply", () => {
  const dir = tmpState()
  const h = initHealth({ cfg: CFG, stateDir: dir })
  const bandit = h.getBandit()
  for (let i = 0; i < 2; i++)
    h.recordOutcome({ category: "code", modelId: "m", ok: true, latencyMs: 100 })
  assert.equal(bandit("code", "m").bonus, 0)
  h.recordOutcome({ category: "code", modelId: "m", ok: true, latencyMs: 100 })
  assert.ok(bandit("code", "m").bonus > 0)
})

test("successes push bonus up, failures clamp it low", () => {
  const dir = tmpState()
  const h = initHealth({ cfg: CFG, stateDir: dir })
  const bandit = h.getBandit()
  for (let i = 0; i < 5; i++)
    h.recordOutcome({ category: "code", modelId: "good", ok: true, latencyMs: 500 })
  assert.ok(bandit("code", "good").bonus >= 1)
  for (let i = 0; i < 3; i++)
    h.recordOutcome({ category: "code", modelId: "bad", ok: false })
  assert.ok(bandit("code", "bad").bonus <= -5)
})

test("stale history decays toward neutral", () => {
  const dir = tmpState()
  const now = Date.now()
  writeState(dir, {
    v: 2,
    models: {
      "code|old": { rate: 0.43, n: 9, toolFails: 0, sumLat: 0, cntLat: 0, consecutiveFails: 0, updatedAt: now - 100 * 3600_000 },
      "code|fresh": { rate: 0.43, n: 9, toolFails: 0, sumLat: 0, cntLat: 0, consecutiveFails: 0, updatedAt: now },
    },
    cooldowns: {},
    sticky: {},
  })
  const h = initHealth({ cfg: CFG, stateDir: dir })
  const rateOld = h.getBandit()("code", "old").rate
  const rateFresh = h.getBandit()("code", "fresh").rate
  assert.ok(rateOld > rateFresh, "decayed rate should sit closer to neutral 0.7")
  assert.ok(rateOld > 0.43 && rateOld < 0.7)
})

test("sticky sessions expire after TTL", () => {
  const dir = tmpState()
  const now = Date.now()
  writeState(dir, {
    v: 2,
    models: {},
    cooldowns: {},
    sticky: { conv1: { model: "a", at: now - 31 * 60_000 }, conv2: { model: "b", at: now - 5 * 60_000 } },
  })
  const h = initHealth({ cfg: CFG, stateDir: dir })
  assert.equal(h.stickyGet("conv1"), null)
  assert.equal(h.stickyGet("conv2"), "b")
})

test("state persists across instances", () => {
  const dir = tmpState()
  const h1 = initHealth({ cfg: CFG, stateDir: dir })
  h1.failure("persisted", "error")
  const h2 = initHealth({ cfg: CFG, stateDir: dir })
  assert.equal(h2.isHealthy("persisted"), false)
})

test("concurrent writers merge; fresher evidence wins", () => {
  const dir = tmpState()
  const h = initHealth({ cfg: CFG, stateDir: dir })
  // simulate another instance having written while we were running
  writeState(dir, {
    v: 2,
    models: {},
    cooldowns: { "foreign/model": { until: Date.now() + 60_000, reason: "account429", fails: 1 } },
    sticky: {},
  })
  h.recordOutcome({ category: "code", modelId: "mine/model", ok: true, latencyMs: 50 })
  h.saveNow()
  const disk = readState(dir)
  assert.ok(disk.cooldowns["foreign/model"], "foreign cooldown must survive merge")
  assert.ok(disk.models["code|mine/model"], "local outcome must be written")

  const h2 = initHealth({ cfg: CFG, stateDir: dir })
  assert.equal(h2.isHealthy("foreign/model"), false)
})

test("clearFailures revives an actively cooling model (regression)", () => {
  const dir = tmpState()
  const h = initHealth({ cfg: CFG, stateDir: dir })
  h.failure("m", "error")
  assert.equal(h.isHealthy("m"), false)
  // model answered successfully while serving anyway ("all cooling down" path)
  h.clearFailures("m")
  assert.equal(h.isHealthy("m"), true, "success should lift the whole breaker, not just the fail count")
})
