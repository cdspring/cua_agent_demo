// Re-test the accessibility rung on Chromium with the settle the driver asks for.
//
// The first probe returned 210 elements whose visible text was almost entirely
// footer boilerplate (ICP licence numbers, company registration), with zero
// media-role elements and only 12 unattributable numeric tokens. That is the
// signature of an under-engaged UIA tree rather than a page with no metrics.
//
// The driver's own degraded_reason says: "Chromium/Electron require a UIA-enable
// + settle". Chromium does not build a full accessibility tree until something
// asks for accessibility, and it settles asynchronously. So a tree walked
// immediately after the window came to the front is not evidence about the page.
//
// This waits, re-walks several times, and reports the element count over time so
// the growth is visible rather than asserted.
import { connect, snap, tally, sleep } from "./lib/cua-client.mjs"

const t = tally()
const c = connect({ mode: "standard" })
await c.init()

const edge = (await c.windows()).find((w) => /msedge/i.test(w.app_name ?? "") && w.is_on_screen)
if (!edge) {
  console.log("no visible Edge window")
  process.exit(0)
}
console.log(`  Edge pid=${edge.pid}  "${edge.title.slice(0, 70)}"\n`)
console.log("  walking the tree repeatedly, watching for Chromium to engage:\n")

let best = { n: 0 }
for (let i = 1; i <= 6; i++) {
  const s = await snap(c, edge, { elements: 20000, depth: 80, screenshot: false })
  const els = s.elements ?? []
  const texts = els.filter((e) => e.role === "Text" || e.role === "StaticText")
  const named = texts.filter((e) => (e.label ?? "").trim())
  const media = els.filter((e) => /image|video|media|picture/i.test(e.role ?? ""))
  console.log(
    `  walk ${i}: elements=${String(els.length).padStart(5)}  visited=${String(s.nodes_visited ?? 0).padStart(5)}` +
      `  complete=${s.elements_complete}  text=${String(named.length).padStart(4)}  media=${String(media.length).padStart(3)}`,
  )
  if (els.length > best.n) best = { n: els.length, els, s }
  await sleep(2500)
}

const els = best.els ?? []
const texts = els
  .filter((e) => e.role === "Text" || e.role === "StaticText" || e.role === "Hyperlink")
  .map((e) => (e.label ?? "").trim())
  .filter(Boolean)

// Separate footer noise from content. The first probe's sample was almost all
// legal boilerplate, which is exactly what makes a "there are numbers" claim
// worthless: licence numbers are numbers too.
const NOISE = /ICP|营业执照|许可证|备案|举报|版权所有|©|有限公司|地址|电话|公安网备|增值电信|医疗器械/
const content = texts.filter((x) => !NOISE.test(x))
const NUMERIC = /^\d+(\.\d+)?\s*(万|亿|w|W|k|K)?$/
const contentNums = content.filter((x) => NUMERIC.test(x))

console.log(`\n  best walk: ${els.length} elements, ${texts.length} text nodes`)
console.log(`  of which non-footer: ${content.length}`)
console.log(`  metric-shaped numbers outside the footer: ${contentNums.length}`)
console.log(`  ${JSON.stringify(contentNums.slice(0, 20))}`)

console.log(`\n  --- non-footer sample ---`)
for (const x of content.slice(0, 30)) console.log(`    ${x.slice(0, 90)}`)

console.log(`\n  --- media ---`)
const media = els.filter((e) => /image|video|media|picture/i.test(e.role ?? ""))
console.log(`  media-role elements: ${media.length}`)
if (media.length) for (const m of media.slice(0, 10)) console.log(`    role=${m.role} label="${(m.label ?? "").slice(0, 50)}"`)

t.check("the tree grows or stays large across repeated walks", best.n > 200, `best ${best.n} elements`)
t.check("non-footer page content is present", content.length > 10, `${content.length} non-footer text nodes`)
t.check("metric-shaped numbers exist outside the footer", contentNums.length > 0, `${contentNums.length}`)

await c.stop()
t.report()