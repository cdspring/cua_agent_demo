// P2 analysis layer. Reads a file, prints findings. No browser, no network.
//
//   node analysis/analyze.mjs analysis/sample-data.jsonl
//   node analysis/analyze.mjs data.csv --followers snapshots.csv
//   node analysis/analyze.mjs data.jsonl --json
//
// The organising constraint, from schema.json: ABSOLUTE engagement is confounded
// by audience size. 1,000 likes from 10,000 followers is a worse result than 300
// likes from 1,000 followers. So every rate here needs a follower count, and when
// the follower count is absent the metric is reported as unavailable rather than
// approximated. An analysis that quietly falls back to absolute numbers under a
// rate-flavoured name is worse than no analysis.
import { loadNotes, loadFollowerSnapshots } from "./import.mjs"

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith("--"))
const asJson = argv.includes("--json")
const fi = argv.indexOf("--followers")
const followerFile = fi !== -1 ? argv[fi + 1] : null

if (!file) {
  console.error("usage: node analysis/analyze.mjs <file.jsonl|csv> [--followers f.csv] [--json]")
  process.exit(2)
}

// ---------------------------------------------------------------- stats

const sum = (a) => a.reduce((x, y) => x + y, 0)
const mean = (a) => (a.length ? sum(a) / a.length : null)
const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const quantile = (a, q) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo)
}
const fmt = (n, d = 1) => (n === null || n === undefined ? "n/a" : Number(n).toFixed(d))
const pct = (n, d = 1) => (n === null || n === undefined ? "n/a" : `${(n * 100).toFixed(d)}%`)
const compact = (n) => {
  if (n === null || n === undefined) return "n/a"
  // Magnitude labels as unicode escapes. A literal was corrupted to mojibake by
  // PowerShell's Set-Content -Encoding UTF8 on this repo, which is a lesson this
  // repository already records and which I repeated while writing this.
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}\u4ebf`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}\u4e07`
  return String(Math.round(n))
}

// ---------------------------------------------------------------- load

let notes, warnings
try {
  const loaded = loadNotes(file)
  notes = loaded.notes
  warnings = loaded.warnings
} catch (err) {
  // A stack trace is the wrong response to "your file is missing" or "that sheet
  // has no likes column". Both are user errors with obvious fixes.
  console.error(`\n  cannot read ${file}: ${err.message}\n`)
  console.error(`  Expected JSONL, a JSON array, or CSV with a recognisable likes column`)
  console.error(`  (作者 / 点赞 / likes all work — see analysis/README.md for the alias table)\n`)
  process.exit(2)
}

const extra = loadFollowerSnapshots(followerFile)
const snapshots = extra.snapshots

// A follower count attached to a row, plus explicit snapshots, keyed by author.
const followersByAuthor = new Map()
for (const s of snapshots) {
  const list = followersByAuthor.get(s.author) ?? []
  list.push({ date: s.date, followers: s.followers })
  followersByAuthor.set(s.author, list)
}
for (const n of notes) {
  if (n.followers !== undefined) {
    const list = followersByAuthor.get(n.author) ?? []
    if (!list.length) list.push({ date: n.captured_at ?? null, followers: n.followers })
    followersByAuthor.set(n.author, list)
  }
}
for (const [, list] of followersByAuthor) list.sort((a, b) => String(a.date).localeCompare(String(b.date)))

const followerFor = (author) => {
  const list = followersByAuthor.get(author)
  if (!list || !list.length) return null
  return list[list.length - 1].followers
}

const hasAnyFollowers = followersByAuthor.size > 0

// Plausible-but-wrong inputs produce confident nonsense. A follower count below
// the note's own like count almost always means the denominator was mis-parsed --
// this exact failure happened when 9.1千 came back as 9. Report it; do not correct
// it, because guessing which of the two numbers is wrong is how a wrong number
// becomes a right-looking one.
const suspectDenominators = notes
  .filter((n) => {
    const f = followerFor(n.author)
    return f !== null && f > 0 && f < n.likes
  })
  .map((n) => ({ author: n.author, followers: followerFor(n.author), likes: n.likes }))

// ---------------------------------------------------------------- analyses

const authors = [...new Set(notes.map((n) => n.author))]
const byAuthor = new Map(authors.map((a) => [a, notes.filter((n) => n.author === a)]))

const authorRows = authors.map((a) => {
  const ns = byAuthor.get(a)
  const likes = ns.map((n) => n.likes)
  const f = followerFor(a)
  const inter = ns.map((n) => (n.likes ?? 0) + (n.collects ?? 0) + (n.comments ?? 0))
  return {
    author: a,
    notes: ns.length,
    followers: f,
    likesMedian: median(likes),
    likesMean: mean(likes),
    likesTotal: sum(likes),
    interactionMedian: median(inter),
    interactionRate: f ? median(inter) / f : null,
    bestLikes: Math.max(...likes),
    // Consistency matters more than peak for deciding what to imitate.
    consistency: likes.length > 1 ? fmt(quantile(likes, 0.25) / Math.max(1, median(likes)), 2) + "x" : "n/a",
  }
})

