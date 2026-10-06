// C8, the decisive experiment: does the UIAccess worker unlock foreground input?
//
// Everything measured so far points here.
//
//   * the desktop, window station (WinSta0), thread desktop (Default) and INPUT
//     desktop are all correct
//   * a foreground window does exist and is stable (0x4066E, Chrome_WidgetWin_1,
//     the user's Edge window)
//   * SetForegroundWindow from an independent process is REFUSED for all 21
//     candidate windows -- that is the Windows foreground lock, not a bug
//   * bring_to_front, which uses AttachThreadInput to defeat the lock, still
//     fails: "Windows kept foreground on hwnd 0x20818"
//   * bin/cua-driver-uia.exe EXISTS (22 MB), and both the MCP entry and the
//     autostart scheduled task invoke the non-UIA cua-driver.exe
//
// The driver's own tool documentation states the foreground path "requires the
// daemon to have UIAccess integrity so SetForegroundWindow is permitted, and the
// MCP proxy auto-prefers the cua-driver-uia.exe worker pipe".
//
// So: run the same foreground pixel click through cua-driver-uia.exe and see
// whether the calculator finally takes an input.
//
// This WILL move the real cursor and change the frontmost window for a moment.
// That is what foreground delivery is, and the driver restores the previous
// foreground afterwards. The user's apps are not otherwise touched.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdirSync } from "node:fs"

const OUT = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
mkdirSync(OUT, { recursive: true })

const BIN = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin"
const WORKERS = ["cua-driver.exe", "cua-driver-uia.exe"]

// The keys to press, in screenshot pixel space of the 828x1064 window.
const KEYS = [
  { name: "C", x: 516, y: 475 },
  { name: "7", x: 107, y: 687 },
  { name: "times", x: 718, y: 687 },
  { name: "6", x: 516, y: 793 },
  { name: "equals", x: 718, y: 1002 },
]

function client(exe) {
  const child = spawn(exe, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] })
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
  return {
    child,
    async init() {
      const r = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "uia", version: "1" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },
    async call(tool, args = {}) {
      const r = await send("tools/call", { name: tool, arguments: { ...args, session: "uia" } })
      const res = r.result ?? {}
      const sc = res.structuredContent ?? {}
      return { code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"), sc, text: (res.content ?? []).map((c) => c.text ?? "").join(" ") }
    },
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const worker of WORKERS) {
  console.log(`\n################ ${worker} ################`)
  const c = client(`${BIN}\\${worker}`)
  const init = await c.init()
  if (!init.result) {
    console.log(`  initialize failed`)
    c.child.kill()
    continue
  }

  const wins = (await c.call("list_windows")).sc?.windows ?? []
  const calc = wins.find((w) => /calculator|\u8ba1\u7b97\u5668/i.test(w.title ?? "") && /CalculatorApp/i.test(w.app_name ?? ""))
  if (!calc) {
    console.log(`  no CalculatorApp window`)
    c.child.kill()
    continue
  }
  console.log(`  calculator pid=${calc.pid} hwnd=${calc.window_id}`)

  const shoot = async (tag) => {
    const r = await c.call("get_window_state", {
      pid: calc.pid,
      window_id: calc.window_id,
      max_elements: 50,
      include_screenshot: true,
      max_image_dimension: 0,
      screenshot_out_file: `${OUT}\\uia-${worker.replace(/\.exe$/, "")}-${tag}.png`,
    })
    return r.sc?.capture_id
  }

  // Step 1: does bring_to_front succeed under this worker?
  console.log(`\n  --- bring_to_front ---`)
  const bf = await c.call("bring_to_front", { pid: calc.pid, window_id: calc.window_id })
  console.log(`    -> ${bf.code}  ${bf.text.slice(0, 170).replace(/\n/g, " | ")}`)
  await sleep(700)

  // Step 2: a single foreground pixel click on C. If the clear lands, the rung
  // is alive. Verified visually afterwards, not from the return code, because
  // this app has no accessibility text to read back.
  console.log(`\n  --- foreground pixel click on C ---`)
  const cap = await shoot("before")
  const r1 = await c.call("click", { pid: calc.pid, window_id: calc.window_id, x: KEYS[0].x, y: KEYS[0].y, capture_id: cap, delivery_mode: "foreground" })
  console.log(`    -> ${r1.code}  ${r1.text.slice(0, 170).replace(/\n/g, " | ")}`)
  await sleep(800)

  // Step 3: full sequence, if step 2 was not refused.
  if (!/foreground_unavailable|did not activate/i.test(r1.text)) {
    console.log(`\n  --- full sequence 7 x 6 = ---`)
    for (const k of KEYS.slice(1)) {
      const cp = await shoot(`s-${k.name}`)
      const r = await c.call("click", { pid: calc.pid, window_id: calc.window_id, x: k.x, y: k.y, capture_id: cp, delivery_mode: "foreground" })
      console.log(`    ${k.name.padEnd(6)} -> ${r.code}`)
      await sleep(450)
    }
    await sleep(900)
  }
  await shoot("after")
  console.log(`\n  screenshot: ${OUT}\\uia-${worker.replace(/\.exe$/, "")}-after.png  (read it by eye)`)

  c.child.stdin.end()
  await sleep(400)
  c.child.kill()
}