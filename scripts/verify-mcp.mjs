// MCP stdio handshake against cua-driver, performed the same way OpenCode
// performs it. This is the actual Phase 2 question: will OpenCode be able to
// connect and list tools?
//
// Reads no screen state and sends no input, so it has no side effects.
//
// Protocol: JSON-RPC 2.0 over newline-delimited stdio.
//   -> initialize
//   <- result (protocolVersion, capabilities, serverInfo)
//   -> notifications/initialized
//   -> tools/list
//   <- result.tools[]
//   -> tools/call get_screen_size   (a trivially safe read)
//   <- result
//   -> shutdown / process exit
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"

const child = spawn(EXE, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] })
const rl = createInterface({ input: child.stdout })
let stderr = ""
child.stderr.on("data", (d) => (stderr += d.toString()))

const pending = new Map()
rl.on("line", (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try {
    msg = JSON.parse(t)
  } catch {
    console.log("non-JSON stdout:", t.slice(0, 200))
    return
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

let nextId = 1
function send(method, params) {
  const id = nextId++
  const payload = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for ${method}`))
    }, 30000)
    pending.set(id, (m) => {
      clearTimeout(timer)
      resolve(m)
    })
    child.stdin.write(JSON.stringify(payload) + "\n")
  })
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n")
}

const ok = (label, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`)
  return cond
}

;(async () => {
  console.log("=== 1. initialize ===")
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "phase2-verify", version: "1.0.0" },
  })
  const r = init.result ?? {}
  ok("handshake returned a result", !!init.result, init.error ? JSON.stringify(init.error) : "")
  console.log(`     protocolVersion: ${r.protocolVersion}`)
  console.log(`     serverInfo     : ${JSON.stringify(r.serverInfo)}`)
  console.log(`     capabilities   : ${Object.keys(r.capabilities ?? {}).join(", ") || "(none)"}`)
  notify("notifications/initialized")

  console.log("\n=== 2. tools/list ===")
  const tools = await send("tools/list", {})
  const list = tools.result?.tools ?? []
  ok("tools advertised", list.length > 0, `${list.length} tools`)

  // These are the tools routing.md tells the model to use. If any is missing,
  // the skill is documenting a surface that does not exist.
  const names = new Set(list.map((t) => t.name))
  const expected = [
    "get_window_state",
    "get_accessibility_tree",
    "get_desktop_state",
    "get_screen_size",
    "list_windows",
    "click",
    "double_click",
    "right_click",
    "type_text",
    "set_value",
    "press_key",
    "hotkey",
    "scroll",
    "drag",
    "move_cursor",
    "bring_to_front",
    "verify_state",
    "zoom",
    // `wait` was listed here at some point. There is no wait tool in 0.34.0 --
    // routing.md and SKILL.md both say so explicitly -- so this list was stale and
    // the check correctly reported it missing. Remove a name from this list when
    // the driver does not have the tool, rather than leaving the docs and the
    // checker disagreeing.
  ]
  const missing = expected.filter((n) => !names.has(n))
  ok("every tool named in routing.md exists", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "")

  const deprecated = ["escalate_session", "page", "get_session_state"].filter((n) => names.has(n))
  console.log(`     deprecated-but-present (documented as do-not-call): ${deprecated.join(", ") || "none"}`)

  const click = list.find((t) => t.name === "click")
  ok("click declares element_token and pid", !!click?.inputSchema?.properties?.element_token && !!click?.inputSchema?.properties?.pid, "")

  console.log("\n=== 3. a safe tool call over MCP ===")
  const size = await send("tools/call", { name: "get_screen_size", arguments: { session: "verify-mcp" } })
  const txt = (size.result?.content ?? []).map((c) => c.text ?? "").join(" ")
  ok("get_screen_size returned content", txt.length > 0, txt.slice(0, 160))
  const sc = size.result?.structuredContent
  if (sc) console.log(`     structuredContent: ${JSON.stringify(sc).slice(0, 200)}`)

  console.log("\n=== 4. structuredContent nesting ===")
  console.log("     MCP nests it under result.structuredContent; `cua-driver call` flattens it.")
  console.log(`     present in this MCP response: ${!!sc}`)

  console.log("\n=== 5. shutdown ===")
  try {
    await send("shutdown", {})
  } catch {}
  child.stdin.end()
  await new Promise((r) => child.on("close", r))
  ok("process exited cleanly on stdin EOF", child.exitCode === null || child.exitCode === 0, `exit=${child.exitCode}`)
  if (stderr.trim()) console.log(`     stderr: ${stderr.trim().slice(0, 200)}`)
})().catch((e) => {
  console.log("\nERROR:", e.message)
  if (stderr.trim()) console.log("stderr:", stderr.trim().slice(0, 500))
  child.kill()
  process.exit(1)
})
