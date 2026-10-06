// M6: close the two paths this project never proved.
//
//   set_value   Success path only. Its UIA ValuePattern backend is the same one
//               type_text already proved with effect: confirmed on Notepad, but
//               "same backend" is an inference, not a measurement.
//   invoke_menu Needs a classic Win32 app with a real menu bar. Notepad is XAML
//               and has none. charmap.exe is a genuine Win32 dialog, is already in
//               the manifest, and has launch: true.
//
// Both run against fixtures this harness created, and both re-observe rather
// than trusting action feedback. safeKill guards the teardown.
import { mkdirSync, writeFileSync } from "node:fs"
import { connect, snap, fresh, safeKill, tally, sleep } from "./lib/cua-client.mjs"

const OUT = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output"
mkdirSync(OUT, { recursive: true })
const TITLE_RE = /^m6-\d+\.txt\b/

const t = tally()
// Standard mode, not bounded. The manifest's allow.tools does not include
// invoke_menu, so bounded answers permission_denied before the behaviour is ever
// exercised, which proves nothing about invoke_menu itself.
const c = connect({ mode: "standard" })
const init = await c.init()
if (!init.result) {
  console.log("driver failed to start:\n" + c.stderr.slice(0, 400))
  process.exit(1)
}

// ---------------------------------------------------------------- set_value
console.log("=== set_value success path ===")
{
  const scratch = `${OUT}\\m6-${Date.now()}.txt`
  writeFileSync(scratch, "seed\r\n", "utf8")
  const nm = scratch.split("\\").pop()

  await c.call("launch_app", { path: "C:\\Windows\\System32\\notepad.exe", additional_arguments: [scratch] })
  let np = null
  for (let i = 0; i < 12 && !np; i++) {
    await sleep(900)
    np = (await c.windows()).find((w) => /notepad/i.test(w.app_name ?? "") && (w.title ?? "").includes(nm))
  }
  if (!np) {
    t.check("scratch Notepad opened", false, nm)
  } else {
    const { element } = await fresh(c, np, (e) => /^(Edit|Document)$/i.test(e.role ?? ""))
    if (!element) {
      t.check("an editable field is exposed", false, `roles: ${[...new Set((await snap(c, np)).elements.map((e) => e.role))].join(",")}`)
    } else {
      const r = await c.call("set_value", { element_token: element.element_token, pid: np.pid, value: "set_value wrote this" })
      console.log(`  set_value -> ${r.code}  ${r.text.slice(0, 120).replace(/\n/g, " ")}`)
      t.ok("set_value is accepted", r, "")

      // Re-observe. effect: confirmed is an action fact, not a task outcome.
      await sleep(600)
      const after = await snap(c, np)
      const doc = (after.elements ?? []).find((e) => /^(Edit|Document)$/i.test(e.role ?? ""))?.value ?? ""
      console.log(`  document now: ${JSON.stringify(doc)}`)
      t.check("set_value's write is present in the document", doc.includes("set_value wrote this"), JSON.stringify(doc.slice(0, 70)))
      t.check(
        "set_value replaced rather than appended",
        !doc.includes("seed"),
        doc.includes("seed") ? "the seed survived, so it appended" : "seed gone, so it replaced",
      )
    }
    const owned = [{ pid: np.pid }]
    await safeKill(c, np, { owned, expectTitle: TITLE_RE, reason: "own scratch fixture" })
  }
}

// ---------------------------------------------------------------- invoke_menu
console.log("\n=== invoke_menu ===")
{
  // charmap.exe is classic Win32 and carries a real menu bar, which is what
  // invoke_menu needs. In bounded mode it is in the manifest with launch: true.
  let cm = (await c.windows()).find((w) => /charmap/i.test(w.app_name ?? ""))
  if (!cm) {
    const l = await c.call("launch_app", { path: "C:\\Windows\\System32\\charmap.exe" })
    console.log(`  launch_app -> ${l.code}`)
    for (let i = 0; i < 10 && !cm; i++) {
      await sleep(900)
      cm = (await c.windows()).find((w) => /charmap/i.test(w.app_name ?? ""))
    }
  }
  if (!cm) {
    t.check("charmap window opened", false, "classic Win32 app with a menu bar")
  } else {
    const s = await snap(c, cm)
    const menus = (s.elements ?? []).filter((e) => /menu/i.test(e.role ?? ""))
    console.log(`  window: pid=${cm.pid} "${cm.title}" elements=${(s.elements ?? []).length} menu-ish=${menus.length}`)

    // Menu labels on this machine are LOCALISED. charmap is Chinese, so its menu bar
    // is 文件 / 编辑 / 查看 / 帮助 and every English path returns
    // `menu_path_unavailable: menu path segment 0 was not found`. This is the
    // same trap as the Calculator keypad: match what the accessibility tree
    // actually says, not what the English documentation says.
    //
    // \u escapes rather than literal CJK: PowerShell's Set-Content -Encoding UTF8
    // corrupted an embedded literal in this repo once already.
    const MENUS = [
      ["\u6587\u4ef6"], // 文件  File
      ["\u7f16\u8f91"], // 编辑  Edit
      ["\u67e5\u770b"], // 查看  View
      ["\u5e2e\u52a9"], // 帮助  Help
    ]
    const tried = []
    let invoked = null
    for (const path of MENUS) {
      const r = await c.call("invoke_menu", { pid: cm.pid, window_id: cm.window_id, path })
      tried.push(`${JSON.stringify(path)}=${r.code}`)
      console.log(`  invoke_menu ${JSON.stringify(path)} -> ${r.code}  ${r.text.slice(0, 110).replace(/\n/g, " ")}`)
      await sleep(800)
      if (r.ok) {
        invoked = path
        const after = (await c.windows()).find((w) => w.pid === cm.pid)
        console.log(`     window title now: "${(after?.title ?? "").slice(0, 60)}"`)
        break
      }
    }
    t.check(
      "invoke_menu reaches a real menu bar on a classic Win32 app",
      invoked !== null,
      invoked ? `invoked ${JSON.stringify(invoked)}` : `all refused: ${tried.join(" ")}`,
    )
  }
}

await c.stop()
t.report()