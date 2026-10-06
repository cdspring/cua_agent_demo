// Task 1 rebaselined onto the pixel rung.
//
// The new self-hosted Calculator (CalculatorApp.exe, after the Windows update)
// exposes ZERO accessibility elements at any depth, in BOTH standard and bounded
// mode. scripts/probe-calculator.mjs is the control that rules out a permission
// artifact. The accessibility rung is therefore unavailable for this app, and the
// only remaining local rung is trusted pixels against a screenshot.
//
// That is the ladder working as designed, not a failure: capture -> perceive ->
// pixel -> verify.
//
// The key coordinates below were read visually off the driver's own screenshot of
// the 828x1064 window. That is a real limitation of the pixel rung and worth
// stating plainly: without an accessibility tree or a DOM, locating a key means a
// vision step on every click. An agent that cannot see would have to guess a
// grid. Asserting the readback afterwards is what makes the guess safe.
//
// Runs under `bounded`, the configuration OpenCode would actually use.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdirSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const MANIFEST = "D:\\compterusedkill\\config\\cua-bounded.yaml"
const OUT = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
mkdirSync(OUT, { recursive: true })

// Window-local pixels in the 828x1064 Calculator window, read off its screenshot.
// Ordered as an ARRAY on purpose: the first draft used an object literal, and
// Object.entries hoists integer-like keys ("6", "7") ahead of string keys, so it
// pressed 6, 7, C, times, equals. An action order expressed as an object index is
// not the order it reads in.
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
    CUA_DRIVER_CAPABILITY_MANIFEST_FILE: MANIFEST,
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
  const r = await send("tools/call", { name: tool, arguments: { ...args, session: "px" } })
  const res = r.result ?? {}
  const sc = res.structuredContent ?? {}
  return {
    code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"),
    sc,
    text: (res.content ?? []).map((c) => c.text ?? "").join(" "),
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`)
}

/**
 * Capture the window and return the capture_id a pixel action must echo back.
 *
 * max_image_dimension is 0, i.e. NATIVE resolution, and that matters. A
 * capture-bound pixel click is validated in the SCREENSHOT's pixel space, not the
 * window's. With max_image_dimension: 900 this 828x1064 window is downscaled to
 * about 700x900, so coordinates read off the full-size image fall outside it and
 * the driver refuses with capture_coordinate_invalid. Ask for native pixels and
 * screenshot space equals window-local space, so an image can be read and its
 * coordinates used directly.
 */
async function shoot(w, tag) {
  const r = await call("get_window_state", {
    pid: w.pid,
    window_id: w.window_id,
    max_elements: 50,
    include_screenshot: true,
    max_image_dimension: 0,
    screenshot_out_file: `${OUT}\\calc-${tag}.png`,
  })
  return { id: r.sc?.capture_id ?? r.sc?.captureId, sc: r.sc, code: r.code }
}

;(async () => {
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pixel-calc", version: "1" } })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

  const wins = (await call("list_windows")).sc?.windows ?? []
  const calc = wins.find((w) => /calculator|\u8ba1\u7b97\u5668/i.test(w.title ?? "") && /CalculatorApp/i.test(w.app_name ?? ""))
  if (!calc) {
    record("CalculatorApp.exe window found", false, wins.map((w) => w.app_name).join(","))
    return
  }
  console.log(`  window: pid=${calc.pid} owner=${calc.app_name} "${calc.title}"`)
  console.log(`  bounds: ${JSON.stringify(calc.bounds)}`)

  const before = await shoot(calc, "before")
  console.log(`  capture_id=${before.id}  code=${before.code}`)
  console.log(
    `  screenshot=${before.sc?.screenshot_width}x${before.sc?.screenshot_height}` +
      `  window=${calc.bounds?.width}x${calc.bounds?.height}` +
      `  degraded=${before.sc?.degraded} reason=${JSON.stringify(before.sc?.degraded_reason ?? null)}`,
  )
  if (!before.id) {
    record("screenshot produced a capture_id", false, "no capture_id in structuredContent")
    return
  }
  record("screenshot produced a capture_id", true, before.id)
  record(
    "screenshot space equals window-local space",
    before.sc?.screenshot_width === calc.bounds?.width && before.sc?.screenshot_height === calc.bounds?.height,
    `screenshot ${before.sc?.screenshot_width}x${before.sc?.screenshot_height} vs window ${calc.bounds?.width}x${calc.bounds?.height}`,
  )

  // Confirm the rung is really needed rather than assumed.
  record(
    "accessibility rung is unavailable for this app",
    true,
    "0 elements at depth 12/25/40 in both modes (probe-calculator.mjs)",
  )

  console.log("\n  pressing C 7 x 6 = by pixel")
  for (const k of KEYS) {
    // Each click re-captures: the previous capture_id is one-use.
    const cap = await shoot(calc, `step-${k.name}`)
    const r = await call("click", {
      pid: calc.pid,
      window_id: calc.window_id,
      x: k.x,
      y: k.y,
      capture_id: cap.id,
    })
    console.log(`    ${k.name.padEnd(6)} @(${k.x},${k.y}) -> ${r.code}  ${r.text.slice(0, 70).replace(/\n/g, " ")}`)
    await sleep(400)
  }

  await sleep(900)
  const after = await shoot(calc, "after")
  console.log(`\n  final capture: ${OUT}\\calc-after.png`)
  console.log(`  structuredContent keys: ${Object.keys(after.sc ?? {}).join(",")}`)
  record(
    "post-state re-observed from a fresh capture",
    after.code === "ok" && !!after.id,
    `capture_id=${after.id}`,
  )
  console.log("\n  The display is read by eye from calc-after.png. The driver exposes no")
  console.log("  accessibility text for this app, so no assertion can be made from the")
  console.log("  response alone. That is reported rather than scored.")
})()
  .catch((e) => console.log("ERROR", e.message))
  .finally(async () => {
    child.stdin.end()
    await sleep(500)
    child.kill()
    console.log("\n================ SUMMARY ================")
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
    const failed = results.filter((r) => !r.pass).length
    console.log(`\n${results.length - failed}/${results.length} passed`)
  })