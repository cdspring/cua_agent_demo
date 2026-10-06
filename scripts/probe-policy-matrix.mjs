// Does allow.rules constrain arguments, or is it parsed-and-ignored?
//
// Measured so far, with type_text in BOTH allow.tools and allow.rules:
//   type_text 600 chars  -> ok, wrote all 600   (max_length 500 not enforced)
//   type_text CJK       -> ok, wrote 中文       (ASCII-only pattern not enforced)
//
// One hypothesis explains that and is worth separating from the alternative:
// allow.tools may grant a tool UNCONDITIONALLY and short-circuit allow.rules, so
// listing type_text in both means the rule never gets a chance to bind. Under that
// model the rules work but only for tools NOT in allow.tools.
//
// Four variants, one variable moved at a time. Match on the refusal text rather
// than on a loose pattern: the first draft tested /pattern/i and "ValuePattern" in
// a SUCCESS message matched it, producing a false positive.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdirSync, writeFileSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const DIR = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
mkdirSync(DIR, { recursive: true })

const RULES = `  rules:
    - tool: type_text
      constraints:
        text:
          max_length: 500
          pattern: "^[\\\\x20-\\\\x7E\\\\n\\\\t]*$"
`

const VARIANTS = [
  {
    name: "A control: allow.tools only, no rules",
    yaml: `allow:
  tools:
    - list_windows
    - get_window_state
    - launch_app
    - kill_app
    - type_text
`,
  },
  {
    name: "B rules only, type_text NOT in allow.tools",
    yaml: `allow:
  tools:
    - list_windows
    - get_window_state
    - launch_app
    - kill_app
${RULES}`,
  },
  {
    name: "C both allow.tools and rules",
    yaml: `allow:
  tools:
    - list_windows
    - get_window_state
    - launch_app
    - kill_app
    - type_text
${RULES}`,
  },
  {
    name: "D rules only, no pattern, max_length 10",
    yaml: `allow:
  tools:
    - list_windows
    - get_window_state
    - launch_app
    - kill_app
  rules:
    - tool: type_text
      constraints:
        text:
          max_length: 10
`,
  },
]

function client(env) {
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
      const r = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "matrix", version: "1" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },
    async call(tool, args = {}) {
      const r = await send("tools/call", { name: tool, arguments: { ...args, session: `m${id}` } })
      const res = r.result ?? {}
      const sc = res.structuredContent ?? {}
      return { code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"), sc, text: (res.content ?? []).map((c) => c.text ?? "").join(" ") }
    },
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const v of VARIANTS) {
  console.log(`\n########## ${v.name} ##########`)
  const p = `${DIR}\\matrix-${v.name.charAt(0)}.yaml`
  writeFileSync(p, v.yaml, "utf8")
  const c = client({ CUA_DRIVER_POLICY_FILE: p })
  const init = await c.init()
  if (!init.result) {
    console.log(`  driver refused to start`)
    c.child.kill()
    continue
  }

  const scratch = `${DIR}\\mx-${Date.now()}-${v.name.charAt(0)}.txt`
  writeFileSync(scratch, "seed\r\n", "utf8")
  const nm = scratch.split("\\").pop()
  await c.call("launch_app", { path: "C:\\Windows\\System32\\notepad.exe", additional_arguments: [scratch] })
  let np = null
  for (let i = 0; i < 10 && !np; i++) {
    await sleep(900)
    np = ((await c.call("list_windows")).sc?.windows ?? []).find((w) => /notepad/i.test(w.app_name ?? "") && (w.title ?? "").includes(nm))
  }
  if (!np) {
    console.log(`  scratch notepad unavailable`)
    c.child.stdin.end()
    await sleep(300)
    c.child.kill()
    continue
  }

  const fresh = async () => {
    const s = (await c.call("get_window_state", { pid: np.pid, window_id: np.window_id, max_elements: 500, include_screenshot: false })).sc ?? {}
    return (s.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))
  }
  const tryType = async (text) => {
    const f = await fresh()
    if (!f) return { code: "no-field", text: "" }
    return c.call("type_text", { element_token: f.element_token, pid: np.pid, text })
  }

  const r600 = await tryType("A".repeat(600))
  console.log(`  600 A's      -> ${r600.code}   ${r600.text.slice(0, 90).replace(/\n/g, " ")}`)
  const rCJK = await tryType("\u4e2d\u6587")
  console.log(`  CJK          -> ${rCJK.code}   ${rCJK.text.slice(0, 90).replace(/\n/g, " ")}`)

  const doc = ((await c.call("get_window_state", { pid: np.pid, window_id: np.window_id, max_elements: 500, include_screenshot: false })).sc ?? {})
  const val = (doc.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))?.value ?? ""
  const wroteA = /A{50,}/.test(val)
  const wroteCJK = /[\u4e00-\u9fff]/.test(val)
  console.log(`  -> document has 600 A's: ${wroteA}   has CJK: ${wroteCJK}`)
  console.log(`  -> VERDICT: ${wroteA ? "max_length NOT enforced" : "max_length ENFORCED"} / ${wroteCJK ? "pattern NOT enforced" : "pattern ENFORCED"}`)

  await c.call("kill_app", { pid: np.pid })
  c.child.stdin.end()
  await sleep(300)
  c.child.kill()
}