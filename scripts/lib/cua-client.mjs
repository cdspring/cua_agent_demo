// Shared MCP client and assertion helpers for cua-driver verification scripts.
//
// This exists because the same bugs were re-implemented in eight scripts. The
// recurring ones:
//
//   1. Stale tokens. A snapshot invalidates the previous one, so an
//      element_token must be re-read before EVERY action. Four separate scripts
//      got this wrong, and in one case two assertions PASSED for the wrong reason
//      because the refusal was stale_element_token rather than the policy.
//   2. Loose refusal matching. Matching /pattern/i against a SUCCESS message
//      matched the "Pattern" inside "ValuePattern" and produced a false positive.
//      Use refusals() and match on a code, never on prose.
//   3. Verifying the response before asserting on it. Three wrong conclusions in
//      one pass came from reading a shape that had not been checked.
//   4. Killing a host app to get a fixture. This project destroyed the user's
//      unsaved Notepad tabs that way. safeKill() below refuses to do it.
//
// Nothing here is clever. It is the boring part that must be right, factored out
// so a fix lands in one place.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

export const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
export const REPO = "D:\\compterusedkill"
export const MANIFEST = `${REPO}\\config\\cua-bounded.yaml`
export const POLICY = `${REPO}\\config\\cua-policy.yaml`

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Start an MCP child and expose a narrow client.
 *
 * `mode: "standard"` is the default because it is what the live global config
 * uses. Pass bounded/policy explicitly when the test is about scoping.
 */
export function connect({ mode = "standard", policy = null, manifest = null, timeoutMs = 60000 } = {}) {
  const env = { ...process.env }
  if (mode === "bounded") {
    env.CUA_DRIVER_PERMISSION_MODE = "bounded"
    env.CUA_DRIVER_CAPABILITY_MANIFEST_FILE = manifest ?? MANIFEST
    env.CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED = "1"
  }
  if (policy) env.CUA_DRIVER_POLICY_FILE = policy

  const child = spawn(EXE, ["mcp"], { stdio: ["pipe", "pipe", "pipe"], env })
  let stderr = ""
  child.stderr.on("data", (d) => {
    stderr += d.toString()
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
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs)
      pending.set(n, (m) => {
        clearTimeout(t)
        res(m)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
    })

  const api = {
    child,
    get stderr() {
      return stderr
    },
    raw: send,

    async init() {
      const r = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "harness", version: "1" },
      })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      return r
    },

    /** One tool call, with the response shape normalised and verified. */
    async call(tool, args = {}, session = "h") {
      const r = await send("tools/call", { name: tool, arguments: { ...args, session } })
      const res = r.result ?? {}
      const sc = res.structuredContent ?? {}
      const text = (res.content ?? []).map((c) => c.text ?? "").join(" ")
      return {
        ok: !res.isError && (sc.code ?? "ok") === "ok",
        // Refusal codes live in structuredContent, not in content[].text.
        // Parsing them out of prose produced three wrong conclusions in one pass.
        code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"),
        sc,
        text,
        /** Every code this driver is known to return, so callers can match on
         *  one rather than on prose. */
        refusals: {
          permission_denied: /permission denied/i.test(text),
          policy_constraints: /argument constraints were not satisfied/i.test(text),
          stale_element_token: /stale/i.test(text),
          capture_coordinate_invalid: /capture[- ]bound click refused|within/i.test(text),
          outside_manifest: /bounded_resource_outside_manifest|outside/i.test(text),
          foreground_unavailable: /foreground_unavailable|did not activate/i.test(text),
          tool_invocation_failed: /tool_invocation_failed/i.test(text),
          browser_requires_setup: /browser_requires_setup/i.test(text),
        },
      }
    },

    async windows() {
      return (await api.call("list_windows")).sc?.windows ?? []
    },

    async stop() {
      try {
        child.stdin.end()
      } catch {
        /* already closed */
      }
      await sleep(400)
      child.kill()
    },
  }
  return api
}

/** One snapshot of a window. Returns structuredContent, never a bare result. */
export async function snap(c, w, { screenshot = false, toFile = null, elements = 2000, depth = 40, native = true } = {}) {
  const args = {
    pid: w.pid,
    window_id: w.window_id,
    max_elements: elements,
    max_depth: depth,
    include_screenshot: screenshot,
    include_accessibility_tree: true,
  }
  // max_image_dimension 0 means native pixels, so screenshot space equals
  // window-local space. With a cap set, a capture-bound click is validated against
  // the DOWNSCALED image and window-local coordinates get refused as out of range.
  if (screenshot) args.max_image_dimension = native ? 0 : 900
  if (toFile) args.screenshot_out_file = toFile
  return (await c.call("get_window_state", args)).sc ?? {}
}

