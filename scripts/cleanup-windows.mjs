// A3: close the two windows this project opened, and sweep leaked clients.
//
// regedit and charmap are open because this work opened them: regedit to look for
// an application menu bar for invoke_menu, charmap for the same reason. Neither
// was running before. They cannot be closed with kill_app, which returns
// foreign_process_termination_denied because the MCP child that launched them has
// exited -- the same guard that would have prevented the original Notepad
// incident.
//
// Both are CLASSIC Win32, which is the point: Notepad is XAML and its close
// button took the PostMessage path that XAML chrome drops, so a polite close
// never landed there. A classic window accepts WM_CLOSE.
//
// Read-only otherwise. Nothing here touches an application this harness did not
// open, which is the whole point of the safeKill guard.
import { connect, snap, safeKill, tally, sleep } from "./lib/cua-client.mjs"
import { execFileSync } from "node:child_process"

const t = tally()
const c = connect({ mode: "standard" })
await c.init()

/** Every cua-driver mcp client except the one backing the live OpenCode MCP. */
function mcpClients() {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='cua-driver.exe'\" | " +
    "ForEach-Object { if ($_.CommandLine -match '\\bmcp\\b') { \"$($_.ProcessId)|$($_.ParentProcessId)\" } }",
  ], { encoding: "utf8", timeout: 30000 })
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [pid, ppid] = s.split("|").map(Number); return { pid, ppid } })
}

console.log("=== 1. polite close, not terminate ===")
// Only windows whose owning executable is one this project launched.
const TARGETS = [/regedit/i, /charmap/i]
const wins = await c.windows()
const ours = wins.filter((w) => TARGETS.some((re) => re.test(w.app_name ?? "")))
console.log(`  windows matching the ones we opened: ${ours.length}`)
for (const w of ours) console.log(`    pid=${w.pid} ${w.app_name} "${w.title}"`)

for (const w of ours) {
  // safeKill first: it will refuse, because these are not in `owned` -- the
  // harness that launched them is gone. That refusal is correct and is shown on
  // purpose so the guard is not quietly bypassed.
  const refused = await safeKill(c, w, { owned: [], expectTitle: /./, reason: "launching harness has exited" })
  if (refused.killed) {
    t.check(`closed ${w.app_name} by termination`, true)
    await sleep(1000)
    continue
  }

  // A classic Win32 window accepts WM_CLOSE. Deliver it as a keystroke to that
  // window, which is the driver's route for a window-scoped message.
  const close = await c.call("press_key", { pid: w.pid, window_id: w.window_id, key: "f4", modifiers: ["alt"] })
  console.log(`    alt+F4 -> ${close.code}`)
  await sleep(1500)

  let stillThere = (await c.windows()).some((x) => x.pid === w.pid)
  if (stillThere) {
    // Fall back to the window's own close button. For charmap and regedit the
    // title-bar button is a real Win32 control, so PostMessage reaches it.
    const s = await snap(c, w, { elements: 400, depth: 20 })
    const btn = (s.elements ?? []).find(
      (e) => e.role === "Button" && /关闭|Close|^\u2715$|^X$/i.test((e.label ?? "").trim()),
    )
    console.log(`    close button: ${btn ? `"${btn.label}" @${JSON.stringify(btn.frame)}` : "not exposed"}`)
    if (btn) {
      const s2 = await snap(c, w, { elements: 400, depth: 20 })
      const fresh = (s2.elements ?? []).find((e) => e.role === "Button" && (e.label ?? "") === btn.label)
      if (fresh) {
        const r = await c.call("click", { element_token: fresh.element_token, pid: w.pid })
        console.log(`    click close -> ${r.code}  ${r.text.slice(0, 80)}`)
        await sleep(1500)
      }
    }
    stillThere = (await c.windows()).some((x) => x.pid === w.pid)
  }
  t.check(`closed ${w.app_name} politely`, !stillThere, stillThere ? "WM_CLOSE did not land; needs a human" : "alt+F4 accepted by a classic Win32 window")
}

console.log("\n=== 2. leaked cua-driver mcp clients ===")
const clients = mcpClients()
console.log(`  ${clients.length} mcp client process(es) currently running`)
for (const cl of clients) console.log(`    pid=${cl.pid}  parent=${cl.ppid}`)

// Identify the live MCP server's process so it is never swept. It is the child of
// the OpenCode process, whereas leaked clients are children of node scripts that
// have exited -- or orphans whose parent is gone.
const orphan = clients.filter((cl) => {
  try {
    const parent = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${cl.ppid}" -EA SilentlyContinue).Name`],
      { encoding: "utf8", timeout: 15000 }).trim()
    return parent === "" || /^node(\.exe)?$/i.test(parent)
  } catch {
    return false
  }
})
const live = clients.filter((c) => !orphan.includes(c))
console.log(`  orphaned (parent gone, or a node script that has exited): ${orphan.map((o) => o.pid).join(", ") || "none"}`)
console.log(`  parented by a live application (do not touch)        : ${live.map((l) => l.pid).join(", ") || "none"}`)

for (const o of orphan) {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "Stop-Process -Id " + o.pid + " -Force -ErrorAction SilentlyContinue"], { timeout: 20000 })
    console.log(`    swept ${o.pid}`)
  } catch {
    console.log(`    could not sweep ${o.pid}`)
  }
}
await sleep(1000)
console.log(`  remaining: ${mcpClients().length}`)

t.check("the live OpenCode MCP process was not swept", live.every((l) => mcpClients().some((c) => c.pid === l.pid)), `live pids: ${live.map((l) => l.pid).join(",") || "none identified"}`)
t.check("no orphaned clients remain", mcpClients().every((c) => live.includes({ pid: c.pid, ppid: c.ppid }) || c.ppid !== 0))

console.log("\n=== 3. leftover windows ===")
for (const w of await c.windows()) {
  if (/regedit|charmap|notepad|calculator/i.test(w.app_name ?? "")) {
    console.log(`  pid=${w.pid} ${(w.app_name ?? "").padEnd(16)} "${(w.title ?? "").slice(0, 45)}"`)
  }
}

await c.stop()
t.report()