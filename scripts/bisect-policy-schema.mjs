// Bisect the YAML policy schema for cua-driver 0.34.0.
//
// Established by measurement: CUA_DRIVER_POLICY_FILE is real and active. Setting it
// to config/cua-policy.yaml makes the driver REFUSE TO START with
// "Policy loading error: user policy: failed to parse YAML policy". An empty
// policy starts fine. So the feature works and our file is wrong.
//
// The binary contains maxLength 13 times against max_length twice, which suggests
// camelCase. That is a hint, not evidence, so this tries each variant and reports
// which ones actually initialise.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdirSync, writeFileSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const DIR = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cu-output\\policy-bisect"
mkdirSync(DIR, { recursive: true })

const CASES = [
  ["01-empty", "allow:\n  tools: []\n"],
  ["02-empty-deny", "allow:\n  tools: []\ndeny:\n  tools: []\n"],
  [
    "03-rules-empty",
    "allow:\n  tools: []\n  rules:\n    - tool: type_text\n",
  ],
  [
    "04-constraints-empty",
    "allow:\n  tools: []\n  rules:\n    - tool: type_text\n      constraints: {}\n",
  ],
  [
    "05-maxLength",
    "allow:\n  tools: []\n  rules:\n    - tool: type_text\n      constraints:\n        text:\n          maxLength: 500\n",
  ],
  [
    "06-max_length",
    "allow:\n  tools: []\n  rules:\n    - tool: type_text\n      constraints:\n        text:\n          max_length: 500\n",
  ],
  [
    "07-min-max",
    "allow:\n  tools: []\n  rules:\n    - tool: scroll\n      constraints:\n        amount:\n          min: -20\n          max: 20\n",
  ],
  [
    "08-pattern",
    'allow:\n  tools: []\n  rules:\n    - tool: type_text\n      constraints:\n        text:\n          maxLength: 500\n          pattern: "^[\\x20-\\x7E\\n\\t]*$"\n',
  ],
  [
    "09-required",
    "allow:\n  tools: []\n  rules:\n    - tool: click\n      constraints:\n        target:\n          required: true\n",
  ],
  [
    "10-allowed-list",
    'allow:\n  tools: []\n  rules:\n    - tool: launch_app\n      constraints:\n        executable:\n          allowed:\n            - "C:\\\\Windows\\\\System32\\\\notepad.exe"\n',
  ],
  [
    "11-deny-tools-only",
    "deny:\n  tools:\n    - kill_app\n",
  ],
  [
    "12-deny-tools-string",
    "deny:\n  tools: []\n",
  ],
  // Second pass. Pass 1 confounded two variables: case 08 carried maxLength AND
  // pattern, so its rejection does not tell us anything about pattern. And
  // maxLength was the wrong guess; max_length is the accepted spelling.
  [
    "13-max_length-plus-pattern",
    'allow:\n  tools: []\n  rules:\n    - tool: type_text\n      constraints:\n        text:\n          max_length: 500\n          pattern: "^[a-z]*$"\n',
  ],
  [
    "14-pattern-alone",
    'allow:\n  tools: []\n  rules:\n    - tool: type_text\n      constraints:\n        text:\n          pattern: "^[a-z]*$"\n',
  ],
  [
    "15-required-alone",
    "allow:\n  tools: []\n  rules:\n    - tool: click\n      constraints:\n        target:\n          required: true\n",
  ],
  [
    "16-required-false",
    "allow:\n  tools: []\n  rules:\n    - tool: click\n      constraints:\n        target:\n          required: false\n",
  ],
  [
    "17-allowed-strings",
    'allow:\n  tools: []\n  rules:\n    - tool: launch_app\n      constraints:\n        executable:\n          allowed: ["C:\\\\Windows\\\\System32\\\\notepad.exe"]\n',
  ],
  [
    "18-allowed-block-form",
    "allow:\n  tools: []\n  rules:\n    - tool: launch_app\n      constraints:\n        executable:\n          allowed:\n            - notepad\n",
  ],
  [
    "19-unknown-constraint-key",
    "allow:\n  tools: []\n  rules:\n    - tool: type_text\n      constraints:\n        text:\n          nonsense_key: 5\n",
  ],
  [
    "20-unknown-rule-key",
    "allow:\n  tools: []\n  rules:\n    - tool: type_text\n      nonsense_key: 5\n",
  ],
  // Third pass. Our file also spells the drag duration camelCase, and camelCase
  // is exactly what failed for maxLength. The drag tool's own argument is
  // duration_ms, so that is the likely correct spelling.
  [
    "21-duration_ms",
    "allow:\n  tools: []\n  rules:\n    - tool: drag\n      constraints:\n        duration_ms:\n          min: 100\n          max: 5000\n",
  ],
  [
    "22-durationMs",
    "allow:\n  tools: []\n  rules:\n    - tool: drag\n      constraints:\n        durationMs:\n          min: 100\n          max: 5000\n",
  ],
  [
    "23-constraint-on-unknown-arg",
    "allow:\n  tools: []\n  rules:\n    - tool: type_text\n      constraints:\n        nonexistent_arg:\n          max_length: 5\n",
  ],
  [
    "24-rule-for-unknown-tool",
    "allow:\n  tools: []\n  rules:\n    - tool: no_such_tool\n      constraints:\n        text:\n          max_length: 5\n",
  ],
  [
    "25-wait-in-allow-tools",
    "allow:\n  tools:\n    - wait\n    - list_windows\n",
  ],
]

async function tryPolicy(name, yaml) {
  const path = `${DIR}\\${name}.yaml`
  writeFileSync(path, yaml, "utf8")
  const child = spawn(EXE, ["mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CUA_DRIVER_POLICY_FILE: path },
  })
  let stderr = ""
  child.stderr.on("data", (d) => {
    stderr += d.toString()
  })

  const result = await new Promise((resolve) => {
    const rl = createInterface({ input: child.stdout })
    const timer = setTimeout(() => resolve({ ok: false, why: "timeout, no initialize reply" }), 20000)
    rl.on("line", (l) => {
      try {
        const m = JSON.parse(l.trim())
        if (m.id === 1 && m.result) {
          clearTimeout(timer)
          resolve({ ok: true, why: "initialized" })
        }
      } catch {
        /* not our line */
      }
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ ok: false, why: `exit ${code}` })
    })
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bisect", version: "1" } } }) + "\n",
    )
  })

  await new Promise((r) => setTimeout(r, 200))
  child.kill()
  const msg = stderr.trim().split("\n")[0] ?? ""
  return { ...result, msg }
}

console.log("Which YAML policy shapes does 0.34.0 actually accept?\n")
const rows = []
for (const [name, yaml] of CASES) {
  const r = await tryPolicy(name, yaml)
  rows.push({ name, ok: r.ok, why: r.why, msg: r.msg })
  console.log(`  ${r.ok ? "PARSES " : "REJECTS"}  ${name.padEnd(22)} ${r.ok ? "" : r.msg.slice(0, 90)}`)
}

console.log("\n--- accepted shapes ---")
rows.filter((r) => r.ok).forEach((r) => console.log(`  ${r.name}`))
console.log("\n--- rejected shapes ---")
rows.filter((r) => !r.ok).forEach((r) => console.log(`  ${r.name.padEnd(22)} ${r.msg.slice(0, 110)}`))