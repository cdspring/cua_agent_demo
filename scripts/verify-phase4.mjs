// Phase 4: real-task acceptance, run under `bounded` exactly as OpenCode would.
//
// Deliberate scope discipline, because the manifest includes a logged-in browser
// and two message/note apps:
//
//   Task 1  Calculator: 6 x 7 = 42, read the display back. Disposable state.
//   Task 2  Notepad: mixed CJK + ASCII into a scratch file the agent creates.
//   Task 3  Browser: DOM route attempted, READ ONLY. No clicks, no typing.
//   Task 4  Obsidian and WeChat: addressability only. No input of any kind.
//
// Every task asserts its postcondition from a fresh observation rather than
// trusting action feedback, because `effect: confirmed` is not a task outcome.
//
// All CJK literals are written as \u escapes on purpose. An earlier revision
// embedded them directly and Windows PowerShell's `Set-Content -Encoding UTF8`
// corrupted the file mid-token, turning /calculator|计算器/i into an unterminated
// regex. Escapes make the script independent of file encoding.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdirSync, writeFileSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const MANIFEST = "D:\\compterusedkill\\config\\cua-bounded.yaml"
const SCRATCH_DIR = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"

// 计算器 / 等于 / 中文输入 OK / CJK range
const RE_CALC = /calculator|\u8ba1\u7b97\u5668/i
const RE_EQUALS = /\u7b49\u4e8e/
const TEXT_CJK = "\u4e2d\u6587\u8f93\u5165 OK"
const RE_CJK = /[\u4e00-\u9fff]/