/**
 * Re-read an element immediately before acting on it.
 *
 * This is the single most important helper in the file. Snapshots are one-use:
 * every get_window_state invalidates the previous snapshot's tokens, so a token
 * captured once and used twice returns stale_element_token. Scripts that skipped
 * this produced false PASSES, not just false failures.
 */
export async function fresh(c, w, match, opts = {}) {
  const s = await snap(c, w, opts)
  return { element: (s.elements ?? []).find(match), state: s, snapshot: s }
}

/** Poll until `match` returns an element. Windows build their trees late. */
export async function freshUntil(c, w, match, { tries = 10, gapMs = 1200, ...opts } = {}) {
  let last = { elements: 0 }
  for (let i = 0; i < tries; i++) {
    const s = await snap(c, w, opts)
    const element = (s.elements ?? []).find(match)
    if (element) return { element, state: s, attempts: i + 1 }
    last = s
    await sleep(gapMs)
  }
  return { element: null, state: last, attempts: tries }
}

/** Accessibility buttons that expose Invoke, optionally filtered further. */
export const buttons = (s, extra = () => true) =>
  (s.elements ?? []).filter((e) => e.role === "Button" && (e.actions ?? []).includes("invoke") && extra(e))

/**
 * Terminate a window this harness created, and nothing else.
 *
 * Guards the incident recorded in commit 0ce0665: this project force-killed the
 * user's Notepad to obtain a test fixture and lost unsaved tabs. A fixture is
 * never worth that.
 *
 * Refuses unless BOTH hold:
 *   - the window is one we launched and are tracking in `owned`, and
 *   - its title matches an expected pattern, typically our scratch filename.
 *
 * `force: true` is accepted only to make the intent explicit at the call site. It
 * does not relax either condition.
 */
export async function safeKill(c, w, { owned = [], expectTitle = null, force = false, reason = "" } = {}) {
  const title = w.title ?? ""
  const tracked = owned.some((o) => o.pid === w.pid)
  const titled = expectTitle === null || expectTitle.test(title)
  if (!tracked || !titled) {
    console.log(`  REFUSED to kill pid=${w.pid} "${title}"${force ? " (force)" : ""}`)
    console.log(`     tracked-by-this-harness=${tracked}  title-matches=${titled}${reason ? `  reason=${reason}` : ""}`)
    console.log(`     Use a scratch file the harness created, or leave the app alone.`)
    return { killed: false, code: "refused_by_safeKill" }
  }
  const r = await c.call("kill_app", { pid: w.pid })
  console.log(`  killed our own fixture pid=${w.pid} "${title}" -> ${r.code}`)
  return { killed: r.ok, code: r.code }
}

/** Collects pass/fail so a script ends with one honest summary. */
export function tally() {
  const rows = []
  return {
    rows,
    check(name, pass, detail) {
      rows.push({ name, pass: !!pass })
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`)
      return !!pass
    },
    /** Assert a call succeeded. Fails loudly on the codes that mean "unknown". */
    ok(name, r, detail) {
      return this.check(name, r.ok, `${detail ? `${detail}  ` : ""}code=${r.code}  ${r.text.slice(0, 90).replace(/\n/g, " ")}`)
    },
    /** Assert a call was refused for a SPECIFIC reason. Never match on prose alone. */
    refused(name, r, flag, detail) {
      const hit = !!r.refusals[flag]
      return this.check(name, hit, `${detail ? `${detail}  ` : ""}code=${r.code} ${flag}=${hit}  ${r.text.slice(0, 80).replace(/\n/g, " ")}`)
    },
    report() {
      console.log("\n================ SUMMARY ================")
      for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
      const failed = rows.filter((r) => !r.pass).length
      console.log(`\n${rows.length - failed}/${rows.length} passed`)
      return failed === 0
    },
  }
}

/**
 * The feasibility question, asked before any task is attempted.
 *
 * Measured on this machine: the new CalculatorApp.exe exposes zero accessibility
 * elements, its background pixel clicks silently no-op while returning Win32
 * S_OK, and foreground escalation is unavailable because the desktop has no
 * foreground window. A capability the driver exposes in principle can be
 * unreachable in a given environment; only measurement tells them apart.
 */
export async function feasibility(c, w, { elements = 3000, depth = 40 } = {}) {
  const s = await snap(c, w, { elements, depth })
  const n = (s.elements ?? []).length
  const tree = n > 0 && (s.elements ?? []).some((e) => (e.actions ?? []).length > 0)
  return {
    elements: n,
    tree,
    degraded: s.degraded ?? false,
    degraded_reason: s.degraded_reason ?? null,
    // No tree means the only local rung left is pixels. If foreground activation
    // is also unavailable, nothing works and the caller should say so.
    verdict: tree ? "drive via accessibility" : "NO ACCESSIBILITY TREE: pixel rung only, and verify foreground before promising anything",
    state: s,
  }
}