const report = {
  input: { file, followerFile: followerFile ?? null },
  data: {
    notes: notes.length,
    authors: authors.length,
    dateRange: (() => {
      const d = notes.map((n) => n.published_at).filter(Boolean).sort()
      return d.length ? { first: d[0], last: d[d.length - 1] } : null
    })(),
    staleDays: (() => {
      const c = notes.map((n) => n.captured_at).filter(Boolean).sort()
      if (!c.length) return null
      return Math.round((Date.now() - new Date(c[c.length - 1]).getTime()) / 86400000)
    })(),
    fieldCoverage: Object.fromEntries(
      ["likes", "collects", "comments", "published_at", "topics", "type", "url"].map((f) => [
        f,
        notes.filter((n) => n[f] !== undefined && n[f] !== null && (!Array.isArray(n[f]) || n[f].length)).length,
      ]),
    ),
    followersAvailable: hasAnyFollowers,
  },

  notes_: (() => {
    const likes = notes.map((n) => n.likes)
    return {
      count: likes.length,
      likes: {
        total: sum(likes),
        mean: mean(likes),
        median: median(likes),
        p25: quantile(likes, 0.25),
        p75: quantile(likes, 0.75),
        p90: quantile(likes, 0.9),
        max: Math.max(...likes),
        min: Math.min(...likes),
      },
      skewNote:
        mean(likes) !== null && median(likes) !== null && mean(likes) > median(likes) * 2
          ? "mean is more than double the median, so a few very popular notes dominate the average. Use the median."
          : "mean and median are close, so the average is representative.",
      top: [...notes].sort((a, b) => b.likes - a.likes).slice(0, 5).map((n) => ({ title: (n.title ?? "").slice(0, 40), author: n.author, likes: n.likes })),
    };
  })(),

  engagementRate: (() => {
    if (!hasAnyFollowers) {
      return { available: false, reason: "no follower count in the data, and rates are confounded by audience size" };
    }
    const per = []
    for (const n of notes) {
      const f = followerFor(n.author)
      if (!f) continue
      const inter = (n.likes ?? 0) + (n.collects ?? 0) + (n.comments ?? 0)
      per.push({ author: n.author, title: (n.title ?? "").slice(0, 40), rate: inter / f, likes: n.likes, followers: f })
    }
    if (!per.length) return { available: false, reason: "followers present but none could be paired with a note" }
    const rates = per.map((p) => p.rate)
    return {
      available: true,
      definition: "(likes + collects + comments) / followers",
      notesCovered: per.length,
      notesTotal: notes.length,
      medianRate: median(rates),
      meanRate: mean(rates),
      top: [...per].sort((a, b) => b.rate - a.rate).slice(0, 5),
    };
  })(),

  authors_: authorRows,

  tiers: (() => {
    // Tier by INTERACTION RATE when followers exist, otherwise by median likes,
    // and say which basis was used. Mixing the two silently would be the error.
    const basis = hasAnyFollowers ? "median interaction rate" : "median likes (followers absent, so this is size-confounded)"
    const keyed = authorRows.map((a) => ({ a, key: hasAnyFollowers ? a.interactionRate ?? 0 : a.likesMedian ?? 0 }))
    const keys = keyed.map((k) => k.key).filter((k) => k > 0).sort((x, y) => y - x)
    if (!keys.length) return { basis, tiers: [] }
    const cut = [keys[Math.floor(keys.length * 0.25)], keys[Math.floor(keys.length * 0.5)], keys[Math.floor(keys.length * 0.75)]]
    const tierOf = (k) => (k >= cut[0] ? "top" : k >= cut[1] ? "upper-mid" : k >= cut[2] ? "lower-mid" : "bottom")
    const tiers = {}
    for (const k of keyed) {
      const t = tierOf(k.key)
      ;(tiers[t] = tiers[t] || []).push(k.a.author)
    }
    return { basis, cutoffs: cut.map((c) => Number(c.toFixed(5))), tiers }
  })(),

  cadence: (() => {
    const dated = notes.filter((n) => n.published_at).sort((a, b) => a.published_at.localeCompare(b.published_at))
    if (dated.length < 3) return { available: false, reason: `need at least 3 dated notes, have ${dated.length}` }
    const gaps = []
    for (let i = 1; i < dated.length; i++) {
      gaps.push((new Date(dated[i].published_at) - new Date(dated[i - 1].published_at)) / 86400000)
    }
    const dow = {}
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    for (const n of dated) {
      const d = new Date(n.published_at).getUTCDay()
      ;(dow[names[d]] = dow[names[d]] || []).push(n.likes)
    }
    const dowMedian = Object.fromEntries(
      Object.entries(dow).map(([k, v]) => [k, { n: v.length, medianLikes: median(v) }]),
    )
    return {
      available: true,
      spanDays: Math.round((new Date(dated[dated.length - 1].published_at) - new Date(dated[0].published_at)) / 86400000),
      notesPerWeek: +(dated.length / ((new Date(dated[dated.length - 1].published_at) - new Date(dated[0].published_at)) / 604800000)).toFixed(2),
      gapMedianDays: +median(gaps).toFixed(1),
      gapMaxDays: Math.round(Math.max(...gaps)),
      longestDrySpellDays: Math.round(Math.max(...gaps)),
      byWeekday: dowMedian,
      weekdayNote:
        Object.keys(dowMedian).length >= 4
          ? "weekday medians are computed from very small samples per day; treat differences under ~30% as noise."
          : "too few days to say anything about timing.",
    };
  })(),

  topics: (() => {
    const tally = new Map()
    for (const n of notes) {
      const f = followerFor(n.author)
      const key = f ? (n.likes + (n.collects ?? 0) + (n.comments ?? 0)) / f : n.likes
      for (const t of n.topics ?? []) {
        if (!tally.has(t)) tally.set(t, { key: [], absolute: [] })
        tally.get(t).key.push(key)
        tally.get(t).absolute.push(n.likes)
      }
    }
    if (!tally.size) return { available: false, reason: "no topics field" }
    const rows = [...tally.entries()].map(([topic, v]) => ({
      topic,
      n: v.key.length,
      medianKey: median(v.key),
      medianLikes: median(v.absolute),
    }))
    const basis = hasAnyFollowers ? "median engagement rate" : "median likes"
    return {
      available: true,
      basis,
      note: hasAnyFollowers ? "" : "followers absent, so topic ranking is confounded by audience size. Read it as shape, not ranking.",
      topics: rows.sort((a, b) => (b.medianKey ?? 0) - (a.medianKey ?? 0)),
      caveat: `with ${Math.max(...rows.map((r) => r.n))} notes at most per topic, a single outlier moves the median. Treat as a hypothesis to check, not a result.`,
    };
  })(),

  growth: (() => {
    const withTwo = [...followersByAuthor.entries()].filter(([, l]) => l.filter((x) => x.date).length >= 2)
    if (!withTwo.length) {
      return {
        available: false,
        reason: "a growth curve needs at least two dated follower snapshots for one author. Export the same sheet twice, weeks apart, and merge.",
      }
    }
    return {
      available: true,
      series: withTwo.map(([a, l]) => {
        const dated = l.filter((x) => x.date)
        const first = dated[0]
        const last = dated[dated.length - 1]
        const days = (new Date(last.date) - new Date(first.date)) / 86400000
        return {
          author: a,
          from: first.followers,
          to: last.followers,
          delta: last.followers - first.followers,
          days: Math.round(days),
          perDay: days > 0 ? +((last.followers - first.followers) / days).toFixed(1) : null,
        };
      }),
    };
  })(),

  integrity: {
    suspectDenominators,
    note: "followers below the note's own like count usually means a mis-parsed denominator. Reported, not corrected."
  },
  warnings: [...warnings, ...extra.warnings],
}

