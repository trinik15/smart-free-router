import { test } from "node:test"
import assert from "node:assert/strict"
import { sanitizeBodyForModel } from "../src/sanitize.js"

const meta = (supported) => ({ id: "x", supported_parameters: supported })

test("strips params a model does not support, keeps the rest", () => {
  const body = { model: "m", temperature: 0.7, top_p: 0.9, messages: [{ role: "user", content: "hi" }] }
  const { body: out, removed } = sanitizeBodyForModel(body, meta(["temperature"]))
  assert.equal(out.temperature, 0.7)
  assert.equal(out.top_p, undefined)
  assert.deepEqual(removed, ["top_p"])
})

test("drops tools and tool_choice when tools are unsupported", () => {
  const body = {
    model: "m",
    tools: [{ type: "function", function: { name: "bash" } }],
    tool_choice: "auto",
    messages: [],
  }
  const { body: out, removed } = sanitizeBodyForModel(body, meta(["temperature"]))
  assert.equal(out.tools, undefined)
  assert.equal(out.tool_choice, undefined)
  assert.ok(removed.includes("tools"))
})

test("keeps everything when the model supports it all", () => {
  const body = { model: "m", temperature: 1, tools: [], messages: [] }
  const { body: out, removed } = sanitizeBodyForModel(body, meta(["temperature", "tools"]))
  assert.equal(out.temperature, 1)
  assert.deepEqual(removed, [])
})

test("unknown metadata means trust the caller (no stripping)", () => {
  for (const badMeta of [null, undefined, {}, { supported_parameters: null }]) {
    const body = { model: "m", temperature: 0.3, tools: [{}], messages: [] }
    const { body: out, removed } = sanitizeBodyForModel(body, badMeta)
    assert.equal(out.temperature, 0.3)
    assert.deepEqual(removed, [])
  }
})

test("does not mutate the input body", () => {
  const body = { model: "m", top_p: 0.5, messages: [] }
  sanitizeBodyForModel(body, meta([]))
  assert.equal(body.top_p, 0.5)
})