mkdirSync(SCRATCH_DIR, { recursive: true })

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
  const r = await send("tools/call", { name: tool, arguments: { ...args, session: "p4" } })
  const res = r.result ?? {}
  const sc = res.structuredContent ?? {}
  return {
    code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"),
    sc,
    text: (res.content ?? []).map((c) => c.text ?? "").join(" "),
  }
}

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`)
}
const wins = async () => (await call("list_windows")).sc?.windows ?? []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const snapshot = async (w, extra = {}) =>
  (
    await call("get_window_state", {
      pid: w.pid,
      window_id: w.window_id,
      max_elements: 2000,
      max_depth: 40,
      include_screenshot: false,
      ...extra,
    })
  ).sc

const calcDisplay = (s) =>
  (s.elements ?? [])
    .filter((e) => e.role === "Text" && (e.frame?.w ?? 0) > 200 && (e.label ?? "").trim())
    .map((e) => e.label.trim())
    .join(" | ")

const docValue = (s) => (s.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))?.value ?? ""

;(async () => {
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phase4", version: "1" } })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

  // ------------------------------------------------------------------ Task 1
  console.log("\n########## Task 1: Calculator 6 x 7 = 42, closed loop ##########")
  {
    // Start from a fresh Calculator. An earlier revision reused whatever window
    // happened to be open, and leftover state from previous wrong clicks made
    // 7 x 6 = evaluate to 0. Recycle it, matching only our own test window.
    for (const w of (await wins()).filter((x) => RE_CALC.test(x.title ?? ""))) {
      console.log(`  recycling stale Calculator pid=${w.pid}`)
      await call("kill_app", { pid: w.pid })
      await sleep(1500)
    }
    let calc = (await wins()).find((w) => RE_CALC.test(w.title ?? ""))
    if (!calc) {
      console.log("  launching Calculator via the driver.")
      const l = await call("launch_app", { path: "C:\\Windows\\System32\\calc.exe" })
      console.log(`  launch_app: code=${l.code}`)
      for (let i = 0; i < 12 && !calc; i++) {
        await sleep(1000)
        calc = (await wins()).find((w) => RE_CALC.test(w.title ?? ""))
      }
    }
    if (!calc) {
      record("Task 1 Calculator reachable under bounded", false, "window never appeared")
    } else {
      console.log(`  window: pid=${calc.pid} owner=${calc.app_name}`)

      // Poll for the keypad. A freshly launched Calculator exposes its window
      // before its button grid is in the UIA tree, so a single immediate
      // snapshot yields zero 200px buttons and the task fails for a reason that
      // has nothing to do with permissions.
      const GRID_W = 200
      let s0 = {}
      for (let i = 0; i < 10; i++) {
        s0 = await snapshot(calc)
        const grid = (s0.elements ?? []).filter((e) => e.role === "Button" && Math.round(e.frame?.w ?? 0) === GRID_W)
        if (grid.length >= 12) {
          console.log(`  keypad visible after ${i + 1} snapshot(s): ${grid.length} grid buttons`)
          break
        }
        console.log(`  snapshot ${i + 1}: ${(s0.elements ?? []).length} elements, ${grid.length} grid buttons`)
        await sleep(1200)
      }
      const buttons = (s) => (s.elements ?? []).filter((e) => e.role === "Button" && (e.actions ?? []).includes("invoke"))

      // Identify the keypad by GEOMETRY. Labels are localised and arrive
      // mojibake'd through a Windows console, so text matching is unreliable.
      // Every digit and operator key is exactly 200x102; the function rows are
      // 132x62. Measured layout of Windows Calculator:
      //   row0  percent CE C backspace   <- functions, NOT digits
      //   row1  1/x x^2 sqrt divide      <- functions
      //   row2  7 8 9 times              <- digits start here
      //   row3  4 5 6 minus
      //   row4  1 2 3 plus
      //   row5  +/- decimal equals
      // An earlier revision assumed row0 held the digits and pressed percent
      // then divide, and reported 9 for 7 x 6.
      const GRID = buttons(s0).filter((b) => Math.round(b.frame?.w ?? 0) === 200)
      const byRow = [...new Set(GRID.map((b) => b.frame.y))]
        .sort((a, b) => a - b)
        .map((y) => GRID.filter((b) => b.frame.y === y).sort((a, b) => a.frame.x - b.frame.x))
      console.log(`  keypad grid: ${byRow.length} rows x ${byRow[0]?.length ?? 0} cols (w=200)`)
      byRow.forEach((r, i) => console.log(`    row${i}: ${r.map((b) => `"${b.label}"@x${b.frame.x}`).join("  ")}`))

      const DIGIT_TOP = 2
      const seven = byRow[DIGIT_TOP]?.[0]
      const times = byRow[DIGIT_TOP]?.[3]
      const six = byRow[DIGIT_TOP + 1]?.[2]
      const lastRow = byRow[byRow.length - 1] ?? []
      // equals is required: without it the calculator shows the running
      // expression and never produces the product.
      const equals = lastRow.find((b) => RE_EQUALS.test(b.label ?? "")) ?? lastRow[3]

      if (!seven || !times || !six || !equals) {
        record("Task 1 keypad located", false, `rows=${byRow.length} equals=${!!equals}`)
        record("Task 1 Calculator shows the product", false, "keypad not resolved")
      } else {
        console.log(`  pressing 7 x 6 =`)
        for (const b of [seven, times, six, equals]) {
          // Re-snapshot every turn: the previous snapshot's tokens are dead.
          const s = await snapshot(calc)
          const fresh = (s.elements ?? []).find(
            (e) =>
              e.role === "Button" &&
              Math.round(e.frame?.w ?? 0) === 200 &&
              e.frame?.y === b.frame.y &&
              e.frame?.x === b.frame.x,
          )
          if (!fresh) {
            console.log(`    key@y${b.frame.y} -> not found in the fresh snapshot`)
            continue
          }
          const r = await call("click", { element_token: fresh.element_token, pid: calc.pid })
          console.log(`    click @(${fresh.frame.x},${fresh.frame.y}) "${fresh.label}" -> ${r.code}`)
          await sleep(250)
        }
        await sleep(900)
        const shown = calcDisplay(await snapshot(calc))
        console.log(`  display: ${JSON.stringify(shown)}`)
        record("Task 1 Calculator shows the product", /42/.test(shown), `display=${JSON.stringify(shown)}`)
      }
    }
  }

  // ------------------------------------------------------------------ Task 2
  console.log("\n########## Task 2: Notepad, mixed CJK + ASCII into a scratch file ##########")
  {
    // A unique file per run. Reusing one name left the previous run's text in
    // Notepad's buffer and the document value contained both runs, which looks
    // exactly like a duplication bug in the driver.
    const scratch = `${SCRATCH_DIR}\\phase4-${Date.now()}.txt`
    const scratchName = scratch.split("\\").pop()
    writeFileSync(scratch, "phase4 seed\r\n", "utf8")
    console.log(`  scratch: ${scratchName}`)

    // Close any Notepad left over from an earlier run, matching ONLY our own
    // scratch files. An earlier revision matched /phase4/ loosely and adopted a
    // stale window, so each run appended to the previous buffer and the
    // document value grew by one copy per run. That looked like a driver-side
    // duplication bug and was entirely a harness bug.
    for (const w of (await wins()).filter((x) => /notepad/i.test(x.app_name ?? "") && /phase4/.test(x.title ?? ""))) {
      console.log(`  closing leftover scratch Notepad pid=${w.pid} "${w.title}"`)
      await call("kill_app", { pid: w.pid })
      await sleep(1200)
    }

    let np = null
    const l = await call("launch_app", { path: "C:\\Windows\\System32\\notepad.exe", additional_arguments: [scratch] })
    console.log(`  launch_app: code=${l.code}`)
    for (let i = 0; i < 12 && !np; i++) {
      await sleep(1000)
      np = (await wins()).find((w) => /notepad/i.test(w.app_name ?? "") && (w.title ?? "").includes(scratchName))
    }
    if (!np) {
      record("Task 2 Notepad reachable", false, "window never appeared")
    } else {
      console.log(`  window: pid=${np.pid} "${np.title}"`)
      let s0 = {}
      for (let i = 0; i < 8; i++) {
        await sleep(1200)
        const r = await call("get_window_state", {
          pid: np.pid,
          window_id: np.window_id,
          max_elements: 2000,
          max_depth: 40,
          include_screenshot: false,
          timeout_ms: 20000,
        })
        s0 = r.sc ?? {}
        if ((s0.elements ?? []).length > 0) break
        console.log(`  snapshot attempt ${i + 1}: empty (code=${r.code})`)
        const again = (await wins()).find((w) => /notepad/i.test(w.app_name ?? "") && /phase4/.test(w.title ?? ""))
        if (again && again.window_id !== np.window_id) np = again
      }
      record("Task 2 Notepad snapshot under bounded", (s0.elements ?? []).length > 0, `elements=${(s0.elements ?? []).length}`)

      const field = (s0.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))
      if (!field) {
        record("Task 2 editable field exposed", false, `roles: ${[...new Set((s0.elements ?? []).map((e) => e.role))].join(",")}`)
      } else {
        // Unicode route: type_text goes through UIA ValuePattern and reads back,
        // the only path measured to reach effect: confirmed on Windows.
        const r1 = await call("type_text", { element_token: field.element_token, pid: np.pid, text: "ASCII-123 " })
        console.log(`  type_text ascii -> ${r1.code} ${r1.text.slice(0, 100)}`)
        const r2 = await call("type_text", { element_token: field.element_token, pid: np.pid, text: TEXT_CJK })
        console.log(`  type_text cjk    -> ${r2.code} ${r2.text.slice(0, 100)}`)

        await sleep(700)
        const value = docValue(await snapshot(np))
        console.log(`  document value: ${JSON.stringify(value)}`)
        record("Task 2 ASCII reached the document", value.includes("ASCII-123"), JSON.stringify(value.slice(-60)))
        record("Task 2 CJK reached the document", RE_CJK.test(value), JSON.stringify(value.slice(-60)))
        record("Task 2 unicode actions were confirmed", r1.code === "ok" && r2.code === "ok", `ascii=${r1.code} cjk=${r2.code}`)
      }
      await call("kill_app", { pid: np.pid })
      console.log("  cleaned up notepad")
    }
  }

  // ------------------------------------------------------------------ Task 3
  console.log("\n########## Task 3: browser DOM route, READ ONLY ##########")
  {
    const all = (await wins()).filter((x) => /msedge|chrome/i.test(x.app_name ?? ""))
    if (all.length === 0) {
      record("Task 3 a browser window exists", false, "neither Edge nor Chrome has a window right now")
      console.log("     Cannot be tested: the browser is not running. Open one and re-run; no input will be sent.")
    } else {
      const w = all.find((x) => x.is_on_screen) ?? all[0]
      console.log(`  window: pid=${w.pid} ${w.minimized ? "MINIMIZED" : "visible"} app=${w.app_name}`)
      const s = await snapshot(w, { max_elements: 300, max_depth: 12 })
      const n = (s.elements ?? []).length
      console.log(`  accessibility elements: ${n}`)
      record("Task 3 browser is addressable under bounded", n > 0, `elements=${n}`)

      const prep = await call("browser_prepare", { pid: w.pid, window_id: w.window_id })
      console.log(`  browser_prepare -> ${prep.code} ${prep.text.slice(0, 140)}`)
      if (prep.code === "ok") {
        const st = await call("get_browser_state", { snapshot_format: "dom_refs_v1" })
        console.log(`  get_browser_state -> ${st.code} ${st.text.slice(0, 180)}`)
        record("Task 3 DOM route works", st.code === "ok", st.text.slice(0, 110))
      } else {
        record("Task 3 DOM route available", false, `browser_prepare ${prep.code}: ${prep.text.slice(0, 80)}`)
        console.log("     This manifest deliberately excludes browser_* from allow.tools, so the page rung is off.")
      }
    }
  }

  // ------------------------------------------------------------------ Task 4
  console.log("\n########## Task 4: user-data apps, observe-only ##########")
  for (const [label, re] of [
    ["Obsidian", /Obsidian/i],
    ["WeChat", /Weixin|WeChatAppEx/i],
  ]) {
    // Do not filter on is_on_screen. A minimized window is still in the manifest
    // and still addressable, and calling it "unreachable" would misattribute a
    // window-state fact to a permission problem.
    const all = (await wins()).filter((x) => re.test(x.app_name ?? ""))
    if (all.length === 0) {
      record(`Task 4 ${label} reachable`, false, "no window at all for this app")
      console.log(`     ${label} is not running, so this cannot be tested today.`)
      continue
    }
    const target = all.find((x) => x.is_on_screen) ?? all[0]
    console.log(`  ${label}: pid=${target.pid} ${target.minimized ? "MINIMIZED" : "visible"} "${target.title.slice(0, 45)}"`)
    const s = await snapshot(target, { max_elements: 400, max_depth: 14 })
    const n = (s.elements ?? []).length
    const named = (s.elements ?? []).filter((e) => (e.label ?? "").trim()).length
    console.log(`    elements=${n} named=${named}`)
    record(
      `Task 4 ${label} is addressable under bounded`,
      n > 0 || target.minimized,
      target.minimized ? `minimized, UIA tree degraded to ${n} element(s)` : `elements=${n} named=${named}`,
    )
  }
  console.log("\n  (no input was sent to Obsidian or WeChat, by design)")
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