// ---------------------------------------------------------------- output

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const d = report.data
const nodeMajor = Number(process.versions.node.split(".")[0])
console.log(`\n=== analysis: ${d.notes} notes, ${d.authors} authors ===`)
if (nodeMajor < 16) {
  // This ran on Node 14 before it was noticed. fs.cpSync and ??= are both absent
  // there, and both cost a debugging cycle. Recorded here so the constraint is
  // visible in the output rather than rediscovered.
  console.log(`  note: Node ${process.versions.node}. Avoid fs.cpSync, ??=, and .at(); this file sticks to Node 14 syntax.`)
}
if (d.dateRange) console.log(`  published ${d.dateRange.first} .. ${d.dateRange.last}`)
if (d.staleDays !== null) console.log(`  captured ${d.staleDays} days ago 閳?engagement on older notes keeps growing, so absolute counts age`)
console.log(`  field coverage: ${Object.entries(d.fieldCoverage).map(([k, v]) => `${k} ${v}/${d.notes}`).join("  ")}`)

console.log(`\n--- note-level likes ---`)
const L = report.notes_.likes
console.log(`  total ${compact(L.total)}   mean ${compact(Math.round(L.mean))}   median ${compact(Math.round(L.median))}`)
console.log(`  p25 ${compact(Math.round(L.p25))}   p75 ${compact(Math.round(L.p75))}   p90 ${compact(Math.round(L.p90))}   max ${compact(L.max)}`)
console.log(`  ${report.notes_.skewNote}`)

