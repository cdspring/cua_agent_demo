# Routing: how to choose a path for each step

Seven layers. Each layer can only *narrow* the path; the verification layer
(L5) decides whether to escalate.

**Verified against cua-driver 0.34.0 on Windows.** Where this file and the
driver's own docs disagree, the driver is right. Re-check with
`cua-driver list-tools` and `cua-driver describe <tool>` after an upgrade.

## L0 — Is there a better interface than the mouse?

Qwen-CUA §4.3 measured this: adding a Bash tool shortened trajectories
(63.6 → 49.1 turns) but *dropped* accuracy (58.7 → 55.1) because routing was
unreliable. Prefer interfaces, but mouse work is not free.

| The task is | Use | Because |
|---|---|---|
| Files, git, processes, search | `shell` | Exact, verifiable, reversible |
| Inside a web page | `browser_prepare` → `get_browser_state` → `browser_*` | A DOM exists; do not use pixels |
| A native desktop GUI app | L1+ | Below |
| Canvas, games, custom-drawn UI | L1, expect element routing to fail | No structured state |

## L1 — Which backend

| | cua-driver 0.34.0 | cu.ps1 (this repo) |
|---|---|---|
| Moves the real mouse | No — per-session agent cursor overlay | Yes |
| Self-verifying | `effect` + accessibility read-back | Reports only "sent" |
| Addressing | `element_token`, pixels, DOM | Pixels only |
| Target binding | one-use `capture_id` | "Whatever is focused" |
| Platforms | Windows, macOS, Linux | Windows only |
| Dependency | installed binary | none, PowerShell only |

**Once cua-driver is available, `cu.ps1` must not be used for input actions.**
Its `type` lands on the focused window with no target binding, which is how
this project typed into a browser tab during development. Keep it for offline
capture and diagnosis.

## L2 — What to observe

| Call | Returns | Use when |
|---|---|---|
| `get_accessibility_tree` | processes + visible windows, cheap | Discovery. Fast, no screenshot |
| `list_windows` | every top-level window, with `z_index` and `minimized` | Discovery |
| `get_window_state` | **tree AND screenshot together** | **Default entry point** |
| `get_desktop_state` | whole display | Target spans displays |
| `get_window_state` + `include_screenshot:false` | tree only | Re-indexing cheaply |
| `get_window_state` + `include_accessibility_tree:false` | screenshot only | Live preview, no tree needed |
| `zoom` | region at native resolution | Small target in a large window |
| `get_screen_size` | display size and scale | Before desktop-scope pixels |
| `set_window_frame` | exact geometry, verified | Moving or resizing a window |
| `invoke_menu` | native menu path | Menu-bar commands |
| `clipboard_read` / `clipboard_write` | clipboard contents | Text transfer that beats typing |

**There is no `wait` tool in 0.34.0.** Pause with `shell`'s `sleep`, or bound an
existing call: `type_text` has `delay_ms`, `get_window_state` has `timeout_ms`,
`scroll` has `amount`.

`get_window_state` returns both modalities in one call. `capture_mode` is
deprecated and ignored — the modality is chosen **at action time** by whether
you pass an `element_token` (accessibility) or `x,y` (pixel).

Cost control: `max_elements` (default 5000), `max_depth` (default 25),
`max_image_dimension`, and `query` to project to matching rows plus ancestors.
A Chromium tree is ~5000 elements and returns in 2–3s. Their Calculator example
cut uncached input from 71,088 to 12,251 tokens with these bounds.

## L3 — Addressing

| Rung | Pass | Mechanism |
|---|---|---|
| Element | `element_token` | UIA Invoke / ValuePattern |
| Element, value only | `set_value` + `element_token` | UIA ValuePattern, read back |
| Pixel | `x`, `y` + the observation's `capture_id` | Window message / cursor |
| Page | `browser_prepare` → `browser_*` | CDP against an exactly-bound tab |
| Foreground | `delivery_mode: "foreground"` | Raise, input, restore |

`element_token` matches `^s[0-9a-f]{8}:[0-9]+$` and comes from
`structuredContent.elements[].element_token`.

**Tokens are invalidated by the next snapshot of the same `(pid, window_id)`.**
The replacement response lists the old ids in `invalidated_snapshot_ids`. Take
one `get_window_state` per turn per window before any element action.

### Two coordinate spaces

This is the most reliable way to get a `capture_coordinate_invalid` refusal:

| Source | Space |
|---|---|
| `element.frame` | **Desktop** absolute pixels |
| `x,y` with `capture_id` | **Window-local** screenshot pixels |
| `x,y` with `scope: "desktop"` | Screen pixels |

