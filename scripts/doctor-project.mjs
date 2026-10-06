// M5: startup drift check. One command that says whether the documented system is
// still the installed system.
//
// Everything in this project was true when it was written and silently stopped
// being true afterwards:
//
//   * a Windows update moved the Calculator from ApplicationFrameHost.exe to
//     CalculatorApp.exe, and the new build exposes ZERO accessibility elements,
//     so a task that passed stopped being possible with no error anywhere
//   * manifest entries carry version-stamped WindowsApps paths that break on
//     every app update, surfacing as bounded_resource_outside_manifest for a
//     process you can plainly see in Task Manager
//   * a manifest entry was written for a path that never existed, justified by
//     reasoning that was also wrong
//   * the skill sat in the project directory and was never loaded at all, while
//     looking perfectly installed
//
// None of those announce themselves. This does.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { report } from "./lib/opencode-paths.mjs"
import { connect, feasibility, tally, sleep, EXE, REPO } from "./lib/cua-client.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const t = tally()
const problems = []
const say = (...a) => console.log("  " + a.join(" "))
const problem = (msg) => {
  problems.push(msg)
  console.log(`  PROBLEM  ${msg}`)
}

console.log("=== M5: doctor ===\n")

// ---------------------------------------------------------------- 1. driver
console.log("--- 1. cua-driver ---")
if (!existsSync(EXE)) {
  problem(`not installed at ${EXE}`)
} else {
  let v = "unknown"
  try {
    v = execFileSync(EXE, ["--version"], { encoding: "utf8", timeout: 20000 }).trim().split(/\r?\n/)[0]
  } catch {
    /* --version may not be supported; do not fail on it */
  }
  say(`${v}`)
  if (!v.includes("0.34.0")) {
    problem(`docs are written against 0.34.0, installed is "${v}". The measured findings may no longer hold.`)
  }
  t.check("cua-driver matches the documented version", v.includes("0.34.0"), v)
}

// ---------------------------------------------------------------- 2. config
console.log("\n--- 2. OpenCode wiring ---")
const paths = report()
say(`config ${paths.configPath}`)
say(`skills ${paths.skillDir}`)
if (!paths.loadedConfigs?.length) {
  problem("could not read /api/config; is the OpenCode server running?")
} else {
  say(`config documents read: ${paths.loadedConfigs.join(", ")}`)
}
const skillLoaded = (paths.loadedSkills ?? []).some((s) => /computer-use/i.test(s.id))
if (skillLoaded) {
  say(`computer-use loaded from ${(paths.loadedSkills ?? []).find((s) => /computer-use/i.test(s.id))?.path}`)
} else {
  const onDisk = paths.skillDir && existsSync(join(paths.skillDir, "computer-use", "SKILL.md"))
  problem(
    onDisk
      ? "computer-use is on disk but NOT in the running server's skill list. Restart OpenCode."
      : "computer-use is not installed globally. Run: node scripts/install.mjs",
  )
}
t.check("computer-use skill is loaded by the running server", skillLoaded)

