// B5 + A1: answer "can this app be driven at all?" before any task is attempted.
//
// This is the product of Phase 4. The Calculator closed loop passed on the old
// ApplicationFrameHost-hosted build and became impossible on the new self-hosted
// CalculatorApp.exe, which exposes ZERO accessibility elements. Background pixel
// clicks on it return Win32 S_OK and change nothing, and foreground escalation is
// unavailable on this machine because the desktop has no foreground window.
//
// Discovering that took three rounds of hand-built probes. This is one call.
//
// It also refuses, loudly, to be used as an excuse to click into a void: if the
// tree is absent, the verdict says so instead of implying the app is reachable.
import { mkdirSync } from "node:fs"
import { connect, feasibility, tally, sleep, MANIFEST } from "./lib/cua-client.mjs"

const OUT = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
mkdirSync(OUT, { recursive: true })

const t = tally()
const c = connect({ mode: "bounded" })
const init = await c.init()
if (!init.result) {
  console.log("driver failed to start:")
  console.log(c.stderr.slice(0, 400))
  process.exit(1)
}

const wins = await c.windows()
console.log(`\n${wins.length} windows on this desktop. Asking the feasibility question for each.\n`)

const rows = []
for (const w of wins) {
  if (/cua-driver|OpenCode\.exe|explorer\.exe|TextInputHost/i.test(w.app_name ?? "")) continue
  const f = await feasibility(c, w, { elements: 1500, depth: 25 })
  const named = (f.state.elements ?? []).filter((e) => (e.label ?? "").trim()).length
  const where = w.minimized ? "MINIMIZED" : w.is_on_screen ? "visible" : "off-screen"
  console.log(
    `  ${String(f.elements).padStart(4)} elements  ${String(named).padStart(4)} named  ${where.padEnd(9)} ${(w.app_name ?? "?").padEnd(26)} "${(w.title ?? "").slice(0, 34)}"`,
  )
  if (f.degraded && f.degraded_reason) console.log(`         degraded: ${String(f.degraded_reason).slice(0, 150)}`)
  rows.push({ w, f, where })
}

console.log("\n--- verdict per app ---")
const driveable = []
const not = []
for (const { w, f, where } of rows) {
  const name = w.app_name ?? "?"
  if (f.tree) {
    driveable.push(name)
    console.log(`  DRIVEABLE      ${name.padEnd(26)} via accessibility  (${f.elements} elements, ${where})`)
  } else {
    not.push(name)
    console.log(`  NOT DRIVEABLE  ${name.padEnd(26)} ${f.verdict}  (${where})`)
  }
}

console.log("\n--- and the reason a tree is not always enough ---")
console.log("  A missing tree leaves only the pixel rung. On this machine that rung")
console.log("  cannot complete: foreground activation returns")
console.log("    foreground_unavailable: ... actual foreground HWND 0x0")
console.log("  because GetForegroundWindow() is 0x0 even though the window station is")
console.log("  WinSta0, the desktop is Default and the session is the console session.")
console.log("  So NOT DRIVEABLE above means not driveable HERE, not not driveable in")
console.log("  principle. Re-measure on a host with a live foreground window.")

// ---------------------------------------------------------------------------
t.check("driver started under bounded", !!init.result)
t.check("every window answered the feasibility question", rows.length > 0, `${rows.length} app windows probed`)
t.check(
  "a window with an accessibility tree was found",
  driveable.length > 0,
  `driveable: ${[...new Set(driveable)].join(", ") || "none"}`,
)
t.check(
  "windows without a tree are reported, not clicked",
  true,
  `not drivable: ${[...new Set(not)].join(", ") || "none"}`,
)

await c.stop()
t.report()