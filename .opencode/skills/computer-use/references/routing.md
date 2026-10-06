# Routing: how to choose a path for each step

Seven layers. Each layer can only *narrow* the path; the verification layer
(L5) decides whether to escalate. Read L0–L2 once, then consult L3–L5 per
action.

## L0 — Is there a better interface than the mouse?

Cheapest rule in the whole system. Qwen-CUA §4.3 measured this: adding a Bash
tool shortened trajectories (63.6 → 49.1 turns) but *dropped* accuracy
(58.7 → 55.1) because the model could not route reliably. Prefer interfaces,
but do not pretend mouse work is free.

| The task is | Use | Because |
|---|---|---|
| Files, git, processes, search | `shell` | Exact, verifiable, reversible |
| Anything inside a web page | `browser` namespace (CDP) | A DOM exists; do not use pixels |
| A native desktop GUI app | L1+ | Below |
| Canvas, games, custom-drawn UI | L1, expect AX to fail | No structured state exists |

## L1 — Which backend

| | cua-driver | cu.ps1 (this repo) |
|---|---|---|
| Moves the real mouse | No — agent cursor overlay, excluded from capture via `WDA_EXCLUDEFROMCAPTURE` (Win10 2004+) | Yes |
| Self-verifying | `effect` + accessibility read-back | Reports only "sent" |
| Addressing | `element_token`, pixels, DOM | Pixels only |
| Target binding | one-use `capture_id` | "Whatever is focused" |
| Platforms | Windows, macOS, Linux | Windows only |
| Dependency | installed binary | none, PowerShell only |

**Once cua-driver is available, `cu.ps1` must not be used for input actions.**
Its `type` lands on the current foreground window, which is exactly the
mistake this project already made once. Keep `cu.ps1` for offline capture and
diagnosis.

## L2 — What to observe

| Call | Returns | Use when |
|---|---|---|
| `list_windows` | pid, window_id, titles | Locating a target. Zero image tokens. |
| `get_desktop_state` | whole display + elements | Target unknown |
| `get_window_state` | that window's tree + screenshot | **Default entry point** |
| `get_accessibility_tree` | tree only | Elements only, no image |
| `get_window_state` + `include_screenshot:false` | tree only | Re-indexing after a layout change |

Bound cost with `max_elements` and `max_depth`, reuse `pid`/`window_id`, and
batch text into one `type_text`. Measured on their Calculator example, this cut
uncached input from 71,088 to 12,251 tokens.

## L3 — Addressing ladder

Order matters: **AX → PX → page → foreground**. `page` sits above `px`, so a
pixel failure in a browser escalates to the DOM, not to foreground.

| Rung | Target | Windows mechanism | When |
|---|---|---|---|
| AX | `element_token` | UIA Invoke | Target is in the tree and exposes an action |
| PX | `x, y` + the observation's `capture_id` | Window message / cursor | Target is only visible, or the field needs a real focus click |
| page | Browser tab binding | CDP | DOM exists |
| foreground | Delivery mode | Raise, input, restore | Rungs above refuse |

A pixel-derived click must carry the same one-use `capture_id` as the
observation that produced the coordinates. For keyboard tools, `x, y` first
clicks to give the field renderer focus — that is how you type into Chromium
and Electron inputs.

## L4 — Background or foreground

Background delivery does not raise the window, move the pointer, or change the
frontmost app.

Windows background reality, from `docs/action-support.md` (empirical, not
promised):

| Host | Background works | Background refuses |
|---|---|---|
| WPF | Combo selection, left click, value changes, PX left click via UIA hit-testing | F5, PX drag |
| WinUI3 | Control, value, selection, popup, slider | Right and double click unproven |
| Electron | Left click, child windows | Right/double click, drag (`background_occluded`); **`type_text`, `press_key`, `hotkey`, `scroll` all `background_unavailable`** |
| Tauri | Clicks, type, keys, child windows | `hotkey`, `scroll` PX, drag PX |
| WebView2 | CDP page operations | Native keyboard and broader pointer unproven |

**Consequence: Electron on Windows cannot take background typing.** Expect
foreground for those hosts and skip the wasted background attempts.

