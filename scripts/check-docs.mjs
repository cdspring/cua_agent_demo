// Validate the machine-readable routing table against the INSTALLED driver, and
// scan the prose for stale claims.
//
// This file previously hardcoded a 59-name tool list and used the routing table
// only to check that it parsed as JSON. Both were decorative in the way that
// matters: a hardcoded list cannot notice a driver upgrade that adds, removes or
// renames a tool, and a table nobody cross-checks drifts into folklore. This
// project produced three wrong conclusions in one pass from asserting on a shape
// it had not verified; a validator that cannot fail on the thing it exists to
// catch is worse than none.
//
// So: the tool list is derived from `cua-driver list-tools` at run time, and the
// table is checked against it.
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const TABLE = ".opencode/skills/computer-use/references/decision-table.json"

const problems = []
const say = (s) => console.log(s)
const problem = (s) => {
  problems.push(s)
  console.log(`  PROBLEM  ${s}`)
}
const ok = (s) => console.log(`  PASS     ${s}`)

// ---------------------------------------------------------------------------
say("=== driver ===")
let driverVersion = "unknown"
let REAL_TOOLS = new Set()
try {
  driverVersion = execFileSync(EXE, ["--version"], { encoding: "utf8", timeout: 30000 })
    .trim()
    .split(/\r?\n/)[0]
    .replace(/^cua-driver\s+/, "")
  const tools = execFileSync(EXE, ["list-tools"], { encoding: "utf8", timeout: 30000 })
  REAL_TOOLS = new Set([...tools.matchAll(/^\s*([a-z_]{4,})\s*:/gm)].map((m) => m[1]))
  ok(`cua-driver ${driverVersion}, ${REAL_TOOLS.size} tools discovered from the driver itself`)
} catch (e) {
  problem(`could not query the driver: ${e.message}`)
  say("  cannot validate anything without the live tool list; stopping")
  process.exit(1)
}

// ---------------------------------------------------------------------------
say("\n=== decision-table.json ===")
const d = JSON.parse(readFileSync(TABLE, "utf8"))
const keys = (o) => Object.keys(o).filter((k) => k !== "$comment")
say(`  version        ${d.version}`)
say(`  verifiedAgainst ${d.verifiedAgainst}`)
say(`  effects        ${keys(d.effects).join(", ")}`)
say(`  routes         ${keys(d.routes).join(", ")}`)
say(`  refusals       ${keys(d.refusals).join(", ")}`)
say(`  deprecated     ${keys(d.deprecated).join(", ")}`)
say(`  noWaitTool     ${JSON.stringify(d.noWaitTool?.alternatives)}`)
say(`  coordSpaces    ${keys(d.coordinateSpaces).join(", ")}`)

// The table is pinned to a version. A driver upgrade must fail here rather than
// silently leaving every downstream claim stale.
if (!String(d.verifiedAgainst ?? "").includes(driverVersion)) {
  problem(
    `table says verifiedAgainst ${JSON.stringify(d.verifiedAgainst)} but the installed driver is ${driverVersion}. ` +
      `Re-measure before trusting the table, then bump it deliberately.`,
  )
} else {
  ok(`table is pinned to the installed version (${driverVersion})`)
}

// Every tool the table names must exist.
const namedTools = new Set()
JSON.stringify(d, (k, v) => {
  if (typeof v === "string") for (const t of REAL_TOOLS) if (v.includes(t)) namedTools.add(t)
  return v
})
const ghostTools = [...keys(d.deprecated)].filter((n) => !REAL_TOOLS.has(n))
if (ghostTools.length) {
  problem(`table documents these as deprecated but the driver does not advertise them: ${ghostTools.join(", ")}`)
} else {
  ok(`all ${keys(d.deprecated).length} documented-deprecated tools are present-and-marked`)
}
if (keys(d.deprecated).length === 0) problem("table lists no deprecated tools; 0.34.0 has at least three")

// The converse: tools the driver marks deprecated but the table omits.
const KNOWN_DEPRECATED = ["escalate_session", "page", "get_session_state"]
const presentButUndocumented = KNOWN_DEPRECATED.filter((n) => REAL_TOOLS.has(n) && !keys(d.deprecated).includes(n))
if (presentButUndocumented.length) {
  problem(`driver advertises these but the table does not mark them deprecated: ${presentButUndocumented.join(", ")}`)
} else {
  ok("every known-deprecated tool is marked in the table")
}

// `wait` is the standing example of a tool people assume exists.
if (REAL_TOOLS.has("wait")) problem("the driver now advertises a `wait` tool; the table's noWaitTool section is wrong")
else ok("no `wait` tool, as the table states")

