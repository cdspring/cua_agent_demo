// A1, part 1: make the harness-convergence problem measurable before fixing it.
//
// The honest question is not "does a script import cua-client" but "does this
// script talk to the driver over MCP, and if so does it go through the shared
// client". A script that shells out to `cua-driver call` or `list-tools`, or that
// only reads files, does not need the harness and should not be counted against
// convergence.
//
// What migrating actually buys, stated plainly so this is not busywork:
//
//   * fresh()/freshUntil() make one-use token reuse impossible to express. That
//     bug produced four wrong answers across this project, including two FALSE
//     PASSES in the policy tests where a stale_element_token refusal was scored
//     as the policy working.
//   * call() returns a normalised `refusals{}` map, so assertions match codes
//     instead of prose. Matching /pattern/i against a success message matched the
//     "Pattern" inside "ValuePattern" and produced another false PASS.
//
// So: classify by transport, count MCP scripts not using the harness, and report.
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { SUITES, SCRIPT_DIR, LOW_LEVEL_EXEMPT } from "./lib/suites.mjs"

function transport(file) {
  const t = readFileSync(file, "utf8")
  const usesHarness = /from\s+["'][^"']*lib\/cua-client\.mjs["']/.test(t)
  if (usesHarness) return { kind: "mcp", viaHarness: true }
  // This checker quotes both "mcp" and "jsonrpc" in its own source, so it would
  // classify itself as an un-converged MCP script. Exclude it explicitly rather
  // than let a self-detection artifact inflate the count it is reporting on.
  if (file.endsWith("check-convergence.mjs")) return { kind: "none", viaHarness: false }
  if (/\bmcp\b/.test(t) && /jsonrpc/.test(t)) return { kind: "mcp", viaHarness: false }
  if (/cua-driver[^\n]*\bcall\b|["']call["']/.test(t)) return { kind: "cli", viaHarness: false }
  if (/execFileSync|spawnSync/.test(t)) return { kind: "cli", viaHarness: false }
  return { kind: "none", viaHarness: false }
}

const rows = []
for (const s of SUITES) {
  const p = join(SCRIPT_DIR, s.script)
  if (!existsSync(p)) {
    rows.push({ ...s, kind: "MISSING", viaHarness: false, exempt: false })
    continue
  }
  const tr = transport(p)
  // An exemption only applies if the script really would otherwise be counted as
  // an un-converged MCP script. Exempting something already converged, or exempting
  // a file that never talked MCP, would quietly inflate the headline number.
  const exempt = !tr.viaHarness && tr.kind === "mcp" && !!LOW_LEVEL_EXEMPT[s.script]
  rows.push({ ...s, kind: tr.kind, viaHarness: tr.viaHarness, exempt })
}

// Anything in scripts/ that the registry does not mention is unclassified drift.
const registered = new Set(SUITES.map((s) => s.script))
const loose = readdirSync(SCRIPT_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => !registered.has(f))
  .filter((f) => f !== "verify-all.mjs")

const mcpScripts = rows.filter((r) => r.kind === "mcp")
const converged = mcpScripts.filter((r) => r.viaHarness)
const exempt = mcpScripts.filter((r) => r.exempt)
const stragglers = mcpScripts.filter((r) => !r.viaHarness && !r.exempt)

console.log("=== A1: harness convergence ===\n")
console.log(`  registered suites   ${rows.length}`)
console.log(`  mcp transport       ${mcpScripts.length}`)
console.log(`  already converged   ${converged.length}`)
console.log(`  exempt (with cause) ${exempt.length}`)
console.log(`  NOT converged       ${stragglers.length}`)
console.log(`  cli transport       ${rows.filter((r) => r.kind === "cli").length}   (no harness needed)`)
console.log(`  no transport        ${rows.filter((r) => r.kind === "none").length}   (no harness needed)`)
console.log(`  missing             ${rows.filter((r) => r.kind === "MISSING").length}`)

if (exempt.length) {
  console.log("\n=== exempt from convergence, with cause ===")
  for (const r of exempt) {
    console.log(`  ${r.script}`)
    console.log(`    ${LOW_LEVEL_EXEMPT[r.script]}`)
  }
}

console.log("\n=== NOT converged, by class ===")
for (const r of stragglers) {
  console.log(`  [${(r.class ?? "?").padEnd(10)}] ${r.name.padEnd(22)} ${r.script}`)
  console.log(`               ${r.why}`)
}

if (loose.length) {
  console.log(`\n=== in scripts/ but not in the registry (${loose.length}) ===`)
  for (const f of loose) {
    const tr = transport(join(SCRIPT_DIR, f))
    console.log(`  ${f.padEnd(34)} transport=${tr.kind} harness=${tr.viaHarness}`)
  }
  console.log("\n  Unregistered files still run, still document findings, and nobody notices")
  console.log("  when they rot. Register them or delete them.")
}

console.log(`\nConvergence: ${converged.length}/${mcpScripts.length - exempt.length} MCP scripts that could converge, do.`)

// Gate order: the active suites first, because a false PASS in a gate is worse
// than a false FAIL anywhere.
const gates = stragglers.filter((r) => r.class === "active")
console.log(`\n  Of these, ${gates.length} are GATING (class: active):`)
for (const g of gates) console.log(`    ${g.name}`)
if (gates.length) console.log("  A false PASS in a gate is the expensive failure. Migrate these first.")

process.exit(stragglers.some((r) => r.class === "active") ? 1 : 0)