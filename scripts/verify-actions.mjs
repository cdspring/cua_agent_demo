// Remaining Phase 2 verification, all against Calculator so every action is
// trivially reversible. Covers what has NOT been proven yet:
//
//   A. pixel action + capture_id binding (is the id required? is it one-shot?)
//   B. type_text into a field, and its effect field
//   C. set_value via UIA ValuePattern
//   D. foreground escalation, and whether it restores the prior foreground
//   E. the real-cursor / focus side-effect claim under each delivery mode
//
// Transport rules encoded here (each cost a failed run to learn):
//   - `cua-driver call` flattens structuredContent into the top level.
//   - Every one-shot `call` gets a DISPOSABLE session; element_token and
//     capture_id do NOT survive between invocations. One shared `session`.
//   - `click` needs `pid` even when `element_token` is supplied.
//   - Node passes argv verbatim; PowerShell 5.1 strips quotes from multi-field
//     positional JSON, so nothing here may be driven from PowerShell.
import { spawnSync } from "node:child_process"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const SESSION = "verify-rest"

function call(tool, args = {}) {
  const r = spawnSync(EXE, ["call", tool, JSON.stringify(args)], { encoding: "utf8", maxBuffer: 64e6 })
  const t = String(r.stdout ?? "").trim()
  if (!t) return { transportError: `exit=${r.status} ${String(r.stderr).slice(0, 200)}` }
  try {
    return JSON.parse(t)
  } catch {
    return { plain: t.slice(0, 300) }
  }
}
const sc = (r) => r?.structuredContent ?? r ?? {}
const wins = () => call("list_windows", { session: SESSION }).windows ?? []
const cursor = () => {
  const c = sc(call("get_cursor_position", { session: SESSION }))
  return { x: c.x, y: c.y }
}
const titleOf = (r) => `${r.effect ?? r.status ?? "?"}${r.route ? ` route=${r.route}` : ""}${r.delivery ? ` delivery=${r.delivery.mode}` : ""}`

const calc = wins().find((w) => /calculator|计算器/i.test(w.title ?? ""))
if (!calc) {
  console.log("no calculator window; launch it from the desktop first")
  process.exit(3)
}
const { pid, window_id } = calc
console.log(`target: pid=${pid} window_id=${window_id}\n`)

