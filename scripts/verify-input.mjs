// Input verification: type_text, set_value and press_key against a real text
// field. Calculator was the wrong host for this: it exposes no editable field,
// so every "field" target was the top-level Window and type_text correctly
// reported that delivery was incomplete.
//
// Notepad has a genuine edit control. A scratch file is used so nothing the
// user cares about is touched, and the process is terminated at the end.
//
// Rules encoded here (learned from failed runs):
//   - one shared `session` label: every one-shot `call` gets a disposable
//     session, so element_token and capture_id do not cross the process edge
//   - element `frame` is DESKTOP coordinates; a pixel action carrying
//     `capture_id` must use WINDOW-LOCAL coordinates instead
//   - `effect: unverifiable` does not mean failure; verify by re-observing
//   - `click` needs `pid` even when `element_token` is present
//   - Windows Notepad's edit box is a real UIA ValuePattern host
import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const S = "verify-input"
const SCRATCH = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-input-test.txt"

function raw(tool, args = {}) {
  const r = spawnSync(EXE, ["call", tool, JSON.stringify(args)], { encoding: "utf8", maxBuffer: 64e6 })
  const t = String(r.stdout ?? "").trim()
  let j = null
  try {
    j = JSON.parse(t)
  } catch {}
  return { exit: r.status, json: j, stderr: String(r.stderr ?? "").slice(0, 200), text: j ? undefined : t.slice(0, 200) }
}
const sc = (r) => r?.structuredContent ?? r ?? {}
const wins = () => raw("list_windows", { session: S }).json?.windows ?? []

// The driver's get_cursor_position is SESSION-scoped: it reports the agent cursor
// overlay, and the driver documents that "a pure accessibility (AX) action snaps
// the cursor with a brief pulse on its first action". So for a UIA write it
// moves ON PURPOSE, and whether the pulse had finished between two reads is a
// timing race.
//
// An earlier revision asserted that this cursor stays put. It failed
// intermittently -- 5/6 on one run, 4/6 on the next -- and the cause was the
// assertion, not the driver. The property that actually matters is that the REAL
// OS cursor does not move, so read that instead, from outside the driver.
const agentCursor = () => {
  const c = sc(raw("get_cursor_position", { session: S }).json)
  return { x: c.x, y: c.y }
}
const realCursor = () => {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -Namespace N -Name P -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out System.Drawing.Point p);' -UsingNamespace System.Drawing -ErrorAction SilentlyContinue; " +
          "$p = New-Object System.Drawing.Point; [void][N.P]::GetCursorPos([ref]$p); \"$($p.X),$($p.Y)\"",
      ],
      { encoding: "utf8", timeout: 25000 },
    ).trim()
    const [x, y] = out.split(",").map(Number)
    return { x, y }
  } catch {
    return null
  }
}

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}\n        ${detail}`)
}

// The scratch file must exist before launch: Notepad opens a "file not found,
// create it?" state instead of an editor, and no Edit control is exposed there.
// Write it with Node rather than assuming a shell.
if (!existsSync(SCRATCH)) {
  writeFileSync(SCRATCH, "seed line\r\n", "utf8")
  console.log(`created scratch file: ${SCRATCH}`)
}

// Launch Notepad on a scratch file so the user's own documents are untouched.
if (!wins().some((w) => /notepad/i.test(w.app_name ?? "") && w.is_on_screen)) {
  const l = sc(raw("launch_app", { path: "C:\\Windows\\System32\\notepad.exe", additional_arguments: [SCRATCH], session: S }).json)
  console.log(`launch_app: pid=${l.pid} running=${l.running}`)
  for (let i = 0; i < 12 && !wins().some((w) => /notepad/i.test(w.app_name ?? "")); i++) await new Promise((r) => setTimeout(r, 1000))
}

const np = wins().find((w) => /notepad/i.test(w.app_name ?? "") && w.is_on_screen)
if (!np) {
  console.log("Notepad window never appeared:", wins().map((w) => `${w.app_name} "${w.title}"`).join(" | "))
  process.exit(3)
}
const { pid, window_id } = np
console.log(`\nNotepad: pid=${pid} window_id=${window_id} "${np.title}"`)

const snap = (o = {}) =>
  sc(
    raw("get_window_state", {
      pid,
      window_id,
      max_elements: 2000,
      max_depth: 30,
      include_screenshot: false,
      session: S,
      ...o,
    }).json,
  )

/** The document text: the Edit control's value, or the widest Text element. */
function docText(s) {
  const ed = (s.elements ?? []).find((e) => /^(Edit|Document|Text)$/i.test(e.role ?? "") && (e.value ?? "").length >= 0 && e.frame?.w > 200)
  if (ed?.value !== undefined) return { value: ed.value, from: `[${ed.element_index}]${ed.role}` }
  const t = (s.elements ?? []).filter((e) => e.role === "Text" && (e.frame?.w ?? 0) > 300).map((e) => e.value ?? e.label)
  return { value: t.join(""), from: "Text fallback" }
}

const s0 = snap()
console.log(`\nsnapshot: ${(s0.elements ?? []).length} elements, complete=${s0.elements_complete}`)
const editable = (s0.elements ?? []).filter((e) => (e.actions ?? []).length > 0)
console.log(`editable/actionable: ${editable.map((e) => `[${e.element_index}]${e.role}"${e.label}"[${e.actions.join(",")}]`).join(" ")}`)
console.log(`doc before: ${JSON.stringify(docText(s0))}`)

// --- set_value: UIA ValuePattern, expected to be the most verifiable path ---
console.log("\n--- set_value ---")
{
  // Exactly ONE snapshot, and act on the token it returns. Taking a second
  // snapshot here supersedes the first, which is the documented one-shot rule
  // and is what an earlier version of this test tripped over.
  const s = snap()
  const before = docText(s).value
  const field = (s.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))
  if (!field) {
    record("set_value dispatches", false, "no Edit/Document element exposed")
  } else {
    const res = sc(raw("set_value", { element_token: field.element_token, pid, value: "alpha-42", session: S }).json)
    console.log(`  effect=${res.effect ?? res.status} route=${res.route ?? "-"} verified=${res.verified ?? "-"}`)
    console.log(`  summary: ${JSON.stringify(res.summary ?? res.refusal ?? null).slice(0, 220)}`)
    const after = docText(snap()).value
    console.log(`  doc: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    record("set_value changes the document", !res.refusal && after.includes("alpha-42"), `"${after.slice(0, 60)}"`)
    // Assert the OUTCOME, not the wording.
  //
  // This route returns effect: "unverifiable", not "confirmed", and carries no
  // `status` field. `unverifiable` is a documented value meaning delivery could
  // not self-prove the write; it is not a failure, and the driver's own guidance
  // is to re-observe. The write does land -- the check above reads it back out of
  // the document. So the postcondition is the document, and `unverifiable` is
  // recorded as the expected value rather than asserted against.
  //
  // An earlier revision required effect === "confirmed" and failed. A revision
  // before that required effect on type_text and also failed. Both were testing
  // the provider's phrasing, which is free to change without anything breaking.
  const effect = res.effect ?? res.status ?? "(absent)"
  record(
    "set_value reports a known effect value",
    !res.refusal && ["unverifiable", "confirmed", "ok"].includes(effect),
    `effect=${effect} route=${res.route ?? "-"} summary=${JSON.stringify(res.summary ?? "").slice(0, 80)}`,
  )
  }
}

