// Does the documented escalation rescue a click on a UIA-less XAML host?
//
// Measured so far on CalculatorApp.exe (post-update self-hosted Calculator):
//   - UIA tree is empty at every depth, in both standard and bounded mode.
//     Driver says: ax_tree_empty, "switch to the visual path".
//   - delivery_mode: "background" pixel click returns tool_invocation_failed with
//     the text "operation completed successfully (0x00000000)". The display does
//     not change: pressing C did not clear it. So S_OK there is the return of the
//     PostMessage itself, not the click's effect, and reading it as success would
//     be exactly the mistake the driver warns about.
//
// The tool contract says background is the mandatory first attempt and that
// foreground is the escalation for hosts whose input stack drops posted events.
// This probe answers whether that escalation actually works here, and whether the
// refusal it returns is the documented background_unavailable or something else.
//
// It will briefly move the real cursor and the foreground window. That is the
// driver's own behaviour on this path; it restores the previous foreground after.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdirSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const OUT = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
mkdirSync(OUT, { recursive: true })

// Read off the 828x1064 screenshot, in screenshot pixel space.
const KEYS = [
  { name: "C", x: 516, y: 475 },
  { name: "7", x: 107, y: 687 },
  { name: "times", x: 718, y: 687 },
  { name: "6", x: 516, y: 793 },
  { name: "equals", x: 718, y: 1002 },
]

const child = spawn(EXE, ["mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CUA_DRIVER_PERMISSION_MODE: "bounded",
    CUA_DRIVER_CAPABILITY_MANIFEST_FILE: "D:\\compterusedkill\\config\\cua-bounded.yaml",
    CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
  },
})
const rl = createInterface({ input: child.stdout })
const pending = new Map()
rl.on("line", (l) => {
  const t = l.trim()
  if (!t) return
  let m
  try {
    m = JSON.parse(t)
  } catch {
    return
  }
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
let id = 1
const send = (method, params) =>
  new Promise((res, rej) => {
    const n = id++
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 60000)
    pending.set(n, (m) => {
      clearTimeout(t)
      res(m)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
  })
const call = async (tool, args = {}) => {
  const r = await send("tools/call", { name: tool, arguments: { ...args, session: "fg" } })
  const res = r.result ?? {}
  const sc = res.structuredContent ?? {}
  return {
    code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"),
    sc,
    text: (res.content ?? []).map((c) => c.text ?? "").join(" "),
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const shoot = async (w, tag) => {
  const r = await call("get_window_state", {
    pid: w.pid,
    window_id: w.window_id,
    max_elements: 50,
    include_screenshot: true,
    max_image_dimension: 0,
    screenshot_out_file: `${OUT}\\fg-${tag}.png`,
  })
  return { id: r.sc?.capture_id, sc: r.sc, code: r.code }
}

;(async () => {
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fg-probe", version: "1" } })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

  const wins = (await call("list_windows")).sc?.windows ?? []
  const calc = wins.find((w) => /calculator|\u8ba1\u7b97\u5668/i.test(w.title ?? "") && /CalculatorApp/i.test(w.app_name ?? ""))
  if (!calc) {
    console.log("no CalculatorApp window")
    return
  }
  console.log(`  target pid=${calc.pid} window_id=${calc.window_id} "${calc.title}"`)
  console.log(`  bounds ${calc.bounds?.width}x${calc.bounds?.height} @ ${calc.bounds?.x},${calc.bounds?.y}`)

  console.log("\n=== escalation ladder for one pixel click on C ===")
  for (const mode of ["background", "foreground"]) {
    const cap = await shoot(calc, `probe-${mode}`)
    const r = await call("click", {
      pid: calc.pid,
      window_id: calc.window_id,
      x: KEYS[0].x,
      y: KEYS[0].y,
      capture_id: cap.id,
      delivery_mode: mode,
    })
    console.log(`  ${mode.padEnd(10)} -> code=${r.code}`)
    console.log(`             text=${r.text.slice(0, 150).replace(/\n/g, " | ")}`)
    if (r.sc && Object.keys(r.sc).length) {
      const interesting = Object.fromEntries(Object.entries(r.sc).filter(([k]) => !["elements", "tree_markdown"].includes(k)))
      console.log(`             sc=${JSON.stringify(interesting).slice(0, 320)}`)
    }
    await sleep(600)
  }

  console.log("\n=== full sequence on foreground ===")
  for (const k of KEYS) {
    const cap = await shoot(calc, `seq-${k.name}`)
    const r = await call("click", {
      pid: calc.pid,
      window_id: calc.window_id,
      x: k.x,
      y: k.y,
      capture_id: cap.id,
      delivery_mode: "foreground",
    })
    console.log(`    ${k.name.padEnd(6)} @(${k.x},${k.y}) -> ${r.code}  ${r.text.slice(0, 60).replace(/\n/g, " ")}`)
    await sleep(450)
  }

  await sleep(900)
  const end = await shoot(calc, "final")
  console.log(`\n  final screenshot: ${OUT}\\fg-final.png  (capture ${end.id})`)
  console.log("  Read it by eye: this app exposes no accessibility text, so the display")
  console.log("  cannot be asserted from any response the driver returns.")
})()
  .catch((e) => console.log("ERROR", e.message))
  .finally(async () => {
    child.stdin.end()
    await sleep(500)
    child.kill()
  })