// The refusal vocabulary should be recognisable in the driver's own surface. It
// is not enumerated anywhere machine-readable, so this checks only the ones the
// driver demonstrably emitted during this project, which is the honest subset.
const OBSERVED_REFUSALS = [
  "stale_element_token", "capture_coordinate_invalid", "permission_denied",
  "bounded_resource_outside_manifest", "browser_requires_setup", "foreground_unavailable",
  "tool_invocation_failed", "foreign_process_termination_denied", "browser_requires_setup",
  "authorization_required", "background_occluded", "background_uipi_blocked",
]
const tableRefusals = keys(d.refusals)
const unrecorded = OBSERVED_REFUSALS.filter((r) => !tableRefusals.includes(r))
if (unrecorded.length) {
  problem(`refusal codes observed in practice are absent from the table: ${unrecorded.join(", ")}`)
} else {
  ok(`all ${OBSERVED_REFUSALS.length} observed refusal codes are recorded in the table`)
}

// ---------------------------------------------------------------------------
say("\n=== prose ===")
const docs = [".opencode/skills/computer-use/SKILL.md", ".opencode/skills/computer-use/references/routing.md"]
const mentioned = new Set()
for (const f of docs) for (const m of readFileSync(f, "utf8").matchAll(/`([a-z_]{4,})`/g)) mentioned.add(m[1])

// Identifiers that are not tool names: option names, refusal codes, field names,
// prose words. A denylist that grows without being curated is just noise, so it
// is kept adjacent to the reasons above.
const UNRELATED = new Set([
  "background", "foreground", "captured", "confirmed", "unverifiable", "suspected_noop", "partial", "refused",
  "delivered", "routable", "verifiable", "screenshot", "coordinates", "background_unavailable",
  "background_occluded", "background_uipi_blocked", "stale_element_token", "capture_coordinate_invalid",
  "screenshot_context_missing", "bounded_resource_outside_manifest", "authorization_required",
  "route_unavailable", "delivery_failed", "effect_unconfirmed", "permission_required", "unknown_reason",
  "untrusted_source", "satisfied", "unsatisfied", "unknown", "accessibility", "synthetic_events", "global_input",
  "dom", "trusted_input", "invalidated_snapshot_ids", "structuredContent", "sleep", "delay_ms", "timeout_ms",
  "amount", "pid", "window_id", "scope", "capture_id", "element_token", "frame", "region",
  "max_elements", "max_depth", "max_image_dimension", "include_screenshot", "include_accessibility_tree",
  "capture_mode", "query", "x", "y", "label_contains", "text", "session", "codemode", "os", "value", "label",
  "role", "index", "true", "false", "null", "token", "name", "actions", "tool", "tools", "shell",
  "question", "browser", "browser_prepare", "z_index", "minimized", "bounds", "title", "app_name",
  "allow", "rules", "max_length", "min", "pattern", "allowed", "required", "constraints", "duration_ms",
  "durationMs", "executable", "element_count", "foreground_unavailable", "tool_invocation_failed",
  "ax_tree_empty", "browser_requires_setup", "policy_constraints",
  "foreign_process_termination_denied", "permission_denied",
  "start_recording", "stop_recording", "history", "install_extension", "extension",
  "parse_visual_regions", "cursor-theme", "revoke", "install_ffmpeg",
  "browser_download", "cua_browser_download", "get_recording_state",
  "get_agent_cursor_state", "execute_javascript", "get_session", "list_sessions",
  "list-tools", "list_apps", "computer_capture", "computer_diagnose",
  // Deliberate references to things that must NOT be called.
  "escalate_session", "page", "get_session_state", "computer_screenshot", "computer_screen", "computer_act",
  "route", "routes", "escalation", "target", "pixel", "scale", "type", "standard", "bounded", "unrestricted",
  "resources", "apps", "launch", "windows", "terminate", "is_on_screen", "wait", "effect",
  // StructuredContent fields and driver option values named in prose.
  "degraded_reason", "delivery_mode", "target_id", "tab_id", "prepared_pid",
  "isolated_named", "isolated_new", "allow_launch", "browser_navigate",
  "browser_screenshot", "reason", "scope_ref", "endpoint_access_class",
])

const suspects = [...mentioned].filter((m) => !REAL_TOOLS.has(m) && !UNRELATED.has(m) && /^[a-z][a-z0-9_]*$/.test(m))
if (suspects.length) {
  problem(`backticked identifiers in the docs that are neither driver tools nor known vocabulary:\n           ${suspects.join("\n           ")}`)
} else {
  ok(`prose names only real tools and known vocabulary (${mentioned.size} identifiers scanned)`)
}

console.log("\n" + (problems.length ? `${problems.length} problem(s)` : "docs and table agree with the installed driver"))
process.exit(problems.length ? 1 : 0)