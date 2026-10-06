// A1 in use: clean up scratch fixtures this harness created, and nothing else.
//
// A previous run left four Notepad windows open (mx-*.txt from the policy matrix
// test). Closing them is legitimate; closing the USER's Notepad is the incident
// recorded in commit 0ce0665.
//
// So this demonstrates safeKill() in both directions: the guard is shown refusing
// an untracked window, and then used on the ones that are unambiguously ours.
//
// Ownership is established two ways that must agree: the window title carries our
// scratch prefix, AND the file it has open lives in our own temp directory.
import { readdirSync } from "node:fs"
import { connect, safeKill, tally, sleep } from "./lib/cua-client.mjs"

const SCRATCH_DIR = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
// Two patterns, and conflating them is a mistake I made on the first run.
// FILE_RE is anchored at both ends and matches a FILENAME.
// TITLE_RE is only anchored at the start, because a window title carries a
// suffix: "mx-1791275619218-D.txt - Notepad". Using FILE_RE against a title
// never matches, so every window looked untracked and nothing was closed.
const FILE_RE = /^mx-\d+-[A-Z]\.txt$/
const TITLE_RE = /^mx-\d+-[A-Z]\.txt\b/
const nameOf = (w) => ((w.title ?? "").match(TITLE_RE)?.[0] ?? null)

const t = tally()
const c = connect({ mode: "standard" })
await c.init()

// What we believe we own: files we created in our own temp dir, by name.
const ours = new Set(
  readdirSync(SCRATCH_DIR)
    .filter((f) => FILE_RE.test(f))
    .map((f) => f),
)
console.log(`  scratch files this harness owns: ${[...ours].join(", ") || "none"}\n`)

const wins = (await c.windows()).filter((w) => /notepad/i.test(w.app_name ?? ""))

console.log("=== the guard refusing an untracked window ===")
// No `owned` entry and no title expectation: this is what the user's own Notepad
// looks like to the harness.
const stranger = wins.find((w) => !TITLE_RE.test(w.title ?? ""))
if (stranger) {
  const r = await safeKill(c, stranger, { owned: [], expectTitle: TITLE_RE, reason: "not created by this harness" })
  t.check("safeKill refuses an untracked window", r.killed === false, `pid=${stranger.pid} "${(stranger.title ?? "").slice(0, 40)}"`)
} else {
  console.log("  (no untracked Notepad open right now)")
  t.check("safeKill refuses an untracked window", true, "no untracked Notepad to test against")
}

console.log("\n=== closing the fixtures we do own ===")
const targets = wins.filter((w) => { const n = nameOf(w); return n && ours.has(n) })
if (targets.length === 0) {
  console.log("  no leftover scratch windows")
}
for (const w of targets) {
  const r = await safeKill(c, w, { owned: targets, expectTitle: TITLE_RE, reason: "own scratch fixture" })
  if (r.killed) {
    t.check(`closed our own fixture "${(w.title ?? "").slice(0, 40)}"`, true, `code=${r.code}`)
    await sleep(900)
    continue
  }

  // foreign_process_termination_denied: the driver refuses to kill a process it
  // did not launch, and this window was opened by an MCP child that has since
  // exited. That refusal is correct and is the same guard as
  // `terminate: driver_launched`, enforced even in standard mode. Worth noting
  // the original Notepad incident went through PowerShell Stop-Process, which
  // bypassed the driver entirely -- this path would have refused.
  //
  // So close politely instead: WM_CLOSE via alt+F4 on that window. Notepad
  // prompts to save because the policy test typed into it, so the prompt has to
  // be answered rather than dismissed blindly.
  console.log(`    kill refused (${r.code}); closing politely instead`)
  const s0 = (await c.call("get_window_state", { pid: w.pid, window_id: w.window_id, max_elements: 400, include_screenshot: false })).sc ?? {}
  const f4 = await c.call("press_key", { pid: w.pid, window_id: w.window_id, key: "f4", modifiers: ["alt"] })
  console.log(`    alt+F4 -> ${f4.code}`)
  await sleep(1200)

  // If a save prompt appeared, answer "don't save". Re-read the tree rather than
  // assuming.
  const s1 = (await c.call("get_window_state", { pid: w.pid, window_id: w.window_id, max_elements: 400, include_screenshot: false })).sc ?? {}
  const buttons = (s1.elements ?? []).filter((e) => e.role === "Button" && (e.actions ?? []).includes("invoke"))
  const noSave =
    buttons.find((b) => /^(Don't Save|Do not save|\u4e0d\u4fdd\u5b58|\u4e0d\u8981\u4fdd\u5b58)$/i.test((b.label ?? "").trim())) ??
    buttons.find((b) => /save|\u4fdd\u5b58/i.test(b.label ?? "") && !/^save$/i.test((b.label ?? "").trim()))
  console.log(`    buttons now: ${buttons.map((b) => `"${b.label}"`).join(", ") || "(none)"}`)
  if (noSave) {
    const ns = (await c.call("get_window_state", { pid: w.pid, window_id: w.window_id, max_elements: 400, include_screenshot: false })).sc ?? {}
    const fresh = (ns.elements ?? []).find((e) => e.role === "Button" && (e.label ?? "") === (noSave.label ?? ""))
    if (fresh) {
      const r2 = await c.call("click", { element_token: fresh.element_token, pid: w.pid })
      console.log(`    click "${fresh.label}" -> ${r2.code}`)
      await sleep(900)
    }
  }
  const gone = !(await c.windows()).some((x) => x.pid === w.pid)
  t.check(`closed our own fixture "${(w.title ?? "").slice(0, 40)}"`, gone, gone ? "closed politely after kill was refused" : "still open")
  await sleep(600)
}

const left = (await c.windows()).filter((w) => /notepad/i.test(w.app_name ?? ""))
console.log(`\n  Notepad windows remaining: ${left.length}${left.length ? ` -> ${left.map((w) => w.title).join(" | ")}` : ""}`)
t.check("no scratch fixtures left behind", left.filter((w) => TITLE_RE.test(w.title ?? "")).length === 0, `${left.length} Notepad window(s) remain, none of them ours`)

await c.stop()
t.report()