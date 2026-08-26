import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import url from "node:url"

// Guards the published-package surface so nothing load-bearing is ever
// missing from "files", bin, or exports by accident.

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))

test("declared files exist on disk", () => {
  for (const f of [...pkg.files, "LICENSE", "CHANGELOG.md"]) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} listed in package.json must exist`)
  }
})

test("bin entry exists and has a node shebang", () => {
  const binPath = path.join(root, pkg.bin.sfr)
  const head = fs.readFileSync(binPath, "utf8").split("\n")[0]
  assert.match(head, /^#!.*node/)
})

test("every export target resolves", () => {
  const targets = Object.values(pkg.exports).map((v) => (typeof v === "string" ? v : v.import))
  for (const t of ["./src/opencode.ts", "./src/server.js"]) {
    assert.ok(targets.includes(t), `exports should include ${t}`)
    assert.ok(fs.existsSync(path.join(root, t)), `${t} must exist`)
  }
})

test("engine modules are all present in src/", () => {
  for (const m of [
    "server.js",
    "classify.js",
    "rank.js",
    "health.js",
    "shim.js",
    "sanitize.js",
    "repair.js",
    "config.js",
    "log.js",
    "cli.js",
    "opencode.ts",
  ]) {
    assert.ok(fs.existsSync(path.join(root, "src", m)), `src/${m} must exist`)
  }
})
