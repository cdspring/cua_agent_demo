// Phase 2 verification against a running cua-driver daemon.
//
// Asserts the two properties this project exists for:
//   1. an element-level (accessibility) click reports effect: confirmed
//   2. neither the real cursor nor the foreground window moves
//
// Transport notes, learned the hard way:
//   - `cua-driver call` flattens structuredContent into the top level. An MCP
//     client sees it nested; read either shape.
//   - Every one-shot `call` gets a DISPOSABLE session, so element_token values
//     do NOT survive between invocations. Pass the same `session` label to
//     every call in a multi-step interaction.
//   - `click` requires `pid` even when `element_token` is supplied, which
//     contradicts the schema text ("Omit when element_token is supplied").
//   - PowerShell cannot build the argv: 5.1 strips quotes from multi-field
//     positional JSON. Node passes argv verbatim.
import { spawnSync } from "node:child_process"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const SESSION = "verify-p2"

function call(tool, args = {}) {
  const r = spawnSync(EXE, ["call", tool, JSON.stringify(args)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = String(r.stdout ?? "")
  const text = stdout.trim()
  if (!text) return { transportError: `exit=${r.status} stderr=${String(r.stderr).slice(0, 300)}` }
  try {
    return JSON.parse(text)
  } catch {
    return { plainText: text.slice(0, 300), exit: r.status }
  }
}

/** structuredContent is nested for MCP clients but flattened by `call`. */
const sc = (r) => r?.structuredContent ?? r ?? {}

const wins = () => call("list_windows", { session: SESSION }).windows ?? []
const findCalc = () => wins().find((w) => /calculator|计算器/i.test(w.title ?? ""))
const cursor = () => {
  const c = sc(call("get_cursor_position", { session: SESSION }))
  return { x: c.x, y: c.y }
}

if (!findCalc()) {
  console.log("Calculator not running. Launching hidden via the driver.")
  const l = sc(call("launch_app", { path: "C:\\Windows\\System32\\calc.exe", session: SESSION }))
  console.log(`  launch_app: pid=${l.pid} running=${l.running} windows=${JSON.stringify(l.windows ?? [])}`)
  for (let i = 0; i < 12 && !findCalc(); i++) await new Promise((r) => setTimeout(r, 1000))
}

const calc = findCalc()
if (!calc) {
  console.log("\nCalculator window never appeared.")
  console.log("visible windows:", wins().map((w) => `${w.pid}/${w.window_id} "${w.title}"`).join(" | "))
  process.exit(3)
}
console.log(`\nCalculator: pid=${calc.pid} window_id=${calc.window_id} "${calc.title}"`)

const cursorBefore = cursor()
const fgBefore = wins().find((w) => /^OpenCode$/)
console.log(`cursor before : ${cursorBefore.x},${cursorBefore.y}`)
console.log(`OpenCode before: window_id=${fgBefore?.window_id} z=${fgBefore?.z_index}`)

// One snapshot per turn per (pid, window_id), under the shared session label.
const snap = sc(
  call("get_window_state", {
    pid: calc.pid,
    window_id: calc.window_id,
    max_elements: 400,
    max_depth: 24,
    timeout_ms: 20000,
    include_screenshot: false,
    session: SESSION,
  }),
)
const elems = snap.elements ?? []
console.log(
  `\nsnapshot ${snap.snapshot_id}: ${elems.length} elements (complete=${snap.elements_complete}), truncated=${snap.truncated ?? false} ${snap.truncation_reason ?? ""}, walk ${snap.walk_elapsed_ms}ms`,
)

let target =
  elems.find((e) => /^7\s*$/.test((e.label ?? "").trim()) && (e.actions ?? []).includes("invoke")) ??
  elems.find((e) => e.role === "Button" && /^清除\s*$/.test((e.label ?? "").trim()) && (e.actions ?? []).includes("invoke")) ??
  elems.find((e) => e.role === "Button" && (e.actions ?? []).includes("invoke") && e.frame?.w > 0)

if (!target) {
  console.log("\nno usable button. Tree:")
  console.log(elems.map((e) => `  [${e.element_index}] ${e.role} "${e.label}" actions=[${(e.actions ?? []).join(",")}]`).join("\n"))
  process.exit(4)
}
console.log(`\ntarget: [${target.element_index}] ${target.role} "${target.label}" token=${target.element_token} actions=[${(target.actions ?? []).join(",")}]`)

// The action under test: element-level, background delivery (the default).
const res = call("click", { element_token: target.element_token, pid: calc.pid, session: SESSION })
const r = sc(res)
console.log("\n--- click result ---")
console.log(JSON.stringify(r, null, 2).slice(0, 1200))

const cursorAfter = cursor()
const fgAfter = wins().find((w) => /^OpenCode$/)

const effect = r.effect ?? res.effect ?? res.status ?? "(none)"
const moved = cursorBefore.x !== cursorAfter.x || cursorBefore.y !== cursorAfter.y
const fgStable = fgBefore?.window_id === fgAfter?.window_id && fgBefore?.z_index === fgAfter?.z_index

console.log(`
VERDICT
  effect       : ${effect}
  verified     : ${r.verified ?? "(absent)"}
  refusal      : ${JSON.stringify(r.refusal ?? null)}
  escalation   : ${JSON.stringify(r.escalation ?? null)}
  cursor moved : ${moved}   (${cursorBefore.x},${cursorBefore.y} -> ${cursorAfter.x},${cursorAfter.y})
  fg window_id : ${fgBefore?.window_id} -> ${fgAfter?.window_id}
  fg z_index   : ${fgBefore?.z_index} -> ${fgAfter?.z_index}
  focus stable : ${fgStable}
`)
console.log(
  effect === "confirmed" && !moved && fgStable
    ? "PASS  element click confirmed, no pointer movement, no focus change"
    : "CHECK the fields above",
)
