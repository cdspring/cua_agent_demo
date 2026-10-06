// Decisive check: does an element-level AX click change application state?
//
// Findings this script encodes, each learned from a failed run:
//   - Calculator's buttons are labelled with LOCALISED numerals (一 二 三 …),
//     so matching on "7" finds nothing. Targets must be matched on the label
//     the tree actually reports.
//   - `cua-driver call` flattens structuredContent into the top level.
//   - Every one-shot `call` gets a DISPOSABLE session, so element_token values
//     do not survive between invocations; pass one shared `session` label.
//   - `click` needs `pid` even with `element_token`, despite the schema text.
//   - The cursor assertion must be measured immediately around the click, or a
//     human hand on the same machine makes it meaningless.
import { spawnSync } from "node:child_process"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const SESSION = "verify-ax"

function call(tool, args = {}) {
  const r = spawnSync(EXE, ["call", tool, JSON.stringify(args)], { encoding: "utf8", maxBuffer: 64e6 })
  const t = String(r.stdout ?? "").trim()
  if (!t) return { transportError: `exit=${r.status} ${String(r.stderr).slice(0, 200)}` }
  try {
    return JSON.parse(t)
  } catch {
    return { plain: t.slice(0, 200) }
  }
}
const sc = (r) => r?.structuredContent ?? r ?? {}
const wins = () => call("list_windows", { session: SESSION }).windows ?? []
const cursor = () => {
  const c = sc(call("get_cursor_position", { session: SESSION }))
  return `${c.x},${c.y}`
}

const calc = wins().find((w) => /calculator|计算器/i.test(w.title ?? ""))
if (!calc) {
  console.log("no calculator window")
  process.exit(3)
}
console.log(`target: pid=${calc.pid} window_id=${calc.window_id}`)

function snap() {
  return sc(
    call("get_window_state", {
      pid: calc.pid,
      window_id: calc.window_id,
      max_elements: 3000,
      max_depth: 40,
      timeout_ms: 30000,
      include_screenshot: false,
      session: SESSION,
    }),
  )
}

/** The current entry value lives in the widest Text element. */
function display(s) {
  const wide = (s.elements ?? []).filter((e) => e.role === "Text" && (e.frame?.w ?? 0) > 200 && (e.label ?? "").trim())
  return wide.map((t) => t.label.trim()).join(" | ") || "(none)"
}

const buttons = (s) => (s.elements ?? []).filter((e) => e.role === "Button" && (e.actions ?? []).includes("invoke") && (e.frame?.w ?? 0) > 100)

// The keypad is the block of 200x102 buttons in the lower half. Take them in
// reading order, which is how a person reads a calculator: 7 8 9 / 4 5 6 / 1 2 3.
const s0 = snap()
const keypad = buttons(s0)
console.log(`\nsnapshot ${s0.snapshotId}: ${(s0.elements ?? []).length} elements, complete=${s0.elements_complete}`)
console.log(`display before: ${display(s0)}`)

// Pick a control whose effect is visible in the tree itself. Opening the
// history flyout adds a panel, so a successful invoke changes the element
// count. A digit press would also work, but the keypad's labels are localised
// and the bottom row is +/- and equals rather than digits.
const flyout = (s0.elements ?? []).find((e) => e.role === "Button" && /历史记录/.test(e.label ?? ""))
if (!flyout) {
  console.log(`\nno history flyout button. Buttons: ${keypad.map((b) => `"${b.label}"`).join(", ")}`)
  process.exit(4)
}
const seven = flyout
console.log(`\npressing "${seven.label}" token=${seven.element_token}`)

const zBefore = wins().find((w) => w.window_id === calc.window_id)?.z_index
const cBefore = cursor()

const res = sc(call("click", { element_token: seven.element_token, pid: calc.pid, session: SESSION }))

const cAfter = cursor()
const zAfter = wins().find((w) => w.window_id === calc.window_id)?.z_index

console.log(`  effect    : ${res.effect ?? res.status}`)
console.log(`  route     : ${res.route ?? "-"}   delivery: ${JSON.stringify(res.delivery ?? null)}`)
console.log(`  summary   : ${res.summary ?? "-"}`)
console.log(`  verified  : ${res.verified ?? "(absent)"}`)
console.log(`  cursor    : ${cBefore} -> ${cAfter}   moved=${cBefore !== cAfter}`)
console.log(`  target z  : ${zBefore} -> ${zAfter}`)

const s1 = snap()
const after = display(s1)
console.log(`\n  display after : ${after}`)
console.log(`\nVERDICT: display "${display(s0)}" -> "${after}"   state changed = ${display(s0) !== after}`)
