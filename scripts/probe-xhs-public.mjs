// B4: the last untested channel. Can the driver-owned isolated browser see
// anything useful on Xiaohongshu's PUBLIC pages?
//
// This is a feasibility measurement, not a collector. Scope is deliberately
// narrow:
//   * a throwaway driver-owned isolated profile, created and discarded
//   * no login, no cookies, no existing profile attachment
//   * public entry pages only, no individual creator or note URLs
//   * read-only: navigate and read the DOM. No clicks, no typing, no scrolling
//     for content, no media retrieval.
//
// Why it matters: the other two rungs are measured dead on this host. The
// accessibility tree yields 210 elements of navigation and footer boilerplate,
// and pixels are blocked by the foreground lock. If this rung is also empty for
// logged-out visitors, then the honest answer is that this stack has no usable
// channel for that site, and the answer to "should we build more tooling" is no.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdirSync } from "node:fs"

const OUT = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
mkdirSync(OUT, { recursive: true })
const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"

// Public entry pages. No creator or note URLs: those are the content, and the
// question here is whether the CHANNEL works, not what it could carry.
const TARGETS = [
  { name: "public home", url: "https://www.xiaohongshu.com" },
  { name: "discover", url: "https://www.xiaohongshu.com/explore" },
]

function client() {
  const child = spawn(EXE, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] })
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
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 90000)
      pending.set(n, (m) => {
        clearTimeout(t)
        res(m)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
    })
  return {
    child,
    async init() {
      const r = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "b4", version: "1" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },
    async call(tool, args = {}) {
      const r = await send("tools/call", { name: tool, arguments: { ...args, session: "b4" } })
      const res = r.result ?? {}
      const sc = res.structuredContent ?? {}
      return { code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"), sc, text: (res.content ?? []).map((c) => c.text ?? "").join(" ") }
    },
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Engagement-shaped: a count, optionally with a Chinese magnitude suffix. Counts
// written as 万 / 亿 are still counts.
const MAGNITUDE = /(\d+(?:\.\d+)?)\s*(万|亿|w|W|k|K)?/
const looksLikeCount = (s) => {
  const t = (s ?? "").trim()
  if (!t || t.length > 14) return null
  const m = t.match(MAGNITUDE)
  if (!m) return null
  const unit = m[2]
  let n = parseFloat(m[1])
  if (unit === "万" || unit === "w" || unit === "W") n *= 1e4
  else if (unit === "亿") n *= 1e8
  else if (unit === "k" || unit === "K") n *= 1e3
  return Number.isFinite(n) ? n : null
}

const c = client()
await c.init()

console.log("=== preparing a throwaway driver-owned browser ===")
const prep = await c.call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } })
console.log(`  browser_prepare -> ${prep.code}`)
if (prep.code !== "ok") {
  console.log(`  ${prep.text.slice(0, 300)}`)
  c.child.stdin.end()
  await sleep(400)
  c.child.kill()
  process.exit(1)
}
const preparedPid = prep.sc?.prepared_pid
console.log(`  prepared_pid=${preparedPid}`)
console.log(`  side_effects: ${JSON.stringify(prep.sc?.side_effects)}`)

const own = (await c.call("list_windows", { pid: preparedPid })).sc?.windows ?? []
const bw = own.find((w) => !w.minimized) ?? own[0]
if (!bw) {
  console.log("  prepared browser has no window")
  c.child.stdin.end()
  await sleep(400)
  c.child.kill()
  process.exit(1)
}