function snap(opts = {}) {
  return sc(
    call("get_window_state", {
      pid,
      window_id,
      max_elements: 3000,
      max_depth: 40,
      timeout_ms: 30000,
      include_screenshot: false,
      session: SESSION,
      ...opts,
    }),
  )
}
const buttons = (s) =>
  (s.elements ?? []).filter((e) => e.role === "Button" && (e.actions ?? []).includes("invoke") && (e.frame?.w ?? 0) > 100)

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`)
}

// ---------------------------------------------------------------- A. pixels
console.log("A. pixel action + capture_id")
{
  const s = snap({ include_screenshot: true, max_image_dimension: 1200 })
  const captureId = s.capture_id ?? s.snapshot_id
  console.log(`  snapshot ${s.snapshotId}  capture_id=${JSON.stringify(captureId)}  screenshot=${s.screenshot_file_path ?? (s.screenshot ? "embedded" : "none")}`)
  console.log(`  window_bounds=${JSON.stringify(s.window_bounds)}`)

  const eq = buttons(s).find((b) => /等于|=/.test(b.label ?? ""))
  if (!eq?.frame) {
    record("A1 pixel click without capture_id", false, "no '=' button frame found")
  } else {
    // A1: omit capture_id. The driver should refuse rather than guess.
    const noId = sc(call("click", { pid, window_id, x: Math.round(eq.frame.x + eq.frame.w / 2), y: Math.round(eq.frame.y + eq.frame.h / 2) }))
    const refusedWithout = !!noId.refusal || noId.status === "refused"
    console.log(`  A1 omit capture_id -> ${JSON.stringify(noId.refusal ?? noId).slice(0, 200)}`)
    record("A1 pixel click without capture_id is refused", refusedWithout, refusedWithout ? "refused as expected" : "ACCEPTED without an id")

    // A2: with the capture_id, and window-local coordinates.
    const cBefore = cursor()
    const zBefore = wins().find((w) => w.window_id === window_id)?.z_index
    const withId = sc(call("click", { pid, window_id, x: Math.round(eq.frame.x + eq.frame.w / 2), y: Math.round(eq.frame.y + eq.frame.h / 2), capture_id: captureId, session: SESSION }))
    const cAfter = cursor()
    const zAfter = wins().find((w) => w.window_id === window_id)?.z_index
    console.log(`  A2 with capture_id -> ${titleOf(withId)}  summary=${JSON.stringify(withId.summary ?? withId.refusal ?? null).slice(0, 160)}`)
    console.log(`     cursor ${cBefore.x},${cBefore.y} -> ${cAfter.x},${cAfter.y} moved=${cBefore.x !== cAfter.x || cBefore.y !== cAfter.y}`)
    console.log(`     target z ${zBefore} -> ${zAfter}`)
    record("A2 pixel click with capture_id dispatches", !withId.refusal, titleOf(withId))

    // A3: one-shot. Reusing the same id must fail.
    const reuse = sc(call("click", { pid, window_id, x: 10, y: 10, capture_id: captureId, session: SESSION }))
    const reused = !!reuse.refusal
    console.log(`  A3 reuse same capture_id -> ${JSON.stringify(reuse.refusal ?? reuse).slice(0, 200)}`)
    record("A3 capture_id is single-use", reused, reused ? `refused: ${reuse.refusal?.code}` : "SECOND USE ACCEPTED")
  }
}

// ------------------------------------------------- B/C. typing and set_value
console.log("\nB/C. typing")
{
  const s = snap()
  const fields = (s.elements ?? []).filter((e) => (e.actions ?? []).includes("set_value"))
  console.log(`  set_value-capable elements: ${fields.map((f) => `[${f.element_index}]${f.role}"${f.label}"`).join(", ") || "(none)"}`)

  if (fields.length === 0) {
    record("B1 type_text into a field", false, "no set_value-capable field exposed by this app")
  } else {
    const field = fields.find((f) => f.role !== "Window") ?? fields[0]
    const before = field.label
    const res = sc(call("type_text", { element_token: field.element_token, pid, text: "42", session: SESSION }))
    console.log(`  B1 type_text "${before}" -> ${titleOf(res)} summary=${JSON.stringify(res.summary ?? res.refusal ?? null).slice(0, 200)}`)
    record("B1 type_text dispatches", !res.refusal, titleOf(res))

    const s2 = snap()
    const field2 = (s2.elements ?? []).find((e) => e.element_index === field.element_index)
    console.log(`     field label now: ${JSON.stringify(field2?.label)}`)
    record("B2 type_text is readable back", field2?.label !== before, `"${before}" -> "${field2?.label}"`)

    const sv = sc(call("set_value", { element_token: field.element_token, pid, value: "77", session: SESSION }))
    console.log(`  B3 set_value -> ${titleOf(sv)} summary=${JSON.stringify(sv.summary ?? sv.refusal ?? null).slice(0, 200)}`)
    record("B3 set_value dispatches", !sv.refusal, titleOf(sv))
  }
}

// ------------------------------------------------- D/E. foreground escalation
console.log("\nD/E. foreground escalation")
{
  const s = snap()
  const eq = buttons(s).find((b) => /等于|=/.test(b.label ?? ""))
  const point = eq?.frame ? { x: Math.round(eq.frame.x + eq.frame.w / 2), y: Math.round(eq.frame.y + eq.frame.h / 2) } : null

  const fgBefore = wins().reduce((best, w) => (w.z_index > (best?.z_index ?? -1) ? w : best), null)
  console.log(`  frontmost before: z=${fgBefore?.z_index} "${fgBefore?.title}" (pid ${fgBefore?.pid})`)
  const cBefore = cursor()

  if (!point) {
    record("D1 foreground delivery", false, "no target point")
  } else {
    const res = sc(call("click", { pid, window_id, ...point, delivery_mode: "foreground", session: SESSION }))
    console.log(`  D1 foreground click -> ${titleOf(res)} summary=${JSON.stringify(res.summary ?? res.refusal ?? null).slice(0, 200)}`)

    await new Promise((r) => setTimeout(r, 700))
    const fgAfter = wins().reduce((best, w) => (w.z_index > (best?.z_index ?? -1) ? w : best), null)
    const cAfter = cursor()
    console.log(`     frontmost after : z=${fgAfter?.z_index} "${fgAfter?.title}" (pid ${fgAfter?.pid})`)
    console.log(`     cursor          : ${cBefore.x},${cBefore.y} -> ${cAfter.x},${cAfter.y}`)
    const restored = fgAfter?.pid === fgBefore?.pid
    record("D1 foreground delivery dispatches", !res.refusal, titleOf(res))
    record("D2 prior foreground restored", restored, `${fgBefore?.title} -> ${fgAfter?.title}`)
    record("D3 real cursor unmoved by foreground click", cBefore.x === cAfter.x && cBefore.y === cAfter.y, `${cBefore.x},${cBefore.y} -> ${cAfter.x},${cAfter.y}`)
  }
}

console.log("\n================ SUMMARY ================")
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n        ${r.detail}`)
const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