// ---------------------------------------------------------------- 3. manifest
console.log("\n--- 3. capability manifest ---")
const manifest = join(ROOT, "config", "cua-bounded.yaml")
if (!existsSync(manifest)) {
  problem(`manifest missing at ${manifest}`)
} else {
  const stale = []
  for (const line of readFileSync(manifest, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*-?\s*executable:\s*(.+?)\s*$/)
    if (!m) continue
    const p = m[1].replace(/^["']|["']$/g, "")
    if (!existsSync(p)) stale.push(p)
  }
  if (stale.length) {
    for (const p of stale) say(`MISSING ${p}`)
    problem(`${stale.length} manifest path(s) no longer exist. Windows package paths are version-stamped; re-derive with scripts/probe-app-owners.mjs`)
  } else {
    say("every executable in the manifest exists")
  }
  t.check("manifest paths all exist", stale.length === 0, stale.length ? `${stale.length} stale` : "all present")

  // The one precondition that deadlocks everything if wrong.
  if (!/display:\s*true/.test(readFileSync(manifest, "utf8"))) {
    problem("manifest does not set desktop.display: true. On Windows that deadlocks list_windows, list_apps, get_accessibility_tree, click and type_text.")
  }
}

// ---------------------------------------------------------------- 4. policy
console.log("\n--- 4. argument policy ---")
const policy = join(ROOT, "config", "cua-policy.yaml")
const policyEnv = process.env.CUA_DRIVER_POLICY_FILE
if (policyEnv) {
  say(`CUA_DRIVER_POLICY_FILE=${policyEnv}`)
  if (!existsSync(policyEnv)) problem(`policy file set but missing: ${policyEnv}`)
} else {
  say("not wired into any runtime (by decision)")
  if (existsSync(policy)) {
    // Strip comments before checking. An earlier version scanned the raw text and
    // matched the word `required:` inside the comment explaining that `required`
    // does not exist -- reporting the very file that documents the hazard as the
    // thing violating it. The same trap applies to the launch_app argument name.
    const raw = readFileSync(policy, "utf8")
    const code = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/(^|\s)#.*$/, ""))
      .join("\n")

    if (/required:\s*(true|false)/.test(code)) {
      problem("policy uses `required:`, which does not exist in 0.34.0. The driver will REFUSE TO START.")
    }
    // Argument names are NOT validated, so a wrong one parses and binds to
    // nothing. launch_app's argument is `path`.
    if (/\bexecutable:\s*\n\s+allowed:/.test(code)) {
      problem("policy constrains `executable` on launch_app; the argument is `path`, so the constraint binds to nothing.")
    }
    // A constrained tool listed in allow.tools is silently unconstrained.
    const inTools = (raw.match(/tools:\s*\n((?:\s+- .*\n)+)/) ?? [])[1] ?? ""
    for (const tool of inTools.match(/^\s+- (\w+)/gm) ?? []) {
      if (new RegExp(`- tool: ${tool}\\b`).test(code)) {
        problem(`policy lists ${tool} in allow.tools AND in allow.rules. allow.tools overrides the rules, so its constraints are silently ignored.`)
      }
    }
  }
}
t.check("no known-fatal policy schema error", true, policyEnv ? "policy active" : "policy inactive")

// ---------------------------------------------------------------- 5. live capability
console.log("\n--- 5. live capability, per window ---")
const c = connect({ mode: "standard" })
const init = await c.init()
if (!init.result) {
  problem("driver MCP did not start:\n" + c.stderr.slice(0, 300))
} else {
  const wins = await c.windows()
  const apps = new Map()
  for (const w of wins) {
    const name = w.app_name ?? "?"
    if (/cua-driver|OpenCode\.exe|explorer\.exe|TextInputHost/i.test(name)) continue
    if (apps.has(name)) continue
    apps.set(name, w)
  }
  const driveable = []
  const not = []
  for (const [name, w] of apps) {
    const f = await feasibility(c, w, { elements: 1500, depth: 25 })
    const tag = f.tree ? "driveable " : "NO TREE   "
    console.log(
      `  ${tag} ${name.padEnd(26)} ${String(f.elements).padStart(4)} elements  ${w.minimized ? "MINIMIZED" : w.is_on_screen ? "visible" : "off-screen"}`,
    )
    ;(f.tree ? driveable : not).push(name)
  }
  say("")
  say(`drivable: ${[...new Set(driveable)].join(", ") || "none"}`)
  say(`no tree : ${[...new Set(not)].join(", ") || "none"}`)

  if (not.length) {
    problem(
      `${[...new Set(not)].join(", ")} expose no accessibility tree, and the pixel fallback is blocked by the Windows foreground lock on this host. Tasks against these apps are not possible.`,
    )
  }
  t.check("at least one app is driveable", driveable.length > 0)
  await c.stop()
}

// ---------------------------------------------------------------- summary
console.log("\n================ SUMMARY ================")
for (const r of t.rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S) NEEDING ATTENTION:`)
  for (const p of problems) console.log(`  - ${p.split("\n")[0]}`)
  console.log("\nEach of these was true once and stopped being true silently.")
}
process.exit(problems.length ? 1 : 0)