const bind = await c.call("get_browser_state", { pid: bw.pid, window_id: bw.window_id })
const targetId = bind.sc?.target_id
// The bind response nests the id under tabs[].tab_id. An earlier revision of this
// probe read tabs[0].id, got undefined, and then reported BOTH public pages as
// "empty: nothing content-bearing is reachable logged out".
//
// That conclusion was wrong and dangerously so: the cause was a missing field in
// my own extraction, not the site. navigate answered
// "Missing required string field: tab_id" and snapshot answered
// "browser_tab_required", and I summarised those as an absence of content. A
// harness bug reported as an environmental fact is the exact failure this
// repository keeps recording, so the check below asserts the id is present
// before any conclusion is drawn.
const tabId = bind.sc?.tab_id ?? (bind.sc?.tabs ?? [])[0]?.tab_id ?? (bind.sc?.tabs ?? [])[0]?.id
console.log(`  bind -> ${bind.code}  target_id=${targetId}  tab_id=${tabId}`)
console.log(`  binding: route=${bind.sc?.binding_route} quality=${bind.sc?.binding_quality} class=${bind.sc?.endpoint_access_class}`)
if (!targetId || !tabId) {
  console.log(`  BIND INCOMPLETE -- refusing to draw any conclusion about the site.`)
  console.log(`  bind structuredContent: ${JSON.stringify(bind.sc).slice(0, 500)}`)
  c.child.stdin.end()
  await sleep(400)
  c.child.kill()
  process.exit(1)
}

const results = []
for (const t of TARGETS) {
  console.log(`\n=== ${t.name}: ${t.url} ===`)
  const nav = await c.call("browser_navigate", { target_id: targetId, tab_id: tabId, url: t.url })
  console.log(`  navigate -> ${nav.code}  ${nav.text.slice(0, 120).replace(/\n/g, " ")}`)
  // Give a heavy SPA time to hydrate. Not optimising this: the question is what
  // is reachable, not how fast.
  await sleep(6000)

  const st = await c.call("get_browser_state", { target_id: targetId, tab_id: tabId, snapshot_format: "semantic_v2" })
  console.log(`  snapshot -> ${st.code}`)
  const text = st.text ?? ""
  const tabs = st.sc?.tabs ?? []
  const urlNow = tabs[0]?.url ?? "(unknown)"
  const titleNow = tabs[0]?.title ?? "(unknown)"
  console.log(`  landed on : ${urlNow}`)
  console.log(`  title     : ${String(titleNow).slice(0, 90)}`)
  console.log(`  snapshot  : ${text.length} chars`)
  console.log(`    ${text.slice(0, 700).replace(/\n/g, " | ")}`)

  // Walk the semantic outline, which is where content refs live.
  const outline = st.sc?.outline ?? st.sc?.semantic_outline ?? ""
  const flat = Array.isArray(outline) ? outline.join("\n") : String(outline)
  console.log(`\n  outline length: ${flat.length} chars`)
  const lines = flat.split("\n").filter((l) => l.trim())
  const statics = lines.filter((l) => /statictext|text|heading/i.test(l))
  const counts = statics.map((l) => looksLikeCount(l.replace(/^[^"]*"/, "").replace(/"$/, ""))).filter((n) => n !== null)
  console.log(`  outline lines : ${lines.length}`)
  console.log(`  text-bearing  : ${statics.length}`)
  console.log(`  count-shaped  : ${counts.length}  ${JSON.stringify(counts.slice(0, 25))}`)

  console.log(`\n  --- outline sample ---`)
  for (const l of lines.slice(0, 30)) console.log(`    ${l.slice(0, 110)}`)

  // Login wall detection, stated as observation not inference.
  const loginSignals = /登录|登陆|扫码|验证码|手机号|立即登录/.test(flat + text)
  results.push({ name: t.name, url: urlNow, title: titleNow, chars: text.length, lines: lines.length, counts: counts.length, loginSignals, sample: flat.slice(0, 200) })
}

console.log("\n================ WHAT THIS MEANS ================")
for (const r of results) {
  console.log(`  ${r.name.padEnd(14)} landed=${r.url}`)
  console.log(`    snapshot ${r.chars} chars, outline ${r.lines} lines, ${r.counts} count-shaped value(s)`)
  console.log(`    login/verification prompt present: ${r.loginSignals ? "YES" : "no"}`)
  if (!r.loginSignals && r.counts === 0 && r.lines < 10) {
    console.log(`    -> empty: nothing content-bearing is reachable logged out`)
  } else if (r.counts > 0) {
    console.log(`    -> count-shaped values ARE present in the DOM for a logged-out visitor`)
  } else {
    console.log(`    -> structure present but no count-shaped values found`)
  }
}
console.log(`
  This measures the CHANNEL, not a collection. It is read-only, logged out,
  on a throwaway profile, and it never touched a creator page.`)

c.child.stdin.end()
await sleep(500)
c.child.kill()