// Focused: is a manifest-listed, driver-launched app actually addressable?
//
// The previous run refused get_window_state on charmap even though the manifest
// lists C:\Windows\System32\charmap.exe and that is the real owning path. Either
// the pid passed was not charmap's, or the app scope needs something else.
// This re-derives the pid from list_windows by app_name only, and prints every
// step so the refusal can be attributed.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const MANIFEST = "D:\\compterusedkill\\config\\cua-bounded.yaml"

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
    const t = setTimeout(() => rej(new Error("timeout " + method)), 40000)
    pending.set(n, (m) => {
      clearTimeout(t)
      res(m)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
  })
const call = async (tool, args) => {
  const r = await send("tools/call", { name: tool, arguments: { ...args, session: "focus" } })
  const res = r.result ?? {}
  const sc = res.structuredContent ?? {}
  return { code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"), sc, text: (res.content ?? []).map((c) => c.text ?? "").join(" ") }
}

;(async () => {
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "focus", version: "1" } })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

  // Close any stale charmap first so the pid we find is definitely ours.
  const pre = await call("list_windows", {})
  const stale = (pre.sc?.windows ?? []).filter((w) => /charmap/i.test(w.app_name ?? ""))
  for (const w of stale) await call("kill_app", { pid: w.pid })
  await new Promise((r) => setTimeout(r, 1500))

  const l = await call("launch_app", { path: "C:\\Windows\\System32\\charmap.exe" })
  console.log(`launch_app: code=${l.code}  ${l.text.slice(0, 140).replace(/\n/g, " | ")}`)
  await new Promise((r) => setTimeout(r, 4000))

  const w = await call("list_windows", {})
  const wins = w.sc?.windows ?? []
  console.log(`\nwindows (${wins.length}):`)
  for (const x of wins) console.log(`  pid=${String(x.pid).padStart(6)} ${x.app_name} "${x.title}"`)

  // Match on app_name only, so the title cannot mislead the selection.
  const cm = wins.filter((x) => /charmap/i.test(x.app_name ?? ""))
  console.log(`\ncharmap windows by app_name: ${cm.length}`)
  for (const x of cm) {
    const r = await call("get_window_state", { pid: x.pid, window_id: x.window_id, max_elements: 25, include_screenshot: false })
    console.log(`  pid=${x.pid} wid=${x.window_id} -> code=${r.code} elements=${(r.sc?.elements ?? []).length}`)
    if (r.code !== "ok") console.log(`     text: ${r.text.slice(0, 220)}`)
    else {
      const el = (r.sc?.elements ?? []).filter((e) => (e.actions ?? []).length > 0).slice(0, 5)
      el.forEach((e) => console.log(`     [${e.element_index}] ${e.role} "${e.label}" [${e.actions.join(",")}]`))
    }
    await call("kill_app", { pid: x.pid })
  }
  child.stdin.end()
  await new Promise((r) => setTimeout(r, 400))
  child.kill()
})().catch((e) => {
  console.log("ERROR", e.message)
  child.kill()
  process.exit(1)
})
