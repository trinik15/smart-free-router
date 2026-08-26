import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyTask } from "../src/classify.js"

const msg = (role, content) => ({ role, content })

test("classifies code from fenced blocks and keywords", () => {
  let t = classifyTask({ messages: [msg("user", "here:\n```\nfoo()\n```")] })
  assert.equal(t.category, "code")
  t = classifyTask({ messages: [msg("user", "write a function that sorts")] })
  assert.equal(t.category, "code")
})

test("detects common file extensions as code", () => {
  const t = classifyTask({ messages: [msg("user", "please fix utils.py for me")] })
  assert.equal(t.category, "code")
})

test("does not treat plain abbreviations or urls as code", () => {
  // regression: the old /\.\w{1,4}\b/ matched ".com", ".s." etc.
  let t = classifyTask({ messages: [msg("user", "visit example.com please")] })
  assert.notEqual(t.category, "code")
  t = classifyTask({ messages: [msg("user", "news in the u.s. today?")] })
  assert.notEqual(t.category, "code")
})

test("classifies reasoning prompts", () => {
  const t = classifyTask({
    messages: [msg("user", "prove that the square root of 2 is irrational")],
  })
  assert.equal(t.category, "reason")
})

test("short prompt with no signal defaults to fast", () => {
  const t = classifyTask({ messages: [msg("user", "hi there")] })
  assert.equal(t.category, "fast")
})

test("tools upgrade fast/general to agent", () => {
  let t = classifyTask({ messages: [msg("user", "hello")], tools: [{ name: "bash" }] })
  assert.equal(t.category, "agent")
  t = classifyTask({ messages: [msg("user", "tell me about cats")], tools: [{ name: "search" }] })
  assert.equal(t.category, "agent")
})

test("image parts classify as vision", () => {
  const t = classifyTask({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
        ],
      },
    ],
  })
  assert.equal(t.category, "vision")
  assert.equal(t.images, true)
})

test("plan-agent system prompt biases to reason", () => {
  const t = classifyTask({
    messages: [
      msg("system", "You are in planning mode. Produce an implementation plan. Do not make any edits."),
      msg("user", "add a login page"),
    ],
  })
  assert.equal(t.category, "reason")
})

test("very long conversations fall back to general", () => {
  const long = "lorem ipsum dolor sit amet ".repeat(2200) // ~57k chars
  const t = classifyTask({ messages: [msg("user", long)] })
  assert.equal(t.category, "general")
  assert.ok(t.totalChars > 48000)
})

test("approxTokens is chars/4 rounded up, plus per-message overhead", () => {
  const t = classifyTask({ messages: [msg("user", "abcd".repeat(10))] })
  assert.equal(t.approxTokens, Math.ceil((40 + 1) / 4))
})