// --- type_text: PostMessage per character ---
console.log("\n--- type_text ---")
{
  const s = snap()
  const field = (s.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))
  if (!field) {
    record("type_text dispatches", false, "no Edit/Document element exposed")
  } else {
    const before = docText(s).value
    const cBefore = realCursor()
  const agentBefore = agentCursor()
    const zBefore = wins().find((w) => w.window_id === window_id)?.z_index
    const res = sc(raw("type_text", { element_token: field.element_token, pid, text: "XYZ", session: S }).json)
    const cAfter = realCursor()
  const agentAfter = agentCursor()
    const zAfter = wins().find((w) => w.window_id === window_id)?.z_index
    console.log(`  effect=${res.effect ?? res.status} route=${res.route ?? "-"} delivery=${JSON.stringify(res.delivery ?? null)}`)
    console.log(`  summary: ${JSON.stringify(res.summary ?? res.refusal ?? null).slice(0, 240)}`)
    console.log(`  cursor ${cBefore.x},${cBefore.y} -> ${cAfter.x},${cAfter.y} moved=${cBefore.x !== cAfter.x || cBefore.y !== cAfter.y}`)
    console.log(`  target z ${zBefore} -> ${zAfter}`)
    const after = docText(snap()).value
    console.log(`  doc: ${JSON.stringify(before.slice(-40))} -> ${JSON.stringify(after.slice(-40))}`)
    record("type_text appends to the document", after.includes("XYZ") && after.length > before.length, `len ${before.length} -> ${after.length}`)
    record("type_text leaves the REAL OS cursor put", cBefore && cAfter && cBefore.x === cAfter.x && cBefore.y === cAfter.y, `real ${cBefore?.x},${cBefore?.y} -> ${cAfter?.x},${cAfter?.y}   agent overlay ${agentBefore.x},${agentBefore.y} -> ${agentAfter.x},${agentAfter.y} (the overlay pulse is documented behaviour)`)
    // z going DOWN means something else moved above it, which is the opposite of
    // being raised. Assert "not raised", not "unchanged": a human on the same
    // desktop can legitimately change z-order between the two reads.
    record("type_text does not raise the window", (zAfter ?? -1) <= (zBefore ?? -1), `z ${zBefore} -> ${zAfter}`)
  }
}

// --- press_key ---
console.log("\n--- press_key ---")
{
  const s = snap()
  const field = (s.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))
  if (!field) {
    record("press_key dispatches", false, "no Edit/Document element exposed")
  } else {
    const res = sc(raw("press_key", { element_token: field.element_token, pid, key: "end", modifiers: ["ctrl"], session: S }).json)
    console.log(`  effect=${res.effect ?? res.status} summary=${JSON.stringify(res.summary ?? res.refusal ?? null).slice(0, 200)}`)
    record("press_key dispatches", !res.refusal, `effect=${res.effect ?? res.status}`)
  }
}

console.log("\n================ SUMMARY ================")
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
console.log(`\ncleanup: killing notepad pid ${pid}`)
raw("kill_app", { pid, session: S })