console.log(`\n--- engagement rate ---`)
const e = report.engagementRate
if (!e.available) {
  console.log(`  NOT AVAILABLE: ${e.reason}`)
  console.log(`  Add a followers column. Without it, ranking anything by likes mostly measures audience size.`)
} else {
  console.log(`  ${e.definition} 閳?covers ${e.notesCovered}/${e.notesTotal} notes`)
  console.log(`  median ${pct(e.medianRate, 2)}   mean ${pct(e.meanRate, 2)}`)
  for (const t of e.top) console.log(`    ${pct(t.rate, 2).padStart(7)}  ${compact(t.likes).padStart(6)} likes  ${t.author}  ${t.title}`)
}

console.log(`\n--- per author ---`)
console.log(`  ${"author".padEnd(22)} ${"n".padStart(3)} ${"followers".padStart(11)} ${"medLikes".padStart(9)} ${"medInter".padStart(9)} ${"rate".padStart(8)}  consistency`)
for (const a of [...report.authors_].sort((x, y) => (y.interactionRate ?? y.likesMedian ?? 0) - (x.interactionRate ?? x.likesMedian ?? 0))) {
  console.log(
    `  ${String(a.author).slice(0, 21).padEnd(22)} ${String(a.notes).padStart(3)} ${compact(a.followers).padStart(11)} ` +
      `${compact(Math.round(a.likesMedian)).padStart(9)} ${compact(Math.round(a.interactionMedian)).padStart(9)} ` +
      `${(a.interactionRate === null ? "n/a" : pct(a.interactionRate, 2)).padStart(8)}  ${a.consistency}`,
  )
}

console.log(`\n--- tiers ---`)
console.log(`  basis: ${report.tiers.basis}`)
for (const [t, list] of Object.entries(report.tiers.tiers)) console.log(`  ${t.padEnd(10)} ${list.join(", ")}`)

console.log(`\n--- publishing cadence ---`)
const cd = report.cadence
if (!cd.available) console.log(`  NOT AVAILABLE: ${cd.reason}`)
else {
  console.log(`  span ${cd.spanDays}d   ${cd.notesPerWeek} notes/week   median gap ${cd.gapMedianDays}d   longest dry spell ${cd.longestDrySpellDays}d`)
  console.log(`  ${Object.entries(cd.byWeekday).map(([k, v]) => `${k} n=${v.n} med=${compact(Math.round(v.medianLikes))}`).join("  ")}`)
  console.log(`  ${cd.weekdayNote}`)
}

console.log(`\n--- topics ---`)
const tp = report.topics
if (!tp.available) console.log(`  NOT AVAILABLE: ${tp.reason}`)
else {
  console.log(`  basis: ${tp.basis}${tp.note ? ` 閳?${tp.note}` : ""}`)
  for (const t of tp.topics.slice(0, 12)) console.log(`    ${String(t.topic).slice(0, 24).padEnd(26)} n=${String(t.n).padStart(2)}  med ${hasAnyFollowers ? pct(t.medianKey, 2) : compact(Math.round(t.medianLikes))}`)
  console.log(`  ${tp.caveat}`)
}

console.log(`\n--- follower growth ---`)
const g = report.growth
if (!g.available) console.log(`  NOT AVAILABLE: ${g.reason}`)
else for (const s of g.series) console.log(`  ${s.author}: ${compact(s.from)} -> ${compact(s.to)}  (${s.delta >= 0 ? "+" : ""}${s.delta} over ${s.days}d, ${s.perDay}/day)`)

if (report.integrity.suspectDenominators.length) {
  console.log(`\n--- data integrity (${report.integrity.suspectDenominators.length}) ---`)
  console.log(`  ${report.integrity.note}`)
  for (const s of report.integrity.suspectDenominators.slice(0, 10)) {
    console.log(`    ${String(s.author).slice(0, 22).padEnd(24)} followers=${String(s.followers).padStart(8)}  likes=${s.likes}`)
  }
  if (report.integrity.suspectDenominators.length > 10) console.log(`    ... and ${report.integrity.suspectDenominators.length - 10} more`)
  console.log(`  Rates for these authors are computed on a denominator that is probably wrong.`)
}

if (report.warnings.length) {
  console.log(`\n--- importer warnings (${report.warnings.length}) ---`)
  for (const w of report.warnings.slice(0, 20)) console.log(`  ${w}`)
  if (report.warnings.length > 20) console.log(`  ... and ${report.warnings.length - 20} more`)
}

console.log(`
  Every "NOT AVAILABLE" above is a missing column, not a failure. An absent
  metric is reported absent; it is never replaced by an absolute number wearing a
  rate's name.`)
