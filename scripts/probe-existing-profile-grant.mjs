// Does `serve --grant existing-profile` actually enable attaching to a running
// logged-in Chromium profile?
//
// Findings so far, all measured:
//   * `--grant existing-profile` is documented "(serve only)". The `mcp`
//     subcommand accepts it and silently ignores it: `mcp` and
//     `mcp --grant existing-profile` return byte-identical initialize responses,
//     and browser_prepare still answers browser_requires_setup.
//   * `cua-driver status` does not surface the grant either way, so status cannot
//     answer this question.
//   * A separate daemon started with the grant reports
//     `authorization host: unavailable (unavailable)`.
//
// So the only honest test is a real attempt. This spawns an MCP client against a
// daemon that was started with the grant and tries to attach to the user's real
// Edge. Read-only: it binds, lists tabs, and reads a snapshot. It does not
// navigate, click, type, or retrieve anything.
//
// It also cleans up the probe daemon it depends on, because leaving stray
// cua-driver processes around has already caused confusion in this project.
import { spawn, execFileSync } from "node:child_process"
import { createInterface } from "node:readline"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const SOCK = "\\\\.\\pipe\\cua-driver-grant-probe"

function client(extraArgs) {
  const child = spawn(EXE, ["mcp", ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] })
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
      const r = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "granttest", version: "1" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },
    async call(tool, args = {}) {
      const r = await send("tools/call", { name: tool, arguments: { ...args, session: "grant" } })
      const res = r.result ?? {}
      const sc = res.structuredContent ?? {}
      return { code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"), sc, text: (res.content ?? []).map((c) => c.text ?? "").join(" ") }
    },
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. make sure a granted daemon is running on the probe socket
let status = ""
try {
  status = execFileSync(EXE, ["status", "--socket", SOCK], { encoding: "utf8", timeout: 20000 })
} catch {
  console.log("no probe daemon running; starting one")
  spawn(EXE, ["serve", "--grant", "existing-profile", "--socket", SOCK], { detached: true, stdio: "ignore" }).unref()
  await sleep(4000)
  status = execFileSync(EXE, ["status", "--socket", SOCK], { encoding: "utf8", timeout: 20000 })
}
console.log("=== probe daemon ===")
console.log(status.split("\n").map((l) => "  " + l).join("\n"))

console.log("\n=== an MCP client bound to that daemon ===")
const c = client(["--socket", SOCK])
const init = await c.init()
console.log(`  initialize: ${init.result ? "ok" : "FAILED"}`)

const wins = (await c.call("list_windows")).sc?.windows ?? []
const edge = wins.find((w) => /msedge/i.test(w.app_name ?? "") && w.is_on_screen)
console.log(`  Edge found: ${edge ? `pid=${edge.pid} hwnd=${edge.window_id} "${edge.title.slice(0, 60)}"` : "NO"}`)

if (edge) {
  console.log("\n=== browser_prepare against the user's real profile ===")
  const p = await c.call("browser_prepare", { pid: edge.pid, window_id: edge.window_id })
  console.log(`  -> ${p.code}`)
  console.log(`     ${p.text.slice(0, 300).replace(/\n/g, " | ")}`)

  if (p.code === "ok") {
    const preparedPid = p.sc?.prepared_pid
    console.log(`  prepared_pid=${preparedPid}  (this is the EXISTING browser, not a spawned one)`)
    console.log(`  side_effects: ${JSON.stringify(p.sc?.side_effects)}`)
    const own = preparedPid ? (await c.call("list_windows", { pid: preparedPid })).sc?.windows ?? [] : []
    const w = own.find((x) => !x.minimized) ?? own[0]
    if (w) {
      const bind = await c.call("get_browser_state", { pid: w.pid, window_id: w.window_id })
      console.log(`  bind -> ${bind.code}  ${bind.text.slice(0, 200).replace(/\n/g, " | ")}`)
      const targetId = bind.sc?.target_id ?? bind.sc?.targetID
      const tabs = bind.sc?.tabs ?? []
      console.log(`  tabs: ${tabs.length}`)
      for (const tb of tabs.slice(0, 8)) console.log(`    ${(tb.title ?? "").slice(0, 60)}  ${(tb.url ?? "").slice(0, 70)}`)
    }
  }
}

c.child.stdin.end()
await sleep(400)
c.child.kill()

console.log("\n=== cleaning up the probe daemon ===")
try {
  execFileSync(EXE, ["stop", "--socket", SOCK], { encoding: "utf8", timeout: 20000 })
  console.log("  stopped")
} catch (e) {
  console.log(`  stop failed: ${e.message}`)
}
console.log("  note: the default daemon and the OpenCode MCP connection were not touched.")