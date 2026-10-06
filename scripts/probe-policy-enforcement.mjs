// A/B test: does CUA_DRIVER_POLICY_FILE actually enforce, or is it decorative?
//
// I previously told the user the policy file was read by nothing. That was wrong:
// the strings CUA_DRIVER_POLICY_FILE and CUA_DRIVER_MANAGED_POLICY_FILE are both
// present in the driver binary. A string in the binary is not proof of behaviour,
// so this measures it. Three cases, same target, same session shape:
//
//   1. standard, no policy      -> baseline
//   2. standard, policy set     -> is an over-length type_text refused?
//   3. standard, policy set     -> is a tool outside allow.tools refused?
//
// The policy's type_text rule caps text at 500 chars and allows only
// [\x20-\x7E\n\t], which is ASCII. CJK would be rejected by the pattern, so the
// test also measures what that costs: a CJK string is legal under the driver and
// refused under this policy. That is a real trade-off to surface, not a defect.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdirSync, writeFileSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const POLICY = "D:\\compterusedkill\\config\\cua-policy.yaml"
const SCRATCH_DIR = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
mkdirSync(SCRATCH_DIR, { recursive: true })

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
      const r = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "policytest", version: "1" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },
    async call(tool, args = {}) {
      const r = await send("tools/call", { name: tool, arguments: { ...args, session: "pol" } })
      const res = r.result ?? {}
      const sc = res.structuredContent ?? {}
      return { code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"), sc, text: (res.content ?? []).map((c) => c.text ?? "").join(" ") }
    },
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(label, env) {
  console.log(`\n########## ${label} ##########`)
  const c = client(env)
  const init = await c.init()
  if (!init.result) {
    console.log("  initialize FAILED")
    console.log(`  ${JSON.stringify(init).slice(0, 300)}`)
    c.child.kill()
    return
  }
  const tools = init.result.capabilities?.tools ?? {}
  console.log(`  initialized OK`)

  // A tool the policy does NOT list. Under a deny-by-default policy this should
  // be refused on policy grounds rather than on addressability grounds.
  const bogus = await c.call("list_apps")
  console.log(`  list_apps (in policy allow.tools)          -> ${bogus.code}`)

  const scr = await c.call("get_screen_size")
  console.log(`  get_screen_size (NOT in policy allow.tools) -> ${scr.code}`)
  console.log(`     ${scr.text.slice(0, 110).replace(/\n/g, " | ")}`)

  const z = await c.call("zoom", { pid: 1, window_id: 1, x1: 0, y1: 0, x2: 10, y2: 10 })
  console.log(`  zoom (NOT in policy allow.tools)           -> ${z.code}`)

  // The over-length type_text. Needs a real target, so open our own scratch file.
  const scratch = `${SCRATCH_DIR}\\pol-${Date.now()}.txt`
  writeFileSync(scratch, "seed\r\n", "utf8")
  const name = scratch.split("\\").pop()
  const l = await c.call("launch_app", { path: "C:\\Windows\\System32\\notepad.exe", additional_arguments: [scratch] })
  console.log(`  launch_app (NOT in policy allow.tools)     -> ${l.code}`)
  let np = null
  for (let i = 0; i < 10 && !np; i++) {
    await sleep(1000)
    np = ((await c.call("list_windows")).sc?.windows ?? []).find((w) => /notepad/i.test(w.app_name ?? "") && (w.title ?? "").includes(name))
  }
  if (!np) {
    console.log(`  could not open the scratch notepad; the policy test is inconclusive`)
    c.child.kill()
    return
  }
  let field = null
  for (let i = 0; i < 6 && !field; i++) {
    const s = (await c.call("get_window_state", { pid: np.pid, window_id: np.window_id, max_elements: 500, include_screenshot: false })).sc ?? {}
    field = (s.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))
    if (!field) await sleep(1000)
  }

  if (!field) {
    console.log(`  no editable field; inconclusive`)
    c.child.kill()
    return
  }

  const long = "A".repeat(600)
  const rLong = await c.call("type_text", { element_token: field.element_token, pid: np.pid, text: long })
  console.log(`  type_text 600 chars (policy max_length 500)  -> ${rLong.code}`)
  console.log(`     ${rLong.text.slice(0, 120).replace(/\n/g, " | ")}`)

  const cjk = "\u4e2d\u6587"
  const rCjk = await c.call("type_text", { element_token: field.element_token, pid: np.pid, text: cjk })
  console.log(`  type_text CJK (policy pattern is ASCII-only) -> ${rCjk.code}`)
  console.log(`     ${rCjk.text.slice(0, 120).replace(/\n/g, " | ")}`)

  const short = "ok"
  const rShort = await c.call("type_text", { element_token: field.element_token, pid: np.pid, text: short })
  console.log(`  type_text 2 chars (inside every constraint)  -> ${rShort.code}`)

  c.child.stdin.end()
  await sleep(400)
  c.child.kill()
}

await run("1. standard, NO policy (baseline)", {})
await run("2. standard, CUA_DRIVER_POLICY_FILE set", { CUA_DRIVER_POLICY_FILE: POLICY })
console.log("\nCompare the two. If they are identical the policy is not enforced.")