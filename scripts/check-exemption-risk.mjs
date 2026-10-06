// Justify the exemptions continuously, by asserting a POSITIVE property.
//
// The first version of this check tried to detect the two footguns statically --
// element_token use, and .test() against a response -- and produced nine flags.
// Nine were false positives, and the reasons are instructive:
//
//   verify-mcp          `click?.inputSchema?.properties?.element_token` is schema
//                       inspection, not token use.
//   verify-bounded      its six .test() calls read the MANIFEST FILE, the driver's
//                       STARTUP STDOUT, and window title/app_name. None match a
//                       tool response. They are not the footgun.
//   verify-phase4       two type_text calls share one token. That is LEGAL: only a
//                       new snapshot invalidates tokens, not an action.
//
// A checker that reports nine false positives gets ignored, and then it protects
// nothing. So this does not try to detect the footgun. It asserts the property
// that actually justifies not migrating:
//
//   an exempt or un-converged script must classify refusals by CODE.
//
// That is positively checkable -- it references structuredContent, .code or
// refusal -- and it is precisely what the harness's refusals{} map provides. A
// script that matches driver prose instead will fail here.
//
// element_token use is reported for information, not as a failure, because using
// it is legitimate when each action re-derives its own token and is a real
// footgun only when one token is replayed across snapshots, which is not
// detectable without running the script.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SUITES, SCRIPT_DIR, LOW_LEVEL_EXEMPT } from "./lib/suites.mjs"

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
}

const usesHarness = (s) => /from\s+["'][^"']*lib\/cua-client\.mjs["']/.test(s)
const talksMcp = (s) => /\bmcp\b/.test(s) && /jsonrpc/.test(s)

// The positive property. Classifying a refusal means reading structuredContent
// or a code field, not scraping prose.
const CLASSIFIES_BY_CODE = /structuredContent|\.code\b|refusal\?\.|refusal\.code/

// Scope: only scripts that actually ASSERT ON A TOOL RESULT are in scope.
// A script that observes process startup, reads MCP resources, or only reads
// files cannot misclassify a refusal because it never classifies one. Requiring
// `tools/call` before applying the invariant is what keeps it from flagging
// bisect-policy-schema (watches whether the driver starts), read-cua-docs (reads
// the driver's published documents) and this file (reads source).
//
// Tested against the RAW source, not codeOnly(). The marker is the string literal
// "tools/call", and codeOnly strips string literals -- so the first version of
// this check found it in nothing and reported every script as out of scope, which
// made the invariant vacuous while appearing to pass.
const ASSERTS_ON_TOOL_RESULTS = /tools\/call/

const problems = []
const rows = []

for (const s of SUITES) {
  let src
  try {
    src = readFileSync(join(SCRIPT_DIR, s.script), "utf8")
  } catch {
    continue
  }
  if (usesHarness(src) || !talksMcp(src)) continue

  const code = codeOnly(src)
  const exempt = !!LOW_LEVEL_EXEMPT[s.script]
  const inScope = ASSERTS_ON_TOOL_RESULTS.test(src)
  const byCode = CLASSIFIES_BY_CODE.test(code)
  // Schema inspection is not token use.
  const tokenUse = Math.max(0, (code.match(/element_token/g) ?? []).length - (code.match(/inputSchema/g) ?? []).length)

  rows.push({ script: s.script, cls: s.class, exempt, inScope, byCode, tokenUse })

  if (!inScope) continue
  if (!byCode) {
    problems.push(
      `${s.script} is ${exempt ? "EXEMPT" : "un-converged"}, calls tools, and never reads structuredContent or a ` +
        `code field, so it cannot be classifying refusals by code. It must be scraping prose, which is the ` +
        `exact defect the shared client's refusals{} map removes. Migrate it, or show where it reads codes.`,
    )
  }
}

console.log("=== standing invariant: un-converged scripts must classify by code ===\n")
console.log(`  MCP scripts without the shared client: ${rows.length}`)
for (const r of rows) {
  const tag = r.exempt ? "exempt " : "straggler"
  const scope = r.inScope ? "in-scope " : "n/a      "
  console.log(
    `  ${tag}  ${scope}  byCode=${(r.byCode ? "yes" : "NO ").padEnd(4)} tokenRefs=${String(r.tokenUse).padStart(2)}  ${r.script}`,
  )
}

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}

console.log(`
  All ${rows.length} classify refusals by code, which is the property that makes the
  exemption justified rather than merely asserted. tokenRefs is informational:
  using element_token is fine when each action re-derives its own token, and
  replaying one token across snapshots is not detectable without running the
  script, so this does not pretend otherwise.`)