`local = frame - window_bounds.origin`. Verified: element frame
`{x:1529,y:390,w:64,h:64}` with window origin `(779,309)` became local
`(782,113)`, which dispatched; the desktop value `(1561,422)` was refused.

`capture_id` is **optional**. Omitting it still works and routes through
`synthetic_events`; supplying it admits the coordinates against that exact
capture. Element `frame` values are always desktop coordinates.

## L4 — Delivery: background first, always

`delivery_mode` defaults to `background`, which never raises the window, moves
the real pointer, or changes the frontmost app.

> **The driver is explicit: background is the mandatory first attempt. Do NOT
> pass `foreground` preemptively because a target "looks like" GTK, Chromium or
> Electron.** The driver decides when background is impossible and returns
> `background_unavailable`. Only then re-issue that same action as foreground.
> Fronting up-front needlessly steals the user's focus and is a bug, not a
> shortcut.

So: try background, read `effect`, escalate only on a real refusal.

Windows background reality, from the driver's `docs/action-support.md`
(empirical, not promised):

| Host | Background works | Background refuses |
|---|---|---|
| WPF | Combo selection, left click, value changes, PX left click via UIA hit-testing | F5, PX drag |
| WinUI3 | Control, value, selection, popup, slider | Right and double click unproven |
| Electron | Left click, child windows | Right/double click, drag (`background_occluded`); `type_text`, `press_key`, `hotkey`, `scroll` → `background_unavailable` |
| Tauri | Clicks, type, keys, child windows | `hotkey`, `scroll` PX, drag PX |
| WebView2 | CDP page operations | Native keyboard and broader pointer unproven |

This table tells you what to expect. It is **not** a list of what to choose.
Choose background; let the driver refuse.

## L5 — Verification

**Action facts are not task outcomes.** This is the single most important rule
in the layer, and the driver's own `WORKFLOW.md` states it directly: even
`effect: confirmed` means only "the action has publishable readback — still
check the task postcondition".

| `effect` | Meaning for the next decision |
|---|---|
| `confirmed` | Publishable readback exists. **Still verify the task postcondition.** |
| `unverifiable` | Delivery cannot prove effect. Observe before retrying. |
| `suspected_noop` | Evidence suggests no useful change |
| `partial` | Only the delivered portion landed. Inspect before repairing. |
| `refused` | The route deliberately did not deliver |

| `route` | Actuator class |
|---|---|
| `accessibility` | UIA Invoke / ValuePattern |
| `synthetic_events` | Posted window messages |
| `global_input` | System-wide injected input |
| `dom` | CDP against a bound tab |
| `trusted_input` | Browser-trusted pointer input |

`escalation` is a **suggestion, never authorization and never an automatic
retry**: `target` is `pixel`, `foreground` or `page`; `reason` is
`route_unavailable`, `delivery_failed`, `effect_unconfirmed`,
`suspected_noop` or `permission_required`.

Observed on Windows 0.34.0: a Calculator button and a Calculator pixel click both
returned `unverifiable` while demonstrably changing state, whereas `type_text`
on a real Notepad `Document` returned `confirmed` via `accessibility`. Treat
`unverifiable` as "unknown", not "failed", and confirm by re-observing.

For an expressible postcondition, `verify_state` is the right tool. Predicates
return `satisfied`, `unsatisfied` or `unknown`, with `unknown_reason` naming
ambiguous matches, untrusted web state, or too few stable samples.
**`unknown` is not success.** Text inside web content stays `unknown` with
`untrusted_source`; read it from a fresh snapshot instead.

### Never replay automatically

Never replay a cancelled, partial or unknown action. An interrupted transport
may have delivered input before losing its response, so a retry can duplicate
it. Report the interruption and take fresh state first.

For text, `unverifiable` specifically means: take a fresh snapshot before
retrying, because a deferred provider can publish *after* the call returns and
an immediate retry may type the text twice.

When the postcondition is satisfied, stop acting. For media, selection is not
playback — check the title and elapsed progress. For a close request, verify
the window actually disappeared. State only what the evidence proves.

## L6 — Risk gates

Every action clears all of these, in order. Each can only narrow.

1. Hard invariants (self-targeting, protected hosts)
2. Built-in tool and risk map
3. Managed policy — `CUA_DRIVER_MANAGED_POLICY_FILE`
4. User policy — `CUA_DRIVER_POLICY_FILE`
5. Permission mode — `standard` / `bounded` / `unrestricted`
6. Capability manifest — required in `bounded`
7. Launch grant or host decision

Agent layer, on top:

| Gate | Test | Action |
|---|---|---|
| OpenCode permission | Read-only `allow`; state-changing `ask` | Prompt per action |
| Cua mode | `standard` allows input to **any** app | Move to `bounded` once stable |
| Irreversible | send, submit, pay, delete, overwrite | `question` first |
| Secrets | Password field present | Do not type. Ask the user. |
| Integrity | Target is elevated | Refuse; do not bypass |
| Staleness | `stale_element_token`, or 5 min idle | Re-observe |

### bounded mode, measured on Windows

`bounded` runs seven narrowing layers. Two of them are separate and it matters
which one fired:

| Refusal code | Layer | Meaning |
|---|---|---|
| `permission_denied` | `allow.tools` | The tool's **name** is not listed |
| `bounded_resource_outside_manifest` | `resources` | The tool is allowed but the **resource** it touches is not in scope |

**`desktop.display` must be `true` on Windows.** With `false`, the runtime
refuses `list_windows`, `list_apps`, `get_accessibility_tree`, `click` and
`type_text` with *"desktop display observation is outside the capability
manifest"*. The agent then cannot learn a pid or window_id, so it cannot address
anything: the manifest deadlocks. This flag means "may the agent see the
desktop at all", not merely "may it take a full screenshot".

The boundary that actually constrains the agent is `resources.apps`, matched
against **the executable that owns the window**, not the one that was launched.
Verified: a manifest-listed `charmap.exe` is addressable (15 elements), while
`SystemSettings.exe` and `explorer.exe` are refused with
`bounded_resource_outside_manifest`.

Packaged apps are the trap here. Calculator's window is owned by a package copy
under `WindowsApps`, not by `calc.exe`, so listing `calc.exe` will not authorise
it. Check `list_windows`' `app_name`, or `Get-Process`'s `Path`, before writing
an app entry. Those paths carry the **package version**, so a Windows update can
invalidate an entry that was correct an hour ago — during testing, Calculator
moved from `ApplicationFrameHost.exe` to `CalculatorApp.exe`. Re-derive with
`scripts/probe-app-owners.mjs` after updates. Third-party apps with stable install
paths are the maintainable case.

`bounded` also fails closed rather than degrading: with no manifest, or with a
manifest but no approval, startup is refused outright.

### Minimized windows

A minimized window stays in the manifest and stays addressable, but its UIA tree
collapses. Measured: WeChat minimized exposed 1 element against 8 when visible.
Do not treat a small element count on a minimized window as a permission
problem, and do not infer reachability from `is_on_screen`.

## Loop

```text
task
 └─ L0 better interface? ── yes ──> use it, done
    └─ no
       └─ L1 cua-driver available?
          ├─ no ──> cu.ps1 for capture only, never input
          └─ yes ──> L2 observe (get_window_state: tree + screenshot)
                       └─ L3 target in the tree?
                          ├─ yes ──> element_token  (or set_value)
                          ├─ browser ──> browser_*
                          └─ neither ──> x,y + capture_id
                             └─ L4 delivery_mode background (ALWAYS FIRST)
                                ├─ delivered ──> L5 read effect
                                └─ background_unavailable ──> same action, foreground
                                   └─ L5 effect
                                      ├─ confirmed ──> done
                                      └─ else ──> observe again
                                                └─ L6 gates ──> deliver
```

## Deprecated in 0.34.0 — do not use

| Tool | Status | Use instead |
|---|---|---|
| `escalate_session` | Deprecated compatibility tool | Nothing. It was capture-scope; scope is now explicit per call |
| `page` | Legacy browser compatibility | `browser_prepare` → `browser_*` |
| `get_session_state` | Deprecated alias | `get_session` |
| `capture_mode` on `get_window_state` | Deprecated **and ignored** | Choose modality at action time |

## Cheat sheet

| You see | Do this | Not this |
|---|---|---|
| Target in tree with an action | `element_token`, background | Pixels |
| Text field in tree | `set_value` + token | `type_text` |
| Target only in the screenshot | `x,y` + `capture_id` | Expect element routing to work |
| Any action, always | `delivery_mode: background` first | Preemptively foreground |
| `background_unavailable` | Re-issue that action as foreground | Guess from the app's type |
| Chromium page | `browser_*` after `browser_prepare` | Element or pixel routing |
| `effect: unverifiable` | Observe again | Assume success |
| `effect: suspected_noop` | Re-locate | Retry in place |
| `stale_element_token` | Re-observe | Reuse the token |
| `background_uipi_blocked` | Stop, ask the user | Find a bypass |
| Two failed attempts | Stop and report | Keep clicking |

## Maintenance

`cua-driver list-tools` and `cua-driver describe <tool>` are the authority for
this version. Re-read them after an upgrade; this file records 0.34.0.
