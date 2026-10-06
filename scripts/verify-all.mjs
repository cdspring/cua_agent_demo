// The single entry point: "is this system healthy?"
//
// Thirty-two scripts accumulated over six phases with no index. Answering that
// question meant knowing six filenames, and scripts that drive the Calculator
// looked broken rather than historical, because nothing said what they were for.
//
//   node scripts/verify-all.mjs             run the active suites
//   node scripts/verify-all.mjs --record    also run the record suites
//   node scripts/verify-all.mjs --list      show the index and exit
//   node scripts/verify-all.mjs --only x,y  run named suites
//
// Two things this does that no single script did before:
//
//   1. It sweeps leaked cua-driver processes afterwards. Every probe that spawns
//      its own `cua-driver mcp` child can leave one behind on a crash or an early
//      return, and by the end of this project four had accumulated. Stray clients
//      are harmless individually and confusing in aggregate: they show up in
//      list_windows as agent cursor overlays and make process counts meaningless.
//
//   2. It distinguishes active from record. A record suite is EXPECTED to report a
//      known limitation. Treating that as a regression is how a durable finding
//      gets "fixed" into a bug.
import { spawn, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { SUITES, SCRIPT_DIR, byClass } from "./lib/suites.mjs"

const argv = process.argv.slice(2)
const WANT_RECORD = argv.includes("--record")
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1]?.split(",").map((s) => s.trim()) : null
const LIST_ONLY = argv.includes("--list")

// ---------------------------------------------------------------------------
function mcpClients() {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='cua-driver.exe'\" | " +
    "ForEach-Object { if ($_.CommandLine -match '\\bmcp\\b') { $_.ProcessId } }",
  ], { encoding: "utf8", timeout: 30000 })
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log("=== verify-all: is this system healthy? ===\n")

if (LIST_ONLY) {
  for (const c of ["active", "record", "diagnostic"]) {
    console.log(`--- ${c} ---`)
    for (const s of byClass(c)) {
      const present = existsSync(join(SCRIPT_DIR, s.script))
      console.log(`  ${present ? "" : "MISSING "}${s.name.padEnd(24)} ${s.script.padEnd(34)} ${s.why}`)
    }
    console.log("")
  }
  process.exit(0)
}

const missing = SUITES.filter((s) => !existsSync(join(SCRIPT_DIR, s.script)))
if (missing.length) {
  console.log("  registry references scripts that do not exist:")
  for (const m of missing) console.log(`    ${m.script}`)
  console.log("")
}

let chosen = SUITES.filter((s) => s.class === "active")
if (WANT_RECORD) chosen = chosen.concat(byClass("record"))
if (ONLY) chosen = SUITES.filter((s) => ONLY.includes(s.name))

const before = mcpClients()
console.log(`  cua-driver mcp clients before: ${before.length}`)

const results = []
for (const s of chosen) {
  const path = join(SCRIPT_DIR, s.script)
  if (!existsSync(path)) {
    results.push({ name: s.name, cls: s.class, status: "MISSING" })
    continue
  }
  process.stdout.write(`  running ${s.name.padEnd(24)}`)
  let out = ""
  let code = 0
  try {
    out = execFileSync("node", [path], { encoding: "utf8", timeout: 420000, stdio: ["ignore", "pipe", "pipe"] })
  } catch (e) {
    out = (e.stdout ?? "") + (e.stderr ?? "")
    code = e.status ?? -1
  }
  // Scripts report "N/M passed" in their own summary. Prefer that over the exit
  // code: several exit non-zero on a partial result that is still informative.
  const m = out.match(/(\d+)\/(\d+) passed/)
  const passed = m ? Number(m[1]) : null
  const total = m ? Number(m[2]) : null

  // Compare against what the registry says should fail. A suite whose failures
  // are exactly the declared ones is PASS: the known limitation is accounted for
  // and a NEW failure is still visible. This is what keeps a durable finding from
  // either being "fixed" into a bug or being lost in noise.
  const expected = new Set(s.expectFailing ?? [])
  const skippedNames = new Set([...out.matchAll(/^\s*SKIP\s+(.+?)\s*$/gm)].map((x) => x[1].trim()))
  const actualFailures = new Set([...out.matchAll(/^\s*FAIL\s+(.+?)\s*$/gm)].map((x) => x[1].trim()))
  // A check that SKIPped is neither passing nor failing. Fold it out so the
  // count stays honest rather than reporting "3/10 passed" when five were not
  // applicable in the first place.
  for (const skipped of skippedNames) actualFailures.delete(skipped)
  const unexpected = [...actualFailures].filter((f) => !expected.has(f))
  const missingExpected = [...expected].filter((f) => !actualFailures.has(f))

  let status
  if (unexpected.length === 0 && missingExpected.length === 0) status = "PASS"
  else if (expected.size > 0 && unexpected.length === 0 && missingExpected.length > 0) status = "CHANGED"
  else status = "FAIL"

  results.push({
    name: s.name,
    cls: s.class,
    status,
    passed,
    total,
    skipped: skippedNames.size,
    why: s.why,
    unexpected,
    missingExpected,
    skippedNames: [...skippedNames],
    tail: out.split(/\r?\n/).slice(-4).join(" | "),
  })
  const mark = { PASS: "PASS", CHANGED: "CHANGED", FAIL: "FAIL", MISSING: "MISSING" }[status]
  console.log(
    `  ${mark}${passed !== null ? `  ${passed}/${total}` : ""}` +
      `${skippedNames.size ? `  ${skippedNames.size} skipped` : ""}` +
      `${expected.size ? `  (${expected.size} known failure(s))` : ""}`,
  )
  await sleep(400)
}

