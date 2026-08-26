import { test } from "node:test"
import assert from "node:assert/strict"
import { repairToolArgs } from "../src/repair.js"

const cases = [
  ['{"cmd":"ls"}', { cmd: "ls" }, "plain valid json"],
  ['```json\n{"a":1}\n```', { a: 1 }, "fenced json"],
  ['{"a":1,}', { a: 1 }, "trailing comma"],
  ['{"path":"/tmp/x", "size":12e}', null, "garbage stays garbage"],
  ['{"a":[1,2', { a: [1, 2] }, "unclosed array"],
  ['{"a":{"b":"c"', { a: { b: "c" } }, "unclosed nested object"],
  ['{"s":"has \\"escape\\" inside"}', { s: 'has "escape" inside' }, "escapes respected"],
  ['', null, "empty"],
  ['   ', null, "whitespace only"],
  ['not json at all', null, "bare words"],
]

for (const [input, expected, name] of cases) {
  test(`repairToolArgs: ${name}`, () => {
    const out = repairToolArgs(input)
    if (expected === null) {
      assert.equal(out, null, `expected failure for ${JSON.stringify(input)}`)
    } else {
      assert.deepEqual(JSON.parse(out), expected)
    }
  })
}

test("strings containing braces are not corrupted by balancing", () => {
  const out = repairToolArgs('{"code":"if (a) { return }"}')
  assert.deepEqual(JSON.parse(out), { code: "if (a) { return }" })
})
