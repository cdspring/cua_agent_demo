# Analysis layer (P2)

Reads a file of note-level records and prints findings. **No browser, no network,
no collection.** Collection is a separate problem with separate obstacles; this
layer has to work without it, which is the point of building it now rather than
after the data question is settled.

```powershell
node analysis\analyze.mjs data.jsonl --followers snapshots.csv
node analysis\analyze.mjs sheet.csv
node analysis\analyze.mjs data.jsonl --json
```

Sample data runs end to end, so you can see the output shape before supplying
anything real:

```powershell
node analysis\analyze.mjs analysis\out\sample-notes.jsonl --followers analysis\out\sample-followers.csv
node analysis\analyze.mjs analysis\out\sample-sheet.csv
```

> Console encoding: the output contains 万/亿. On a GBK console run `chcp 65001`
> first, or the labels render as `?`.

## The one thing that decides whether any of this is valid

**Absolute engagement is confounded by audience size.** 1,000 likes from 10,000
followers is a *worse* result than 300 likes from 1,000 followers — by a factor of
three. Ranking notes or creators by raw like count mostly measures how big they
already are.

The synthetic sample makes this concrete, and it inverts completely:

| ranking by | first | last |
|---|---|---|
| median likes | SYNTHETIC-A (4,358) | SYNTHETIC-D (791) |
| engagement rate | SYNTHETIC-D (**212%**) | SYNTHETIC-A (**5.3%**) |

**So: add a followers column.** Everything else in this layer is secondary. Where
it is absent, rates are reported as `NOT AVAILABLE` with the reason — never
replaced by an absolute number wearing a rate's name.

## What it needs, and what each field buys

Minimum useful: **title, author, likes, followers**.

| field | enables | absent ⇒ |
|---|---|---|
| `likes` | everything | importer rejects the row |
| `followers` | engagement rate, tiers | rates unavailable; tiers fall back to median likes and say so |
| `collects` | collect-rate, saver-vs-liker split | interaction = likes only |
| `comments` | discussion-rate | interaction = likes only |
| `published_at` | cadence, weekday | cadence unavailable |
| `topics` | topic association | topics unavailable |
| `type` | video-vs-image comparison | — |
| `url` | manual re-checking of a row | — |

Growth curves need **two dated follower snapshots** for one author. Export the
same sheet twice, weeks apart, and merge with `--followers`. There is no way to
derive a curve from one snapshot, and the tool says so rather than drawing one.

## Formats it accepts

JSONL (one object per line), a JSON array, or CSV.

CSV headers are matched against an alias table, because a hand-kept sheet will not
use your field names:

```
作者 昵称 账号 author username        → author
标题 笔记标题 caption title           → title
点赞 点赞数 赞 likes like_count       → likes
收藏 收藏数 藏 collects               → collects
评论 评论数 comments                   → comments
发布时间 日期 发布日期 date           → published_at
粉丝 粉丝数 关注数 followers fans     → followers
话题 标签 tags topics hashtags        → topics
```

Unrecognised columns are ignored **with a warning**, so a stray 城市 column is
visible rather than silent.

## Two importer rules that matter

**An unreadable cell becomes null and is reported. It never becomes 0.**
Coercing to 0 is the most damaging thing an importer can do: a column where
收藏 was never captured turns into zeros, the mean drops, and the conclusion is
confidently wrong.

**Implausible values are reported, not corrected.** If an author's follower count
is below one of their note's like counts, the denominator is probably mis-parsed.
The tool flags it. It does not guess which of the two numbers is wrong — guessing
is how a wrong number becomes a right-looking one.

That check exists because it caught a real bug: `9.1千` parsed as **9**, because
the magnitude table had 万/亿/k but not 千. The same sheet reported a 48,507%
engagement rate. Adding 千 fixed it, and the lesson generalised — any magnitude a
person might type belongs in the table, not in a regex.

## Analyses produced

- **note-level distribution** — total, mean, median, p25/p75/p90, max, plus a
  skew note. If mean is more than double the median, a few notes dominate and the
  median is the number to quote.
- **engagement rate** — `(likes + collects + comments) / followers`, median and
  mean, with the top notes. Unavailable without followers.
- **per-author rollup** — notes, followers, median likes, median interactions,
  rate, and a **consistency** figure (p25 ÷ median). Consistency matters more than
  peak when deciding what is worth imitating; a creator who reliably clears their
  median is more useful to copy than one with a single spike.
- **tiers** — quartiles, and the tiering basis is always printed. When followers
  are absent it says "median likes, size-confounded" rather than quietly ranking
  on a different measure.
- **cadence** — span, notes/week, median gap, longest dry spell, and per-weekday
  medians with a noise caveat, because 5 notes per weekday cannot support a claim.
- **topics** — median engagement per topic, with the sample size shown and a
  caveat that one outlier moves a median at n≈10.
- **follower growth** — delta and per-day, only where two dated snapshots exist.

## What it deliberately does not do

- **No imputation.** A missing metric stays missing and says why.
- **No significance claims.** Every subgroup here is small. Topic and weekday
  results are labelled as hypotheses to check.
- **No collection.** Nothing in this directory opens a browser. If a future
  collector is added, it writes these files and does not belong in the analysis.

## Files

| | |
|---|---|
| `schema.json` | field definitions, alias table, parsing and sanity rules |
| `import.mjs` | CSV/JSONL reader, magnitude and date parsing, validation |
| `analyze.mjs` | the analyses and the report |
| `out/` | synthetic sample data. **Fabricated — not a finding about anything** |