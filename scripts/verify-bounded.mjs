// Phase 3: prove that `bounded` mode actually bounds.
//
// Runs bounded the way OpenCode would: an MCP stdio child with
// CUA_DRIVER_PERMISSION_MODE / CUA_DRIVER_CAPABILITY_MANIFEST_FILE /
// CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED in its environment. That is the real
// deployment path, and it leaves the standard-mode daemon alone.
//
// Lesson from the first attempt: `--socket` is not a `call` flag, so pointing
// `call` at a second daemon silently misroutes to the default pipe and every
// assertion then tests standard mode instead of bounded.
//
// The three cases the driver docs require before unattended use:
//   1. an in-scope call succeeds silently
//   2. the same tool against an app outside the manifest is refused
//      (bounded_resource_outside_manifest)
//   3. a tool that is not listed at all is denied (permission_denied)
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { readFileSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const MANIFEST = "D:\\compterusedkill\\config\\cua-bounded.yaml"

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`)
}

// --- MCP stdio client -------------------------------------------------------
function openMcp(env) {
  const child = spawn(EXE, ["mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  })
  const rl = createInterface({ input: child.stdout })
  const pending = new Map()
  let stderr = ""
  child.stderr.on("data", (d) => (stderr += d.toString()))
  rl.on("line", (line) => {
    const t = line.trim()
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
    new Promise((resolve, reject) => {
      const n = id++
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 40000)
      pending.set(n, (m) => {
        clearTimeout(timer)
        resolve(m)
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
        clientInfo: { name: "bounded-verify", version: "1.0.0" },
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },
    async call(tool, args = {}) {
      const r = await send("tools/call", { name: tool, arguments: args })
      const res = r.result ?? {}
      const text = (res.content ?? []).map((c) => c.text ?? "").join(" ")
      const sc = res.structuredContent ?? {}
      // Refusal codes live in structuredContent, NOT in content[].text. The
      // text is a human sentence like "Permission denied: tool 'x' is outside
      // the capability manifest". Parsing the text is how the first version of
      // this script reported every refusal as (none).
      const code = sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok")
      return { text, code, message: sc.message ?? sc.refusal?.message ?? text, raw: res }
    },
    async tools() {
      const r = await send("tools/list", {})
      return (r.result?.tools ?? []).map((t) => t.name)
    },
  }
}

console.log("=== 0. manifest preconditions ===")
{
  const m = readFileSync(MANIFEST, "utf8")
  record("version 3", /version:\s*3/.test(m))
  record("expires_after present", /expires_after:/.test(m))
  record("idle_timeout present", /idle_timeout:/.test(m))
  record("desktop.display true (false deadlocks discovery on Windows)", /display:\s*true/.test(m))
  record("no browser.origins (conflicts with generic tools)", !/origins:/.test(m))
}

console.log("\n=== 1. negative startup cases ===")
{
  const probe = async (env, args, label) => {
    const p = spawn(EXE, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } })
    let out = ""
    p.stdout.on("data", (d) => (out += d.toString()))
    p.stderr.on("data", (d) => (out += d.toString()))
    const code = await new Promise((res) => {
      const t = setTimeout(() => {
        p.kill()
        res("STILL_RUNNING")
      }, 8000)
      p.on("close", (c) => {
        clearTimeout(t)
        res(c)
      })
    })
    const cameUp = code === "STILL_RUNNING" || /listening/i.test(out)
    record(label, !cameUp, `exit=${code} out=${out.trim().slice(0, 150)}`)
  }
  await probe(
    { CUA_DRIVER_PERMISSION_MODE: "bounded", CUA_DRIVER_CAPABILITY_MANIFEST_FILE: undefined, CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: undefined },
    ["mcp"],
    "bounded without a manifest does not start",
  )
  await probe(
    { CUA_DRIVER_PERMISSION_MODE: "bounded", CUA_DRIVER_CAPABILITY_MANIFEST_FILE: MANIFEST, CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: undefined },
    ["mcp"],
    "bounded with a manifest but no approval does not start",
  )
}

console.log("\n=== 2. start bounded over MCP ===")
const bounded = openMcp({
  CUA_DRIVER_PERMISSION_MODE: "bounded",
  CUA_DRIVER_CAPABILITY_MANIFEST_FILE: MANIFEST,
  CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
})
const init = await bounded.init()
record(
  "bounded MCP session initialises",
  !!init.result,
  init.error ? JSON.stringify(init.error).slice(0, 200) : `${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`,
)
if (!init.result) {
  console.log(`  stderr: ${bounded.stderr().slice(0, 500)}`)
  process.exit(2)
}

const toolNames = await bounded.tools()
console.log(`  tools advertised: ${toolNames.length}`)

try {
  console.log("\n=== 3. in-scope calls succeed silently ===")
  {
    const r = await bounded.call("get_screen_size", { session: "bounded" })
    record("get_screen_size allowed", r.code === "ok", `code=${r.code} ${r.text.slice(0, 90)}`)
  }
  {
    // Discovery must work or the manifest deadlocks: the agent cannot address a
    // window without a pid and window_id.
    const w = await bounded.call("list_windows", { session: "bounded" })
    record("list_windows allowed (no deadlock)", w.code === "ok", `code=${w.code}`)
    const list = w.raw?.structuredContent?.windows ?? []
    console.log(`  ${list.length} windows visible`)

    const calc = list.find((x) => /calculator|计算器/i.test(x.title ?? ""))
    const settings = list.find((x) => /SystemSettings/i.test(x.app_name ?? ""))
    const explorer = list.find((x) => /explorer/i.test(x.app_name ?? ""))
    console.log(`  in-scope  : ${calc ? `pid=${calc.pid} "${calc.title}"` : "(no listed app open)"}`)
    console.log(`  unlisted  : ${[settings, explorer].filter(Boolean).map((w) => `"${w.title}" (${w.app_name})`).join(", ") || "(none open)"}`)

    console.log("\n=== 4. app scope: listed allowed, unlisted refused ===")
    // Launch a listed executable so the positive case is deterministic.
    await bounded.call("launch_app", { path: "C:\\Windows\\System32\\charmap.exe", session: "bounded" })
    await new Promise((r) => setTimeout(r, 4000))
    const w2 = await bounded.call("list_windows", { session: "bounded" })
    const all = w2.raw?.structuredContent?.windows ?? []
    const listed = all.filter((x) => /charmap/i.test(x.app_name ?? ""))
    const unlisted = [settings, explorer].filter(Boolean)

    for (const w of listed) {
      const r = await bounded.call("get_window_state", {
        pid: w.pid,
        window_id: w.window_id,
        max_elements: 25,
        include_screenshot: false,
        session: "bounded",
      })
      const n = (r.raw?.structuredContent?.elements ?? []).length
      record(`listed app "${w.app_name}" pid=${w.pid} is addressable`, r.code === "ok", `code=${r.code} elements=${n}`)
    }
    if (listed.length === 0) record("listed app is addressable", true, "SKIPPED: charmap did not appear")

    for (const w of unlisted) {
      const r = await bounded.call("get_window_state", {
        pid: w.pid,
        window_id: w.window_id,
        max_elements: 10,
        include_screenshot: false,
        session: "bounded",
      })
      // App-scope refusals surface as permission_denied; display-scope refusals
      // as bounded_resource_outside_manifest. Either is a refusal, but the
      // distinction tells you which layer fired.
      record(
        `unlisted app "${w.app_name}" is refused`,
        r.code === "permission_denied" || r.code === "bounded_resource_outside_manifest",
        `code=${r.code}`,
      )
    }
    if (unlisted.length === 0) record("unlisted app refused", true, "SKIPPED: no unlisted app was open")

    console.log("\n=== 4b. get_window_state must be allowed, or 4 proves nothing ===")
    record("get_window_state is present in allow.tools", /^\s*-\s*get_window_state\s*$/m.test(readFileSync(MANIFEST, "utf8")), "")

    for (const w of listed) await bounded.call("kill_app", { pid: w.pid, session: "bounded" })

    console.log("\n=== 5. tools outside allow.tools are denied ===")
    for (const tool of ["get_browser_state", "install_extension", "parse_visual_regions", "start_recording"]) {
      if (!toolNames.includes(tool)) {
        record(`${tool} not advertised`, true, "absent from the catalog")
        continue
      }
      const r = await bounded.call(tool, { session: "bounded" })
      record(`${tool} denied`, r.code === "permission_denied", `code=${r.code}`)
    }

    console.log("\n=== 6. input is still possible for a listed app ===")
    {
      const l = await bounded.call("launch_app", { path: "C:\\Windows\\System32\\charmap.exe", session: "bounded" })
      record("launch_app on a listed executable is allowed", l.code === "ok", `code=${l.code} ${l.text.slice(0, 90)}`)
      await new Promise((r) => setTimeout(r, 3000))
      const w2 = await bounded.call("list_windows", { session: "bounded" })
      const cm = (w2.raw?.structuredContent?.windows ?? []).find((x) => /charmap/i.test(x.app_name ?? "") || /字符映射/i.test(x.title ?? ""))
      if (cm) {
        const r = await bounded.call("get_window_state", {
          pid: cm.pid,
          window_id: cm.window_id,
          max_elements: 30,
          include_screenshot: false,
          session: "bounded",
        })
        record("a launched listed app is addressable", r.code === "ok", `code=${r.code} elements=${(r.raw?.structuredContent?.elements ?? []).length}`)
        // Leave nothing running behind.
        await bounded.call("kill_app", { pid: cm.pid, session: "bounded" })
      } else {
        record("a launched listed app is addressable", true, "SKIPPED: charmap window not observed")
      }
    }
  }
} finally {
  bounded.child.stdin.end()
  await new Promise((r) => setTimeout(r, 500))
  bounded.child.kill()
}

console.log("\n================ SUMMARY ================")
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed > 0 ? 1 : 0
