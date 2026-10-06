// Confirms the coordinate-space rule for pixel actions carrying a capture_id.
//
// Element `frame` values are DESKTOP coordinates. A pixel action that supplies
// `capture_id` is admitted against that capture, whose coordinate space is the
// WINDOW-LOCAL screenshot. Passing frame values straight through is refused
// with capture_coordinate_invalid.
import { spawnSync } from "node:child_process"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const S = "verify-coords"

function raw(tool, args = {}) {
  const r = spawnSync(EXE, ["call", tool, JSON.stringify(args)], { encoding: "utf8", maxBuffer: 64e6 })
  const t = String(r.stdout ?? "").trim()
  let j = null
  try {
    j = JSON.parse(t)
  } catch {}
  return { exit: r.status, json: j, stderr: String(r.stderr ?? "").slice(0, 200), text: j ? undefined : t.slice(0, 200) }
}
const sc = (r) => r?.structuredContent ?? r ?? {}
const wins = () => raw("list_windows", { session: S }).json?.windows ?? []
const cursor = () => {
  const c = sc(raw("get_cursor_position", { session: S }).json)
  return { x: c.x, y: c.y }
}

const calc = wins().find((w) => /calculator|计算器/i.test(w.title ?? ""))
if (!calc) {
  console.log("no calculator")
  process.exit(3)
}
const { pid, window_id } = calc
const snap = () =>
  sc(
    raw("get_window_state", {
      pid,
      window_id,
      max_elements: 3000,
      max_depth: 40,
      include_screenshot: true,
      max_image_dimension: 0, // native, so local pixels == frame delta exactly
      session: S,
    }).json,
  )

function display(s) {
  const wide = (s.elements ?? []).filter((e) => e.role === "Text" && (e.frame?.w ?? 0) > 200 && (e.label ?? "").trim())
  return wide.map((t) => t.label.trim()).join(" | ") || "(none)"
}

const s = snap()
const b = s.window_bounds
console.log(`window_bounds (desktop)  : x=${b.x} y=${b.y} ${b.width}x${b.height}`)
console.log(`capture_id               : ${s.capture_id}`)
console.log(`screenshot size          : ${s.screenshot_width}x${s.screenshot_height}`)

const target = (s.elements ?? []).find((e) => e.role === "Button" && /打开历史记录浮出控件|历史记录/.test(e.label ?? ""))
if (!target) {
  console.log(`history button not found; buttons: ${(s.elements ?? []).filter((e) => e.role === "Button").map((e) => e.label).join(", ")}`)
  process.exit(4)
}

const frame = target.frame
const centreDesktop = { x: Math.round(frame.x + frame.w / 2), y: Math.round(frame.y + frame.h / 2) }
const centreLocal = { x: centreDesktop.x - b.x, y: centreDesktop.y - b.y }
console.log(`\ntarget "${target.label}"`)
console.log(`  element frame (desktop) : ${JSON.stringify(frame)}`)
console.log(`  derived desktop centre  : ${JSON.stringify(centreDesktop)}`)
console.log(`  derived window-local    : ${JSON.stringify(centreLocal)}   <- within ${s.screenshot_width}x${s.screenshot_height}: ${centreLocal.x >= 0 && centreLocal.x < s.screenshot_width && centreLocal.y >= 0 && centreLocal.y < s.screenshot_height}`)

const before = display(s)
const cBefore = cursor()
const zBefore = wins().find((w) => w.window_id === window_id)?.z_index

const res = raw("click", { pid, window_id, ...centreLocal, capture_id: s.capture_id, session: S })
const r = sc(res.json)
console.log(`\n  exit=${res.exit}  effect=${r.effect ?? r.status}  route=${r.route ?? "-"}  code=${r.code ?? "-"}`)
console.log(`  summary: ${JSON.stringify(r.summary ?? r.detail ?? null).slice(0, 220)}`)

const cAfter = cursor()
const zAfter = wins().find((w) => w.window_id === window_id)?.z_index
console.log(`  cursor: ${cBefore.x},${cBefore.y} -> ${cAfter.x},${cAfter.y}   moved=${cBefore.x !== cAfter.x || cBefore.y !== cAfter.y}`)
console.log(`  target z: ${zBefore} -> ${zAfter}`)

const s2 = snap()
console.log(`\n  display before: ${before}`)
console.log(`  display after : ${display(s2)}`)
console.log(`\nVERDICT: ${before !== display(s2) ? "state changed, so the window-local pixel click worked" : "no visible state change"}`)
