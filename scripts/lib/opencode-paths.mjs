// M2: find the paths OpenCode actually uses, rather than assuming them.
//
// Three of these were wrong assumptions in this project, each of which cost real
// time:
//
//   * the MCP entry has to live in the GLOBAL config. `/api/config` reports
//     exactly one document on this machine,
//     C:\Users\spring\.config\opencode\opencode.jsonc. The project's own
//     opencode.jsonc is read by nobody.
//   * the global config directory is NOT where skills live. `/api/skill` showed
//     all nine non-builtin skills resolving under C:\Users\spring\.agents\skills
//     -- not ~/.config/opencode/skills, which does not exist.
//   * there is no skills directory under ~/.config/opencode at all, so
//     "install the skill next to the config" silently produces a skill that never
//     loads.
//
// Everything here is probed, and every probe is allowed to fail loudly. Run
// `node scripts/detect-config.mjs` to print the answer without changing anything.
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const home = homedir()

/** Candidate global config files, most specific first. */
export function configCandidates() {
  return [
    join(home, ".config", "opencode", "opencode.jsonc"),
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".opencode", "opencode.json"),
  ]
}

/**
 * Candidate skill directories.
 *
 * ~/.agents/skills is first because it is the one this machine actually loads,
 * verified against /api/skill. The others are listed so that a machine which
 * differs is still handled, and so that a path which exists but is NOT loaded can
 * be detected and reported rather than silently used.
 */
export function skillCandidates() {
  return [
    join(home, ".agents", "skills"),
    join(home, ".config", "opencode", "skills"),
    join(home, ".opencode", "skills"),
  ]
}

export function findConfig() {
  const found = configCandidates().filter((p) => existsSync(p))
  return { path: found[0] ?? null, all: found }
}

export function findSkillDir() {
  const all = skillCandidates().filter((p) => existsSync(p))
  return { path: all[0] ?? null, all }
}

/**
 * Which skills the running server has actually loaded.
 *
 * Reads /api/skill through the OpenCode CLI. This is the ground truth: it is the
 * difference between "the file is where I put it" and "the model can see it",
 * which is the distinction this whole phase exists to establish.
 */
export function loadedSkills(cli) {
  const r = spawnSync(cli, ["api", "get", "/api/skill"], { encoding: "utf8" })
  if (r.status !== 0 || !r.stdout) return null
  try {
    const parsed = JSON.parse(r.stdout.trim())
    return parsed.data.map((s) => ({ id: s.id, name: s.name, path: s.path }))
  } catch {
    return null
  }
}

/** Which config documents the running server reads. */
export function loadedConfigs(cli) {
  const r = spawnSync(cli, ["api", "get", "/api/config"], { encoding: "utf8" })
  if (r.status !== 0 || !r.stdout) return null
  const paths = []
  for (const m of r.stdout.matchAll(/"type":"document","path":"([^"]+)"/g)) {
    paths.push(m[1].replace(/\\\\/g, "\\"))
  }
  return paths
}

export function cliPath() {
  const base = join(home, "AppData", "Roaming", "ai.opencode.desktop", "cli")
  if (!existsSync(base)) return null
  const versions = readdirSync(base).sort().reverse()
  for (const v of versions) {
    const p = join(base, v, "opencode-cli.exe")
    if (existsSync(p)) return p
  }
  return null
}

export function report() {
  const cfg = findConfig()
  const skl = findSkillDir()
  const cli = cliPath()
  const out = {
    home,
    configPath: cfg.path,
    configCandidatesFound: cfg.all,
    skillDir: skl.path,
    skillCandidatesFound: skl.all,
    cli,
    loadedConfigs: cli ? loadedConfigs(cli) : null,
    loadedSkills: cli ? loadedSkills(cli) : null,
  }
  return out
}

// Direct invocation: print and exit.
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const r = report()
  console.log("=== where OpenCode actually reads things ===\n")
  console.log(`  home                 ${r.home}`)
  console.log(`  config file          ${r.configPath ?? "NOT FOUND"}`)
  console.log(`  global skill dir     ${r.skillDir ?? "NOT FOUND"}`)
  console.log(`  cli                  ${r.cli ?? "NOT FOUND"}`)
  console.log(`\n  config documents the running server reads:`)
  for (const p of r.loadedConfigs ?? []) console.log(`    ${p}`)
  if (!r.loadedConfigs?.length) console.log(`    (could not read /api/config)`)
  console.log(`\n  skills the running server has loaded:`)
  for (const s of r.loadedSkills ?? []) console.log(`    ${s.id.padEnd(24)} ${s.path}`)
  if (!r.loadedSkills?.length) console.log(`    (could not read /api/skill)`)
  const has = (r.loadedSkills ?? []).some((s) => /computer-use/i.test(s.id))
  console.log(`\n  computer-use loaded: ${has ? "YES" : "NO"}`)
  if (!has) console.log(`    A skill file on disk is not a loaded skill. Install to: ${r.skillDir}`)
}