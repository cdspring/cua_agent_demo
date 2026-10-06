// Importer for the analysis layer. Accepts what a person actually has.
//
// Deliberately format-tolerant and deliberately strict about one thing: an
// unreadable cell becomes null and is REPORTED, never coerced to 0.
//
// Coercing to 0 is the most damaging thing an importer can do. A column where
// "收藏" was not captured becomes 35 zeros, the mean collect count drops, and the
// conclusion that follows is confidently wrong. Every project in this repository
// that produced a wrong conclusion did it by asserting on something it had not
// checked; this is the same failure wearing a data-cleaning hat.
//
// Also: this file touches no browser and reads no network. Collection is a
// separate problem with separate obstacles, and the analysis layer must work
// without it.
import { readFileSync, existsSync } from "node:fs"

const SCHEMA = JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8"))
const ALIASES = SCHEMA.aliases

// ---------------------------------------------------------------- scalars

/** "1.2万" -> 12000, "3.8k" -> 3800, "1,234" -> 1234, "赞" -> null. */
export function parseCount(raw) {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim()
  if (!s) return null
  // A cell that holds a unit with no number means "not captured", not zero.
  if (/^(赞|收藏|评论|分享|-|—|n\/?a|null|none|-|)$/i.test(s)) return null
  s = s.replace(/[,，\s]/g, "")
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([万wW亿kK千]?)/)
  if (!m) return null
  let n = parseFloat(m[1])
  const unit = m[2]
  // 千 was absent from the magnitude table until this was run against a
  // hand-entered sheet containing 9.1千. The regex matched 9.1 with no unit and
  // returned 9, so 9,100 followers became 9 and the engagement rate came out at
  // 48507%. The lesson generalises: any magnitude a person might type belongs in
  // the table, not in a regex.
  const MAG = { ...SCHEMA.parsing.magnitude, "\u5343": 1000 }
  if (MAG[unit]) n *= MAG[unit]
  return Number.isFinite(n) ? Math.round(n) : null
}

/** Accepts the date shapes a hand-kept sheet produces. Never guesses at ambiguity. */
export function parseDate(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  const cn = s.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/)
  if (cn) return iso(+cn[1], +cn[2], +cn[3])
  const ymd = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (ymd) return iso(+ymd[1], +ymd[2], +ymd[3])
  const parsed = new Date(s)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  return null
}
const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null)

