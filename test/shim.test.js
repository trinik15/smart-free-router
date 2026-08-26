import { test } from "node:test"
import assert from "node:assert/strict"
import { HARNESS_TAG, applyHarnessShim } from "../src/shim.js"

const msg = (role, content) => ({ role, content })
const tools = [{ type: "function", function: { name: "bash" } }]

test("injects a system message when none exists", () => {
  const body = { model: "openrouter/free", messages: [msg("user", "fix this bug in utils.py")] }
  const out = applyHarnessShim(body, "code")
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].role, "system")
  assert.ok(out.messages[0].content.includes(HARNESS_TAG))
})

test("prepends to an existing system message exactly once (idempotent)", () => {
  const body = {
    model: "openrouter/free",
    messages: [msg("system", "You are helpful."), msg("user", "list files"), msg("assistant", "a"), msg("user", "b")],
    tools,
  }
  const once = applyHarnessShim(body, "agent")
  const twice = applyHarnessShim(once, "agent")
  const occurrences = twice.messages[0].content.split(HARNESS_TAG).length - 1
  assert.equal(occurrences, 1, "sentinel must prevent duplicate injection")
})

test("agent category gets tool discipline section", () => {
  const body = { model: "openrouter/free", messages: [msg("user", "hi")] , tools }
  const out = applyHarnessShim(body, "agent")
  assert.match(out.messages[0].content, /tool/i)
})

test("reason category gets step-by-step section", () => {
  const body = { model: "openrouter/free", messages: [msg("user", "prove something")] }
  const out = applyHarnessShim(body, "reason")
  assert.match(out.messages[0].content, /step/i)
})

test("fast and vision categories are skipped entirely", () => {
  let out = applyHarnessShim({ messages: [msg("user", "hello")] }, "fast")
  assert.deepEqual(out.messages.map((m) => m.role), ["user"])
  out = applyHarnessShim({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }, "vision")
  assert.equal(out.messages.length, 1)
})

test("can be disabled via flag", () => {
  const out = applyHarnessShim({ messages: [msg("user", "fix bug")] }, "code", false)
  assert.equal(out.messages.length, 1)
})

test("array-content system messages gain a text part, not string mangling", () => {
  const body = {
    model: "smart-free",
    messages: [
      { role: "system", content: [{ type: "text", text: "base prompt" }] },
      msg("user", "do the task"),
    ],
  }
  const out = applyHarnessShim(body, "general")
  const sys = out.messages[0].content
  assert.ok(Array.isArray(sys))
  assert.equal(sys.length, 2)
  assert.ok(sys[0].text.includes(HARNESS_TAG))
})
