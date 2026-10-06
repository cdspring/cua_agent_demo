// Why was a manifest-listed app still refused?
//
// `resources.apps.executable` is matched against the executable that OWNS the
// window, not the executable that was launched. On this machine charmap runs as
// C:\Windows\System32\charmap.exe — which the manifest lists — yet
// get_window_state was still denied. This prints the owning process per window
// so the manifest can be written against real values.
import { execFileSync } from "node:child_process"

const EXE = "C:\\Users\\spring\\AppData\\Local\\Programs\\cua\\cua-driver\\bin\\cua-driver.exe"
const raw = execFileSync(EXE, ["call", "list_windows", "{}"], { encoding: "utf8", maxBuffer: 32e6 })
const j = JSON.parse(raw.trim())
const wins = j.windows ?? []

console.log("pid".padStart(6) + "  " + "app_name".padEnd(30) + " " + "owning executable")
console.log("-".repeat(110))
for (const w of wins) {
  let owner = "?"
  try {
    const ps = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Process -Id ${w.pid} -EA SilentlyContinue).Path`],
      { encoding: "utf8" },
    ).trim()
    owner = ps || "(process gone)"
  } catch {
    owner = "(query failed)"
  }
  console.log(String(w.pid).padStart(6) + "  " + String(w.app_name).padEnd(30) + " " + owner)
}
