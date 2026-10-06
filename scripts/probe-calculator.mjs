// Control test: does the new self-hosted Calculator expose a UIA tree at all?
//
// Phase 4 Task 1 passed earlier when the window was owned by
// ApplicationFrameHost.exe, and now returns zero elements consistently when the
// owner is CalculatorApp.exe (the post-update self-hosted build). That could be
// a bounded permission artifact, or a genuine change in what the app exposes.
// Run it in STANDARD mode to tell the two apart.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"

function client(env = {}) {
  const child = spawn(EXE, ["mcp"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } })
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
      const t = setTimeout(() => rej(new Error("timeout " + method)), 45000)
      pending.set(n, (m) => {
        clearTimeout(t)
        res(m)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
    })
  return {
    child,
    async init() {
      const r = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "calc-control", version: "1" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },
    async call(tool, args = {}) {
      const r = await send("tools/call", { name: tool, arguments: { ...args, session: "cc" } })
      const res = r.result ?? {}
      const sc = res.structuredContent ?? {}
      return { code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"), sc, text: (res.content ?? []).map((c) => c.text ?? "").join(" ") }
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const mode of ["standard", "bounded"]) {
  console.log(`\n########## Calculator in ${mode} mode ##########`)
  const env =
    mode === "bounded"
      ? {
          CUA_DRIVER_PERMISSION_MODE: "bounded",
          CUA_DRIVER_CAPABILITY_MANIFEST_FILE: "D:\\compterusedkill\\config\\cua-bounded.yaml",
          CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
        }
      : {}
  const c = client(env)
  const init = await c.init()
  if (!init.result) {
    console.log(`  init failed`)
    c.child.kill()
    continue
  }
  const w = await c.call("list_windows")
  const wins = w.sc?.windows ?? []
  const calc = wins.filter((x) => /calculator|\u8ba1\u7b97\u5668/i.test(x.title ?? ""))
  if (calc.length === 0) {
    console.log("  no calculator window")
    c.child.kill()
    continue
  }
  for (const target of calc) {
    console.log(`  pid=${target.pid} owner=${target.app_name} minimized=${target.minimized}`)
    for (const depth of [12, 25, 40]) {
      const s = await c.call("get_window_state", {
        pid: target.pid,
        window_id: target.window_id,
        max_elements: 3000,
        max_depth: depth,
        timeout_ms: 25000,
        include_screenshot: false,
      })
      const n = (s.sc?.elements ?? []).length
      const grid = (s.sc?.elements ?? []).filter((e) => Math.round(e.frame?.w ?? 0) === 200).length
      console.log(`    max_depth=${String(depth).padStart(2)} -> code=${s.code} elements=${n} grid200=${grid} truncated=${s.sc?.truncated ?? false} complete=${s.sc?.elements_complete}`)
    }
    // Does the tree exist at all if we ask for the screenshot only?
    const shotOnly = await c.call("get_window_state", {
      pid: target.pid,
      window_id: target.window_id,
      include_accessibility_tree: false,
      include_screenshot: true,
      max_image_dimension: 400,
    })
    console.log(`    screenshot-only path -> code=${shotOnly.code} ${shotOnly.text.slice(0, 90)}`)
  }
  c.child.stdin.end()
  await sleep(300)
  c.child.kill()
}
