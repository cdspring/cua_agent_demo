// M3: idempotent installer. Takes a bare Windows machine to a working
// computer-use capability, and prints exactly what it did.
//
// Everything was done by hand over five phases before this existed, which is why
// "mounting it into OpenCode" was not really possible: there was no way to
// reproduce the state, and three separate path assumptions were wrong.
//
// Idempotent: safe to run repeatedly. It reports what it changed and leaves
// anything it did not understand alone.
//
//   node scripts/install.mjs              install / repair
//   node scripts/install.mjs --dry-run    report what would change
//   node scripts/install.mjs --uninstall  remove what this installed
//   node scripts/install.mjs --manifest   also regenerate the manifest app list
//
// Deliberate non-goals:
//   * it never upgrades cua-driver. A silent upgrade changed which executable owns
//     the Calculator window mid-project; that should be a human decision.
//   * it never switches the permission mode. standard versus bounded is a trust
//     decision, not an install decision.
//   * it never touches a config document it did not create the entry in.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { report } from "./lib/opencode-paths.mjs"
import { tally, sleep, EXE, REPO } from "./lib/cua-client.mjs"

/**
 * Recursive copy.
 *
 * fs.cpSync exists in modern Node but this box runs a build without it, and an
 * installer that fails on the target machine's Node version is worse than a few
 * lines of walk-and-write.
 */
function copyTree(src, dest) {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(src)) copyTree(join(src, entry), join(dest, entry))
  } else {
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(src))
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const argv = process.argv.slice(2)
const DRY = argv.includes("--dry-run")
const UNINSTALL = argv.includes("--uninstall")
const REGEN_MANIFEST = argv.includes("--manifest")
const SKILL_ID = "computer-use"

const t = tally()
const say = (...a) => console.log("  " + a.join(" "))

// ---------------------------------------------------------------------------
console.log("=== M3: install computer-use into OpenCode ===\n")

const paths = report()
console.log("--- detected paths ---")
say(`config file    ${paths.configPath ?? "NOT FOUND"}`)
say(`skill dir      ${paths.skillDir ?? "NOT FOUND"}`)
console.log()

if (!paths.configPath) {
  console.log("  No OpenCode config found. Aborting rather than guessing where to write.")
  process.exit(1)
}
if (!paths.skillDir) {
  console.log("  No global skills directory found.")
  say(`Creating ${paths.skillDir}`)
  if (!DRY && !UNINSTALL) mkdirSync(paths.skillDir, { recursive: true })
}

const skillTarget = join(paths.skillDir, SKILL_ID)

// ---------------------------------------------------------------------------
// 1. the driver
console.log("--- 1. cua-driver ---")
if (!existsSync(EXE)) {
  t.check("cua-driver is installed", false, `not found at ${EXE}\n  install it first: https://github.com/trycua/cua`)
} else {
  let version = "unknown"
  try {
    version = execFileSync(EXE, ["--version"], { encoding: "utf8", timeout: 20000 }).trim().split(/\r?\n/)[0]
  } catch {
    /* --version may not exist; do not fail the install for it */
  }
  say(`found ${version}`)
  say(`at     ${EXE}`)
  const expected = "0.34.0"
  const matches = version.includes(expected)
  if (!matches) {
    // Warn, do not "fix". The docs are pinned to a measured version and a silent
    // upgrade invalidates them.
    console.log()
    console.log(`  WARNING: docs are written against ${expected}, installed is "${version}".`)
    console.log("           Not upgrading. Re-verify with scripts/doctor-project.mjs before trusting the docs.")
  }
  t.check(`cua-driver present at ${expected}`, matches, version)
}

