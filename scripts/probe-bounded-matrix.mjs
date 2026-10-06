// Which observation tools survive `desktop.display: false`?
//
// bounded runs seven narrowing layers. Tool permission is only layer 5; the
// capability manifest at layer 6 can still refuse a tool whose NAME is
// allowed, because the resource it touches is out of scope.
//
// This decides whether a bounded manifest is usable at all: to act on an app
// the agent must first learn its pid and window_id, and if every discovery tool
// is refused the manifest deadlocks.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"

function client(env) {
  const child = spawn(EXE, ["mcp"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } })
  const rl = createInterface({ input: child.stdout })
  const pending = new Map()
  let stderr = ""
  child.stderr.on("data", (d) => (stderr += d.toString()))
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
      const t = setTimeout(() => rej(new Error("timeout " + method)), 40000)
      pending.set(n, (m) => {
        clearTimeout(t)
        res(m)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
    })
  return {
    child,
    stderr: () => stderr,
    async init() {
      const r = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "matrix", version: "1.0.0" },
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },
    async call(tool, args = {}) {
      const r = await send("tools/call", { name: tool, arguments: { ...args, session: "matrix" } })
      const res = r.result ?? {}
      const sc = res.structuredContent ?? {}
      return {
        code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"),
        message: (res.content ?? []).map((c) => c.text ?? "").join(" ").slice(0, 110),
        sc,
      }
    },
  }
}

async function probe(manifestEnv, label) {
  console.log(`\n########## ${label} ##########`)
  const c = client(manifestEnv)
  const init = await c.init()
  if (!init.result) {
    console.log(`  init failed: ${c.stderr().slice(0, 300)}`)
    c.child.kill()
    return
  }
  const DISCOVERY = ["list_windows", "list_apps", "get_accessibility_tree", "get_screen_size"]
  const INPUT = ["launch_app", "click", "type_text"]
  const OUT_OF_SCOPE = ["get_desktop_state", "get_browser_state", "start_recording", "install_extension"]

  const rows = []
  for (const t of [...DISCOVERY, ...INPUT]) {
    // launch_app with no path is harmless: it fails on arguments, not permission.
    const args = t === "launch_app" ? { path: "C:\\Windows\\System32\\charmap.exe" } : {}
    const r = await c.call(t, args)
    rows.push([t, r.code, r.message])
  }
  console.log("\n  tool                      result")
  for (const [t, code, msg] of rows) {
    const verdict = code === "ok" ? "ALLOWED " : code === "permission_denied" ? "denied  " : code === "bounded_resource_outside_manifest" ? "out-of-scope" : `? ${code}`
    console.log(`  ${t.padEnd(25)} ${verdict}  ${msg.slice(0, 60)}`)
  }

  console.log("\n  out-of-scope tools (expected to be refused):")
  for (const t of OUT_OF_SCOPE) {
    const r = await c.call(t, {})
    console.log(`  ${t.padEnd(25)} ${r.code}`)
  }

  const discoveryBlocked = rows.filter(([t]) => DISCOVERY.includes(t) && t !== "get_screen_size").filter(([, code]) => code !== "ok")
  console.log(`\n  deadlock risk: ${discoveryBlocked.length ? `YES — ${discoveryBlocked.map(([t]) => t).join(", ")} refused` : "no, discovery works"}`)
  c.child.stdin.end()
  await new Promise((r) => setTimeout(r, 400))
  c.child.kill()
}

const BASE = {
  CUA_DRIVER_PERMISSION_MODE: "bounded",
  CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
}

await probe(
  { ...BASE, CUA_DRIVER_CAPABILITY_MANIFEST_FILE: "D:\\compterusedkill\\config\\cua-bounded.yaml" },
  "desktop.display: false  (current manifest)",
)