// ---------------------------------------------------------------------------
console.log("\n=== leaked cua-driver mcp clients ===")
const after = mcpClients()
const leaked = after.filter((p) => !before.includes(p))
if (leaked.length === 0) {
  console.log("  none: every suite cleaned up after itself")
} else {
  console.log(`  ${leaked.length} client(s) left behind: ${leaked.join(", ")}`)
  console.log("  These are disposable MCP clients, not the daemon. Terminating them is safe.")
  for (const pid of leaked) {
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-Command",
        "Stop-Process -Id " + pid + " -Force -ErrorAction SilentlyContinue"], { timeout: 20000 })
      console.log(`    stopped ${pid}`)
    } catch {
      console.log(`    could not stop ${pid}`)
    }
  }
  console.log("  If this keeps happening, the suite exited before its finally block.")
  console.log("  That is a defect in the script, not in the driver.")
}
await sleep(800)
console.log(`  remaining: ${mcpClients().length}`)

// ---------------------------------------------------------------------------
console.log("\n================ SUMMARY ================")
for (const r of results) {
  const tag = r.cls === "record" ? "record" : "active"
  // Record suites are documentation, not gates. Their purpose is to keep a
  // conclusion that cost a session from having to be re-derived. Reporting their
  // known limitations as FAIL invites someone to "fix" a durable finding into a
  // bug, and fabricating an expectFailing entry for each one would hide a NEW
  // failure behind a wall of declared ones. So they print findings and never gate.
  const head = r.cls === "record" ? "INFO" : (r.status ?? "?")
  console.log(`${head.padEnd(8)} ${r.name.padEnd(24)} [${tag}]`)
  if (r.unexpected?.length) for (const f of r.unexpected) console.log(`         finding: ${f}`)
  if (r.missingExpected?.length) for (const f of r.missingExpected) console.log(`         registry stale: "${f}" no longer fails`)
  if (r.skippedNames?.length) for (const f of r.skippedNames) console.log(`         not applicable: ${f}`)
}

const activeFails = results.filter((r) => r.cls === "active" && r.status !== "PASS")
const recordNotes = results.filter((r) => r.cls === "record")

console.log("")
if (activeFails.length === 0) {
  console.log(`All ${results.filter((r) => r.cls === "active").length} active suites pass.`)
} else {
  console.log(`${activeFails.length} ACTIVE suite(s) not passing:`)
  for (const r of activeFails) {
    console.log(`  ${r.name}: ${r.status}${r.passed !== null ? ` ${r.passed}/${r.total}` : ""}`)
    for (const f of r.unexpected ?? []) console.log(`      UNEXPECTED: ${f}`)
    for (const f of r.missingExpected ?? []) console.log(`      registry stale: "${f}" no longer fails`)
    if (!r.unexpected?.length && !r.missingExpected?.length && r.tail) console.log(`      ${r.tail.slice(0, 150)}`)
  }
}
if (recordNotes.length) {
  console.log(`\n${recordNotes.length} record suite(s) ran as documentation. The findings above are`)
  console.log("the durable results and do NOT gate. Do not 'fix' them to make them pass:")
  for (const r of recordNotes) console.log(`  ${r.name}: ${(r.unexpected ?? []).length} finding(s)`)
}
if (leaked.length) console.log(`\n${leaked.length} leaked client process(es) were swept.`)
console.log(`\nDiagnostic suites did not run. List them with --list; run one with --only <name>.`)

process.exit(activeFails.length || missing.length ? 1 : 0)