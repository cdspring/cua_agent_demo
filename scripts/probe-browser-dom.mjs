// The browser DOM rung, proven in standard mode without changing anything global.
//
// The bounded manifest deliberately excludes browser_* from allow.tools, because
// granting DOM access to a logged-in browser session is a real decision, not a
// convenience. That leaves the page rung unproven, so this probe runs the SAME
// calls under standard mode, in a throwaway child process. It touches nothing
// the user has to undo: opencode.jsonc keeps standard, the manifest is
// unchanged, and the global runtime is not restarted.
//
// READ ONLY. It prepares a binding and reads the page. No clicks, no typing, no
// navigation, no file transfer.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"

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
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 60000)
    pending.set(n, (m) => {
      clearTimeout(t)
      res(m)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
  })
const call = async (tool, args = {}) => {
  const r = await send("tools/call", { name: tool, arguments: { ...args, session: "dom" } })
  const res = r.result ?? {}
  const sc = res.structuredContent ?? {}
  return {
    code: sc.code ?? sc.refusal?.code ?? (res.isError ? "isError" : "ok"),
    sc,
    text: (res.content ?? []).map((c) => c.text ?? "").join(" "),
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`)
}

;(async () => {
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dom-probe", version: "1" } })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

  const w = ((await call("list_windows")).sc?.windows ?? []).filter((x) => /msedge|chrome/i.test(x.app_name ?? ""))
  if (w.length === 0) {
    record("a browser window exists", false, "no msedge/chrome window")
  } else {
    // Prefer a visible window; a minimized one often has no page target.
    const target = w.find((x) => x.is_on_screen && !x.minimized) ?? w[0]
    console.log(`  target: pid=${target.pid} ${target.app_name} ${target.minimized ? "MINIMIZED" : "visible"}`)
    console.log(`  title : ${target.title.slice(0, 80)}`)

    console.log("\n=== 1. accessibility route (the pixel-adjacent rung) ===")
    const s = (
      await call("get_window_state", {
        pid: target.pid,
        window_id: target.window_id,
        max_elements: 300,
        max_depth: 12,
        include_screenshot: false,
      })
    ).sc
    const n = (s.elements ?? []).length
    record("browser window has an accessibility tree", n > 0, `elements=${n} complete=${s.elements_complete}`)

    console.log("\n=== 2. prepare an owned DevTools endpoint ===")
    let prep = await call("browser_prepare", { pid: target.pid, window_id: target.window_id })
    console.log(`  attach to the running profile -> ${prep.code}`)
    console.log(`    ${prep.text.slice(0, 260).replace(/\n/g, " | ")}`)

    if (prep.code !== "ok") {
      // Take the remedy the refusal itself names. An isolated_new profile is
      // created by the driver, thrown away afterwards, and never touches the
      // user's real Chromium profile or its cookies.
      console.log(`\n  taking the documented remedy: allow_launch + isolated_new profile`)
      prep = await call("browser_prepare", {
        allow_launch: true,
        profile: { mode: "isolated_new" },
      })
      console.log(`  driver-owned isolated browser -> ${prep.code}`)
      console.log(`    ${prep.text.slice(0, 300).replace(/\n/g, " | ")}`)
    }

    if (prep.code === "ok") {
      console.log(`  prepared_pid=${prep.sc?.prepared_pid} status=${prep.sc?.status} prepared=${prep.sc?.prepared}`)
      console.log(`  endpoint_ownership=${JSON.stringify(prep.sc?.endpoint_ownership)}`)
      console.log(`  side_effects=${JSON.stringify(prep.sc?.side_effects)}`)

      // browser_prepare only PREPARES the endpoint. The target id and tab ids are
      // minted by get_browser_state in bind mode, which needs the prepared
      // browser's own (pid, window_id). Skipping this step and expecting a
      // target_id in the prepare response was the first draft's mistake.
      const preparedPid = prep.sc?.prepared_pid
      const own = preparedPid ? (await call("list_windows", { pid: preparedPid })).sc?.windows ?? [] : []
      console.log(`  prepared browser windows: ${own.length}`)
      own.forEach((w) => console.log(`    pid=${w.pid} hwnd=${w.window_id} "${w.title.slice(0, 50)}"`))
      const bw = own.find((w) => !w.minimized) ?? own[0]

      console.log("\n=== 3. bind, then read the page over CDP ===")
      if (!bw) {
        record("browser bind", false, `no window for prepared_pid ${preparedPid}`)
      } else {
        const bind = await call("get_browser_state", { pid: bw.pid, window_id: bw.window_id })
        console.log(`  bind -> ${bind.code}`)
        console.log(`    ${bind.text.slice(0, 400).replace(/\n/g, " | ")}`)
        const targetID = bind.sc?.target_id ?? bind.sc?.targetID ?? bind.sc?.target?.id ?? bind.sc?.id
        const tabs = bind.sc?.tabs ?? []
        const tabID = bind.sc?.tab_id ?? bind.sc?.tabID ?? tabs[0]?.id ?? tabs[0]?.tab_id
        console.log(`  target_id=${targetID}  tab_id=${tabID}  tabs=${tabs.length}`)
        record("bind mints a target id", bind.code === "ok" && !!targetID, `target_id=${targetID} tabs=${tabs.length}`)

        if (targetID) {
          // Navigate the driver-owned throwaway profile to a neutral page. The
          // real browser and its cookies are untouched; this is the isolated
          // process the driver spawned and will discard.
          const nav = await call("browser_navigate", { target_id: targetID, tab_id: tabID, url: "https://example.com" })
          console.log(`\n  navigate -> ${nav.code} ${nav.text.slice(0, 120).replace(/\n/g, " | ")}`)
          await sleep(2500)

          const st = await call("get_browser_state", {
            target_id: targetID,
            tab_id: tabID,
            snapshot_format: "semantic_v2",
          })
          console.log(`  snapshot -> ${st.code}  ${st.text.length} chars`)
          console.log(`    ${st.text.slice(0, 900).replace(/\n/g, " | ")}`)
          const outline = st.sc?.outline ?? st.sc?.semantic_outline
          if (outline) console.log(`  outline: ${JSON.stringify(outline).slice(0, 400)}`)
          record("DOM route returns page content", st.code === "ok" && st.text.length > 0, `${st.text.length} chars`)
          record(
            "page content is real, not about:blank",
            /example/i.test(JSON.stringify(st.sc ?? {})),
            `snippet: ${st.text.slice(0, 80).replace(/\n/g, " ")}`,
          );

          console.log("\n=== 4. screenshot over the page route ===")
          if (tabID) {
            const shot = await call("browser_screenshot", { target_id: targetID, tab_id: tabID, maxWidth: 900 })
            console.log(`  browser_screenshot -> ${shot.code}`)
            const files = shot.sc?.files ?? []
            console.log(`  files: ${files.map((f) => `${f.name} ${f.bytes}B`).join(", ") || "(none)"}`)
            record("screenshot over the page route", shot.code === "ok" && files.length > 0, files[0]?.path ?? shot.text.slice(0, 100))
          } else {
            record("screenshot over the page route", false, "no tab id")
          }
        }
      }
    } else {
      // Report the refusal code verbatim. An earlier revision printed a canned
      // sentence about `authorization_required` while the driver had actually
      // said `browser_requires_setup` — asserting a code I had not observed is
      // the exact failure this repository keeps recording.
      record("DOM route available", false, `browser_prepare ${prep.code}`)
      console.log(`\n  Observed refusal code: ${prep.code}`)
      console.log(`  ${prep.text.slice(0, 300)}`)
    }
  }
})()
  .catch((e) => console.log("ERROR", e.message))
  .finally(async () => {
    child.stdin.end()
    await sleep(500)
    child.kill()
    console.log("\n================ SUMMARY ================")
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
    const failed = results.filter((r) => !r.pass).length
    console.log(`\n${results.length - failed}/${results.length} passed`)
  })
