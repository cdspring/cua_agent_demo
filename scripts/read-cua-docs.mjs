// Read the driver's own MCP resources so the local routing docs can be
// cross-checked against the official guidance. Read-only.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { writeFileSync, mkdirSync } from "node:fs"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const OUT = "C:\\Users\\spring\\AppData\\Local\\Temp\\opencode\\cua-docs"
mkdirSync(OUT, { recursive: true })

const child = spawn(EXE, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] })
const rl = createInterface({ input: child.stdout })
const pending = new Map()
rl.on("line", (line) => {
  const t = line.trim()
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
  new Promise((resolve, reject) => {
    const n = id++
    const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000)
    pending.set(n, (m) => {
      clearTimeout(t)
      resolve(m)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
  })

const WANT = ["WINDOWS.md", "WORKFLOW.md", "SKILL.md", "VISUAL.md"]

;(async () => {
  await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "doc-reader", version: "1.0.0" },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

  for (const name of WANT) {
    const res = await send("resources/read", { uri: `skill://cua-driver/${name}` })
    const contents = res.result?.contents ?? []
    const text = contents.map((c) => c.text ?? "").join("\n")
    writeFileSync(`${OUT}\\${name}`, text, "utf8")
    console.log(`${name}: ${text.length} chars -> ${OUT}\\${name}`)
  }
  child.stdin.end()
  await new Promise((r) => child.on("close", r))
})().catch((e) => {
  console.log("ERROR", e.message)
  child.kill()
  process.exit(1)
})
