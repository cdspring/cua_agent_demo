// Inspect one get_window_state response: shape, element count, actionable set.
import { readFileSync } from "node:fs"

const path = process.argv[2]
let s = readFileSync(path, "utf8")
if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)

const j = JSON.parse(s)
// `cua-driver call` flattens structuredContent into the top level; an MCP
// client would see it nested. Accept both shapes.
const sc = j.structuredContent ?? j
console.log("top keys      :", Object.keys(j).join(", "))

const elements = sc.elements ?? []
console.log("elements      :", elements.length, "/ total", sc.total_element_count ?? "?")
console.log("returned      :", sc.returned_element_count ?? "?")
console.log("elements_complete:", sc.elements_complete, " truncated:", sc.truncated ?? false, sc.truncation_reason ?? "")
console.log("visited/pending:", sc.nodes_visited, "/", sc.nodes_pending)
console.log("snapshot_id   :", sc.snapshot_id)
console.log("window        :", sc.app_name, "|", sc.window_title)
console.log("bounds        :", JSON.stringify(sc.window_bounds ?? {}))
if (sc.capture_coverage) console.log("capture_coverage:", JSON.stringify(sc.capture_coverage))

if (elements.length === 0) {
  console.log("\nNO ELEMENTS. tree_markdown head:")
  console.log(String(sc.tree_markdown ?? "(none)").slice(0, 1200))
  process.exit(1)
}

const actionable = elements.filter((e) => (e.actions ?? []).length > 0)
console.log(`\nactionable    : ${actionable.length} of ${elements.length}`)
for (const e of actionable.slice(0, 24)) {
  console.log(`  [${e.element_index}] ${e.role} "${e.label}" actions=[${(e.actions ?? []).join(",")}] ${JSON.stringify(e.frame ?? {})}`)
}