function parseTopics(raw) {
  if (raw === null || raw === undefined) return null
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean)
  const s = String(raw).trim()
  if (!s) return null
  return s
    .split(/[,，;；#\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------- CSV

/** Minimal RFC4180-ish CSV reader: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text) {
  // Excel and other spreadsheet exporters write a UTF-8 BOM. Left in place it
  // becomes part of the first header cell, so a column named "name" reads as
  // "\uFEFFname" and matches no alias. Symptom: "no likes column found" on a
  // sheet that visibly has one.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows = []
  let row = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""))
}

/** Map a header cell onto a canonical field via the alias table. */
function canonicalField(header) {
  const h = String(header).trim().toLowerCase().replace(/\s+/g, "")
  for (const [field, names] of Object.entries(ALIASES)) {
    // The table also holds $comment and nested objects such as parsing.magnitude.
    // Only the arrays of strings are alias lists; treating an object as one threw
    // "names.some is not a function" on the first nested key encountered.
    if (!Array.isArray(names)) continue
    if (names.some((n) => String(n).toLowerCase().replace(/\s+/g, "") === h)) return field
  }
  return null
}

// ---------------------------------------------------------------- records

function normalise(obj, i) {
  const warnings = []
  const rec = {}
  const author = obj.author ?? obj.author_name
  if (!author) warnings.push(`row ${i}: no author`)
  rec.author = author ? String(author).trim() : null

  for (const f of ["note_id", "title", "url", "type"]) {
    if (obj[f] !== undefined && obj[f] !== null && String(obj[f]).trim()) rec[f] = String(obj[f]).trim()
  }
  rec.likes = parseCount(obj.likes)
  if (rec.likes === null) warnings.push(`row ${i}: likes unreadable (${JSON.stringify(obj.likes)})`)
  for (const f of ["collects", "comments", "shares", "duration_seconds"]) {
    const v = parseCount(obj[f])
    if (v !== null) rec[f] = v
  }
  const t = parseTopics(obj.topics)
  if (t) rec.topics = t
  const pub = parseDate(obj.published_at)
  if (obj.published_at && !pub) warnings.push(`row ${i}: published_at unreadable (${JSON.stringify(obj.published_at)})`)
  if (pub) rec.published_at = pub
  const followers = parseCount(obj.followers)
  if (followers !== null) rec.followers = followers
  const cap = parseDate(obj.captured_at)
  if (cap) rec.captured_at = cap
  return { rec, warnings, hasFollowers: followers !== null }
}

/**
 * Load notes from JSONL or CSV. Returns { notes, followers, warnings }.
 *
 * A row carrying a `followers` column becomes that note's author follower count,
 * and also contributes a snapshot dated captured_at, which is what makes a growth
 * curve possible from a sheet exported more than once.
 */
export function loadNotes(file) {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`)
  const text = readFileSync(file, "utf8")
  const warnings = []
  const notes = []
  const followerByAuthor = new Map()

  const trimmed = text.trim()
  const isJsonl = trimmed.startsWith("{") || trimmed.startsWith("[")

  if (isJsonl) {
    let objs
    if (trimmed.startsWith("[")) {
      try {
        objs = JSON.parse(trimmed)
      } catch (e) {
        throw new Error(`looks like a JSON array but does not parse: ${e.message}`)
      }
    } else {
      objs = trimmed
        .split(/\r?\n/)
        .map((l, i) => {
          const t = l.trim()
          if (!t) return null
          try {
            return JSON.parse(t)
          } catch (e) {
            warnings.push(`line ${i + 1}: ${e.message}`)
            return null
          }
        })
        .filter(Boolean)
    }
    objs.forEach((o, i) => {
      const { rec, warnings: w, hasFollowers } = normalise(o, i + 1)
      warnings.push(...w)
      if (rec.author && rec.likes !== null) {
        notes.push(rec)
        if (hasFollowers) {
          followerByAuthor.set(rec.author, { author: rec.author, followers: rec.followers, date: rec.captured_at ?? null })
        }
      }
    })
  } else {
    const rows = parseCsv(text)
    if (rows.length === 0) throw new Error("CSV is empty")
    const header = rows[0]
    const map = header.map(canonicalField)
    const unmapped = header.filter((h, i) => !map[i] && h.trim())
    if (unmapped.length) {
      warnings.push(`CSV header not recognised, ignored: ${unmapped.join(", ")}`)
      warnings.push(`  recognised as: ${header.map((h, i) => (map[i] ? `${h}->${map[i]}` : null)).filter(Boolean).join(", ")}`)
    }
    if (!map.includes("likes")) {
      throw new Error(`no likes column found. Header was: ${header.join(", ")}`)
    }
    rows.slice(1).forEach((cells, r) => {
      const o = {}
      map.forEach((field, i) => {
        if (field) o[field] = cells[i]
      })
      const { rec, warnings: w, hasFollowers } = normalise(o, r + 2)
      warnings.push(...w)
      if (rec.author && rec.likes !== null) {
        notes.push(rec)
        if (hasFollowers) {
          followerByAuthor.set(rec.author, { author: rec.author, followers: rec.followers, date: rec.captured_at ?? null })
        }
      }
    })
  }

  const followers = [...followerByAuthor.values()]
  return { notes, followers, warnings, followerScoped: true }
}

/** Merge an explicit follower-snapshots file, for growth curves across dates. */
export function loadFollowerSnapshots(file) {
  if (!file || !existsSync(file)) return { snapshots: [], warnings: [] }
  const text = readFileSync(file, "utf8")
  const warnings = []
  const snapshots = []
  const rows = text.trim().startsWith("{") || text.trim().startsWith("[")
    ? (text.trim().startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)))
    : (() => {
        const r = parseCsv(text)
        const map = r[0].map(canonicalField)
        return r.slice(1).map((cells) => {
          const o = {}
          map.forEach((f, i) => {
            if (f) o[f] = cells[i]
          })
          return o
        })
      })()
  for (const [i, o] of rows.entries()) {
    const author = o.author ? String(o.author).trim() : null
    const followers = parseCount(o.followers)
    const date = parseDate(o.date ?? o.captured_at ?? o.published_at)
    if (!author || followers === null || !date) {
      warnings.push(`snapshot ${i + 1}: incomplete (author=${author} followers=${o.followers} date=${o.date})`)
      continue
    }
    snapshots.push({ author, followers, date })
  }
  return { snapshots, warnings }
}