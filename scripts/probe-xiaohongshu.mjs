// What can actually be read off a Xiaohongshu page?
//
// Feasibility probe, not a collector. The question is narrow and answerable by
// measurement: if the engagement numbers are in the accessibility tree, a
// read-only metrics extractor is viable. If they are not, that is worth knowing
// before anything is built.
//
// Uses the accessibility rung, which needs no CDP grant and no logged-in-profile
// attachment. Chromium renders page content into its UIA tree, so this can work
// where the DOM route would need `--grant existing-profile`.
//
// Read-only. No clicks, no input, no navigation, no media retrieval. It reports
// what is PRESENT and, more importantly, what is ABSENT.
import { connect, snap, tally, sleep } from "./lib/cua-client.mjs"

const t = tally()
const c = connect({ mode: "standard" })
const init = await c.init()
if (!init.result) {
  console.log("driver failed to start:\n" + c.stderr.slice(0, 300))
  process.exit(1)
}

const wins = await c.windows()
const edge = wins.find((w) => /msedge/i.test(w.app_name ?? "") && w.is_on_screen)
if (!edge) {
  console.log("no visible Edge window")
  process.exit(0)
}
console.log(`  Edge pid=${edge.pid} hwnd=${edge.window_id}`)
console.log(`  title: ${edge.title}\n`)

// Chromium's window tree is enormous, so bound it generously. A page load is a
// one-off cost; missing the metrics is the expensive mistake.
const s = await snap(c, edge, { elements: 12000, depth: 60, screenshot: false })
const els = s.elements ?? []
console.log(`  elements in the tree: ${els.length}`)
console.log(`  complete=${s.elements_complete} truncated=${s.truncated ?? false} visited=${s.nodes_visited ?? "?"}`)

// What is this actually a tree of? The window chrome, or the page?
const byRole = new Map()
for (const e of els) byRole.set(e.role, (byRole.get(e.role) ?? 0) + 1)
console.log(`\n  roles: ${[...byRole.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([r, n]) => `${r}=${n}`).join("  ")}`)

// Text nodes carry the page content. Only these can carry an engagement number.
const texts = els
  .filter((e) => e.role === "Text" || e.role === "StaticText" || e.role === "Hyperlink")
  .map((e) => (e.label ?? "").trim())
  .filter(Boolean)

console.log(`\n  text-bearing nodes: ${texts.length}`)

// Engagement metrics on this kind of site appear as a bare number, often with a
// unit. Look for the shapes, not for the Chinese labels: labels are localised and
// would tie this probe to one language for no benefit.
const NUMERIC = /^\d+(\.\d+)?\s*([万wWkK]|亿)?$/
const numerics = texts.filter((x) => NUMERIC.test(x))
const withUnit = texts.filter((x) => /^\d+(\.\d+)?\s*(万|亿|w|W|k|K)/.test(x))
const longNum = texts.filter((x) => /^\d{4,}$/.test(x))

console.log(`  bare numeric tokens : ${numerics.length}   e.g. ${JSON.stringify(numerics.slice(0, 12))}`)
console.log(`  with 万/亿/k unit   : ${withUnit.length}   e.g. ${JSON.stringify(withUnit.slice(0, 12))}`)
console.log(`  4+ digit integers   : ${longNum.length}   e.g. ${JSON.stringify(longNum.slice(0, 12))}`)

// Any media element at all? This answers the feasibility question honestly rather
// than by assumption. Reported as a COUNT AND KIND only.
const media = els.filter((e) => /image|video|media|picture/i.test(e.role ?? ""))
console.log(`\n  media-role elements : ${media.length}  roles=${JSON.stringify([...new Set(media.map((m) => m.role))])}`)

// Sample real page text so the report is grounded in what is actually there.
console.log(`\n  --- sample of visible text ---`)
for (const x of texts.slice(0, 40)) console.log(`    ${x.slice(0, 90)}`)

console.log(`\n  --- what this means ---`)
console.log(`  Metrics present in the tree: ${numerics.length > 0 ? "yes" : "NO"}`)
console.log(`  Media elements in the tree : ${media.length > 0 ? "yes" : "NO"}`)
console.log(`  Note: this probe reads the ACCESSIBILITY tree, not the DOM. Chromium`)
console.log(`  renders much of a page into UIA, but not everything, and numbers drawn`)
console.log(`  inside a canvas or a virtualised list can be absent from both.`)

t.check("page content is reachable through the accessibility tree", texts.length > 20, `${texts.length} text nodes`)
t.check("engagement-metric-shaped numbers are present", numerics.length > 0, `${numerics.length} numeric tokens`)
t.report()

await c.stop()