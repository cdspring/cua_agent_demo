// Does the YAML policy enforce ARGUMENT constraints, not just tool names?
//
// probe-policy-enforcement.mjs established the first half: with
// CUA_DRIVER_POLICY_FILE set, a tool absent from allow.tools is refused with
// permission_denied. That also means allow.rules alone does NOT grant a tool —
// launch_app was refused even though a rule named it — so this probe puts
// launch_app in allow.tools in order to open a scratch target, and then tests
// the three argument constraints on type_text.
//
// Builds its own policy inline rather than reading config/cua-policy.yaml, so it
// can vary one variable at a time.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdirSync, writeFileSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const DIR = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
mkdirSync(DIR, { recursive: true })

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
      const t = setTimeout(() => rej(new Error("timeout " + method)), 60000)
      pending.set(n, (m) => {
        clearTimeout(t)
        res(m)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
    })
  return {
    child,
    async init() {
      const r = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "argpolicy", version: "1" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },
    async call(tool, args = {}) {
      const r = await send("tools/call", { name: tool, arguments: { ...args, session: "argpol" } })
      const res = r.result ?? {}
      const sc = res.structuredContent ?? {}
      return { code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"), sc, text: (res.content ?? []).map((c) => c.text ?? "").join(" ") }
    },
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// launch_app is in allow.tools so the probe can open its own scratch target. The
// ASCII-only pattern is deliberate: CJK must be refused for the test to prove the
// pattern operator binds at all.
const POLICY = `allow:
  tools:
    - list_windows
    - get_window_state
    - launch_app
    - kill_app
    - type_text
  rules:
    - tool: type_text
      constraints:
        text:
          max_length: 500
          pattern: "^[\\\\x20-\\\\x7E\\\\n\\\\t]*$"
`
const policyPath = `${DIR}\\argpolicy.yaml`
writeFileSync(policyPath, POLICY, "utf8")

const rows = []
const check = (name, pass, detail) => {
  rows.push({ name, pass })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`)
}

const c = client({ CUA_DRIVER_POLICY_FILE: policyPath })
await c.init()

const scratch = `${DIR}\\argpol-${Date.now()}.txt`
writeFileSync(scratch, "seed\r\n", "utf8")
const name = scratch.split("\\").pop()

const l = await c.call("launch_app", { path: "C:\\Windows\\System32\\notepad.exe", additional_arguments: [scratch] })
console.log(`  launch_app -> ${l.code}`)
let np = null
for (let i = 0; i < 12 && !np; i++) {
  await sleep(1000)
  np = ((await c.call("list_windows")).sc?.windows ?? []).find((w) => /notepad/i.test(w.app_name ?? "") && (w.title ?? "").includes(name))
}
if (!np) {
  console.log("  scratch notepad never appeared; inconclusive")
} else {
  let field = null
  for (let i = 0; i < 6 && !field; i++) {
    const s = (await c.call("get_window_state", { pid: np.pid, window_id: np.window_id, max_elements: 500, include_screenshot: false })).sc ?? {}
    field = (s.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))
    if (!field) await sleep(1000)
  }

  if (!field) {
    console.log("  no editable field; inconclusive")
  } else {
    const docOf = (s) => (s.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))?.value ?? ""
    const start = docOf(await c.call("get_window_state", { pid: np.pid, window_id: np.window_id, max_elements: 500, include_screenshot: false }).then((r) => r.sc ?? {}))

    // Refresh the element token immediately before EVERY action. The first draft
    // read a "before" snapshot and then reused its token three times; all three
    // calls returned stale_element_token, so the two "refused" results were false
    // positives — they were refused for the wrong reason. This is the fourth time
    // this repo has been bitten by one-use tokens, and the reason they are being
    // folded into a shared harness rather than re-implemented per script.
    const freshField = async () => {
      const s = (await c.call("get_window_state", { pid: np.pid, window_id: np.window_id, max_elements: 500, include_screenshot: false })).sc ?? {}
      return (s.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))
    }
    const typeInto = async (text) => {
      const f = await freshField()
      if (!f) return { code: "no-field", text: "editable field vanished" }
      return c.call("type_text", { element_token: f.element_token, pid: np.pid, text })
    }

    const over = await typeInto("A".repeat(600))
    console.log(`\n  type_text 600 chars  (max_length 500) -> ${over.code}`)
    console.log(`     ${over.text.slice(0, 150).replace(/\n/g, " | ")}`)
    check("over-length type_text is refused by policy", /max_length|length|policy|denied|constraint/i.test(over.text), over.text.slice(0, 110))

    const cjk = await typeInto("\u4e2d\u6587")
    console.log(`\n  type_text CJK       (ASCII pattern)  -> ${cjk.code}`)
    console.log(`     ${cjk.text.slice(0, 150).replace(/\n/g, " | ")}`)
    check("CJK type_text is refused by the pattern", /pattern|policy|denied|constraint|match/i.test(cjk.text), cjk.text.slice(0, 110))

    const ok = await typeInto("ok")
    console.log(`\n  type_text 2 chars   (inside all)      -> ${ok.code}`)
    console.log(`     ${ok.text.slice(0, 150).replace(/\n/g, " | ")}`)
    check("in-bounds type_text still succeeds", ok.code === "ok", ok.text.slice(0, 110))

    // The refusals must not have partially written. Re-observe rather than trust.
    const end = docOf((await c.call("get_window_state", { pid: np.pid, window_id: np.window_id, max_elements: 500, include_screenshot: false })).sc ?? {})
    console.log(`\n  document before: ${JSON.stringify(start)}`)
    console.log(`     document after : ${JSON.stringify(end)}`)
    check("in-bounds text landed, refusals left nothing", end.includes("ok") && !/A{50,}/.test(end) && !/[\u4e00-\u9fff]/.test(end), JSON.stringify(end))

    await c.call("kill_app", { pid: np.pid })
    console.log("  cleaned up our own scratch notepad")
  }
}

c.child.stdin.end()
await sleep(400)
c.child.kill()

console.log("\n================ SUMMARY ================")
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} passed`)