## L5 — Verification state machine

A delivered event is not an applied change. Electron, Catalyst, and web content
can echo a write they did not apply, so the driver reports those as
`unverifiable` rather than `confirmed`.

| `effect` | Meaning | What to do |
|---|---|---|
| `confirmed` | Read back through accessibility; `verified: true` | Proceed |
| `unverifiable` | Delivered, no read-back available | **Observe again.** Do not assume success. |
| `suspected_noop` | Nothing changed | Observe again, re-locate the target |
| `partial` | Some of it applied | Observe and reconcile |
| `refused` | Blocked before dispatch | Read `code` |

Refusal codes:

| Code | Meaning | Do not |
|---|---|---|
| `stale_element_token` | Snapshot expired | Reuse the token. Re-observe; the element route is fine. |
| `background_unavailable` | This host cannot take that shape in background | Retry only that action as foreground |
| `background_occluded` | Target is covered | Re-observe or escalate |
| `background_uipi_blocked` | Target runs elevated | Look for a workaround. Ask the user instead. |
| `session_ended` | Session expired (5 idle minutes) | `start_session` again |
| `bounded_resource_outside_manifest` | Outside `bounded` scope | Widen the manifest deliberately, not silently |

Every response may carry `escalation: {recommended: "px" | "page" | "foreground",
reason}`. Follow it. Do not improvise the next rung.

**Only `confirmed` counts as success.**

## L6 — Risk gates

Every action clears all of these, in this order. Each can only narrow.

1. Hard invariants (self-targeting, protected hosts)
2. Built-in tool and risk map
3. Managed policy — `CUA_DRIVER_MANAGED_POLICY_FILE`
4. User policy — `CUA_DRIVER_POLICY_FILE`
5. Permission mode — `standard` / `bounded` / `unrestricted`
6. Capability manifest — required in `bounded`
7. Launch grant or host decision

On top of that, in the agent layer:

| Gate | Test | Action |
|---|---|---|
| OpenCode permission | Read-only `allow`; state-changing `ask` | Prompt per action |
| Cua mode | `standard` allows input to **any** app | Move to `bounded` once stable |
| Irreversible | send, submit, pay, delete, overwrite, leave the machine | `question` first |
| Secrets | Password field appeared | Do not type. Ask the user. |
| Integrity | Target is elevated | Refuse; do not attempt to bypass |
| Staleness | `stale_element_token`, or >5 min idle | Re-observe |

## Loop

```text
task
 └─ L0 better interface? ── yes ──> use it, done
    └─ no
       └─ L1 cua-driver available?
          ├─ no ──> cu.ps1 for capture only, never input
          └─ yes ──> L2 observe (tree + screenshot)
                       └─ L3 target in tree?
                          ├─ yes ──> AX
                          ├─ browser ──> page
                          └─ neither ──> PX + capture_id
                             └─ L4 background supported?
                                ├─ yes ──> deliver
                                └─ no  ──> structured refusal
                                   └─ L5 effect
                                      ├─ confirmed ──> done
                                      └─ else ──> observe again,
                                                follow escalation
                                                 └─ L6 gates ──> deliver
```

## Cheat sheet

| You see | Do this | Not this |
|---|---|---|
| Target in tree with an action pattern | AX, background | Pixels |
| Target only in the screenshot | PX with `capture_id` | Expect AX to work |
| Field in the tree with no action pattern | PX to focus, then `type_text` | `type_text` alone |
| Electron on Windows | Foreground | Burn turns on background |
| Chromium page | page level (CDP) | AX or PX |
| `unverifiable` | Observe again | Treat as success |
| `suspected_noop` | Re-locate | Retry in place |
| `stale_element_token` | Re-observe | Reuse the token |
| `background_uipi_blocked` | Stop, ask the user | Find a bypass |
| Five attempts, no effect | Stop and report | Keep clicking |

## Maintenance

`docs/action-support.md` in the cua repo is the authority for what is proven per
platform and host. It changes as evidence lands. Re-check it before trusting a
rung on a host not listed in the table above.