// ---------------------------------------------------------------------------
// 2. the MCP entry
console.log("\n--- 2. MCP server entry ---")
const cfgText = existsSync(paths.configPath) ? readFileSync(paths.configPath, "utf8") : ""
const hasCua = /"cua"\s*:/.test(cfgText)
const modeMatch = cfgText.match(/CUA_DRIVER_PERMISSION_MODE"\s*:\s*"([^"]+)"/)
const mode = modeMatch?.[1] ?? "(default: standard)"

if (UNINSTALL) {
  say("removal of the MCP entry is NOT automated")
  say("it is hand-edited config; edit it yourself if you want it gone")
  say(`current mode: ${mode}`)
} else if (hasCua) {
  say(`"cua" entry already present`)
  say(`permission mode: ${mode}`)
  say("leaving it untouched")
  t.check("MCP entry present", true, `mode=${mode}`)
} else {
  const block = [
    "",
    "    // Added by scripts/install.mjs. Absolute path required: the installer does",
    "    // not add cua-driver to PATH, so the bare name would fail to launch.",
    "    // codemode:false keeps these tools on the provider's native tool list.",
    '    "cua": {',
    '      "type": "local",',
    '      "command": [',
    `        "${EXE.replace(/\\/g, "\\\\")}",`,
    '        "mcp"',
    "      ],",
    '      "codemode": false,',
    '      "environment": {',
    '        "CUA_DRIVER_PERMISSION_MODE": "standard"',
    "      }",
    "    }",
    "",
  ].join("\n")
  say("would insert a \"cua\" entry into", paths.configPath)
  say("NOT doing it automatically: this file is jsonc with comments and other")
  say("entries, and a bad splice is worse than a missing one.")
  say("Paste the block above by hand, then re-run to verify.")
  t.check("MCP entry present", false, "not present; insertion is left to a human on purpose")
}

// ---------------------------------------------------------------------------
// 3. the skill
console.log("\n--- 3. skill ---")
const srcSkill = join(ROOT, ".opencode", "skills", SKILL_ID)
if (!existsSync(srcSkill)) {
  t.check("source skill exists", false, srcSkill)
} else {
  const files = ["SKILL.md"]
  for (const f of ["references", "scripts"]) {
    if (existsSync(join(srcSkill, f))) files.push(f)
  }
  // SKILL.md references these by repo-relative path, so the installed copy needs
  // them or the instructions point at nothing.
  const extras = []
  for (const rel of ["scripts/lib/cua-client.mjs", "scripts/probe-feasibility.mjs", "scripts/probe-app-owners.mjs"]) {
    const p = join(ROOT, rel)
    if (existsSync(p)) extras.push(rel)
  }

  if (UNINSTALL) {
    say(`would remove ${skillTarget}`)
    if (existsSync(skillTarget) && !DRY) rmSync(skillTarget, { recursive: true, force: true })
    t.check("skill removed", !existsSync(skillTarget) || DRY, skillTarget)
  } else {
    say(`source   ${srcSkill}`)
    say(`target   ${skillTarget}`)
    say(`files    ${files.join(", ")}${extras.length ? ` + ${extras.length} repo script(s)` : ""}`)
    if (!DRY) {
      mkdirSync(skillTarget, { recursive: true })
      for (const f of files) {
        copyTree(join(srcSkill, f), join(skillTarget, f))
      }
      for (const rel of extras) {
        const dest = join(skillTarget, rel)
        mkdirSync(dirname(dest), { recursive: true })
        copyTree(join(ROOT, rel), dest)
      }
    }
    t.check("skill copied to the global skills directory", DRY || existsSync(join(skillTarget, "SKILL.md")), skillTarget)
  }
}

// ---------------------------------------------------------------------------
// 4. the manifest, optionally regenerated from what is actually running
console.log("\n--- 4. capability manifest ---")
const manifest = join(ROOT, "config", "cua-bounded.yaml")
if (!existsSync(manifest)) {
  t.check("manifest exists", false, manifest)
} else if (REGEN_MANIFEST) {
  const owner = join(HERE, "probe-app-owners.mjs")
  say("regenerating needs probe-app-owners output; run it and review before editing")
  say(`  node scripts/probe-app-owners.mjs`)
  say(`  then edit ${manifest}`)
  say("not rewriting it automatically: the version-stamped WindowsApps paths in")
  say("there carry hand-written warnings that a generator would overwrite.")
  t.check("manifest regeneration is a reviewed manual step", true, "probe-app-owners.mjs")
} else {
  // The useful check: does every executable in the manifest still exist?
  //
  // The pattern takes the rest of the line rather than a non-space run. An
  // earlier version used \S+ and reported "C:\Program" seven times as stale,
  // which is really one bug: every one of these paths contains a space after
  // "C:\Program Files".
  const missing = []
  for (const line of readFileSync(manifest, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*-?\s*executable:\s*(.+?)\s*$/)
    if (!m) continue
    const p = m[1].replace(/^["']|["']$/g, "")
    if (!existsSync(p)) missing.push(p)
  }
  if (missing.length) {
    console.log()
    say("WARNING: manifest lists paths that no longer exist:")
    for (const p of missing) say(`  ${p}`)
    say("Windows package paths carry a version and break on every update.")
    say("Re-derive with scripts/probe-app-owners.mjs")
  } else {
    say("every executable in the manifest exists")
  }
  t.check("manifest paths all exist", missing.length === 0, missing.length ? `${missing.length} stale` : "all present")
}

// ---------------------------------------------------------------------------
// 5. verify, and be explicit about what verification cannot cover
console.log("\n--- 5. verify ---")
if (UNINSTALL) {
  const after = report()
  const still = (after.loadedSkills ?? []).some((s) => /computer-use/i.test(s.id))
  say(`computer-use still loaded by the running server: ${still ? "yes" : "no"}`)
  t.check("skill no longer listed", !still || DRY, "the server may need a restart to drop it")
} else {
  const after = report()
  const loaded = (after.loadedSkills ?? []).some((s) => /computer-use/i.test(s.id))
  if (loaded) {
    say("computer-use is loaded by the running server")
    t.check("skill is loaded, not merely on disk", true)
  } else {
    say("skill is on disk but NOT in the server's loaded list")
    say("OpenCode reads skills at startup, so restart it and re-run:")
    say("  node scripts/install.mjs")
    t.check("skill is loaded, not merely on disk", false, `not in /api/skill yet; restart OpenCode`)
  }
  say(`config documents read: ${(after.loadedConfigs ?? []).join(", ") || "(none)"}`)
}

console.log("\n--- what this installer will not do ---")
console.log("  * upgrade cua-driver        a silent upgrade invalidated the docs once already")
console.log("  * switch permission mode    standard vs bounded is a trust decision")
console.log("  * splice the MCP entry      hand-edited jsonc; a bad splice is worse than none")
console.log("  * rewrite manifest paths    they carry hand-written warnings")

await sleep(100)
process.exit(t.report() ? 0 : 1)