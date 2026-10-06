---
name: Computer Use
description: Drive the Windows desktop — inspect application controls, take screenshots, click, type, scroll and drag. Use when a task needs a GUI app (native dialogs, installers, settings panes, Explorer, legacy desktop software) that shell and browser tools cannot reach, when the user asks to "open", "click", "type into", or "check on screen", or when current desktop state must be seen.
---

# Computer use

You can inspect application controls and control the mouse and keyboard. Use it
for GUI work that `shell` and the `browser_*` tools cannot reach.

## Read this before your first action

`references/routing.md` is the decision procedure. Read it, then act. It
covers seven layers and, most importantly, **when to escalate** — background
first, foreground only after a real refusal.

`references/decision-table.json` tabulates the same routing for this version.

## Backends

| Backend | Tools | Status |
|---|---|---|
| `cua-driver` 0.34.0 (MCP) | `get_window_state`, `get_accessibility_tree`, `get_desktop_state`, `get_screen_size`, `click`, `double_click`, `right_click`, `type_text`, `set_value`, `press_key`, `hotkey`, `scroll`, `drag`, `move_cursor`, `bring_to_front`, `verify_state`, `zoom` | Preferred. Self-verifying, does not move the real mouse, addresses controls by token. |
| `cu.ps1` (this repo) | `computer_screenshot`, `computer_screen`, `computer_act` | Fallback. **Capture and diagnosis only.** |

`cua-driver` binds every action to a specific window and a one-use
`capture_id`, and reads state back to tell you whether the action applied.
`cu.ps1` acts on whatever window is focused — that limitation is exactly how
this project typed into the wrong application once.

**Never use `computer_act` for typing, keys, or clicks when `cua-driver` is
available.** Use `computer_screenshot` and `computer_screen` for cheap
observation.

## The loop

### Step 0: check feasibility, before anything else

**Not every app can be driven. Ask before you act, not after.**

Call `get_window_state` on the target and read `element_count` and
`degraded_reason`. Measured on this machine:

| App | Elements | Drivable |
|---|---|---|
| Notepad, Obsidian, WeChat, Edge, Chrome | 20-568 | **yes**, via the accessibility tree |
| `CalculatorApp.exe`, `SystemSettings.exe` | **0** | **no** |

A zero-element app is not drivable. The driver says so itself:
`ax_tree_empty: the UIA walk returned no actionable elements ... switch to the
visual path`. And on this machine the visual path is a dead end:

- a background pixel click returns `tool_invocation_failed` carrying the text
  `operation completed successfully (0x00000000)` - Win32 `S_OK` - and **nothing
  changes on screen**. That `S_OK` is the `PostMessage`'s own return, not the
  click's effect.
- foreground delivery returns `foreground_unavailable: Windows did not activate
  exact target HWND (actual foreground HWND ...)`, because the Windows foreground
  lock refuses activation from a process that does not own the current foreground
  window. The desktop, window station and session are all correct; the lock is
  the constraint. See README Phase 4 for the full root cause.

**If the tree is empty, say the app cannot be driven and stop.** Do not click into
a void, and never report a Win32 `S_OK` as a successful click.

For a browser an empty tree is not the end; check the DOM route
(`browser_prepare`, then `get_browser_state`). CDP needs no foreground window.

`scripts/probe-feasibility.mjs` runs this check for every window on the desktop.

### The four steps

**Look, locate, act, verify.** The last step is not optional.

**Look → locate → act → verify.** The last step is not optional.

1. **Look.** `get_accessibility_tree` or `list_windows` for discovery — cheap,
   no screenshot. Then `get_window_state`, which returns the control tree and a
   screenshot **together**.
2. **Locate.** Prefer an `element_token` from `structuredContent.elements`. Read
   coordinates out of the screenshot only when no element matches, and pass the
   observation's `capture_id` with them.
3. **Act.** One action per call, `delivery_mode` left at `background`.
4. **Verify.** Read `effect`, then check the task postcondition separately.
   **Action facts are not task outcomes** — even `confirmed` only means the
   action has readable state. `unverifiable` means delivery could not prove
   effect: observe again, because the app may have echoed a write it never
   applied. For an expressible postcondition use `verify_state`; its `unknown`
   result is not success.

Never replay a cancelled, partial or unknown action automatically — an
interrupted transport may already have delivered it. Take fresh state first.
For text specifically, a stale read-back means the provider may publish after
the call returns, so an immediate retry can type the text twice.

After two failed attempts on one target, stop and report. You are misreading
the state.

## Never terminate an app you did not launch

This project destroyed the user's unsaved Notepad tabs by force-killing it to
obtain a test fixture (commit `0ce0665`).

**Never `kill_app` a host application to get a fixture, to "reset" one, or to
clear a window.** Use a scratch file in a temp directory, launch your own
instance, and close only that. `scripts/lib/cua-client.mjs` exports `safeKill()`,
which refuses unless the window is one the harness launched **and** its title
matches the expected scratch pattern.

The manifest's `terminate: driver_launched` exists for exactly this reason.

## Delivery: background is mandatory first

> The driver is explicit: `background` is the mandatory first attempt. Do NOT
> pass `foreground` preemptively because a target "looks like" GTK, Chromium or
> Electron. The driver decides when background is impossible and returns
> `background_unavailable`. Only then re-issue that same action as foreground.

`background` never raises the window, moves the real pointer, or changes the
frontmost app. Fronting up-front steals the user's focus for nothing.

## Targeting

Every action names its target: `element_token`, or `x,y` plus `capture_id`,
plus `pid` and `window_id`, or `scope: "desktop"` for screen coordinates.
`click` needs `pid` even when `element_token` is present.

**`element_token` values are one-shot.** Take one `get_window_state` per turn
per `(pid, window_id)`; the next snapshot of that window supersedes them and
lists the old ids in `invalidated_snapshot_ids`. On `stale_element_token`,
re-observe — the element route is fine, the token is old.

For multi-step work, pass one `session` label on every call. Unnamed calls use
an implicit transport session; a 5-minute idle timeout retires it and
invalidates its tokens.

### Two coordinate spaces

`element.frame` is **desktop** pixels. A pixel action carrying `capture_id` must
use **window-local** pixels: `local = frame - window_bounds.origin`. Passing the
desktop value gets `capture_coordinate_invalid`. `capture_id` is optional;
omitting it routes through `synthetic_events`.

There is **no `wait` tool**. Pause with `shell`'s `sleep`, or use `delay_ms` on
`type_text` and `timeout_ms` on `get_window_state`.

## Coordinates

Pixel coordinates are **window-local screenshot pixels** for a window target,
or screen coordinates for `scope: "desktop"`. All fallback-backend coordinates
are virtual-desktop space, where the origin is the top-left of the
leftmost/topmost monitor so `x` and `y` can be negative; a maximised window's
capture origin is typically `-13`.

The `cu.ps1` fallback may downscale and reports `scale` plus the region origin:

```
screen_x = region.x + (image_x / scale)
screen_y = region.y + (image_y / scale)
```

Aim at the centre of a target, never its edge.

## Judgement

- **Prefer the interface built for the job.** `shell`, `browser_*`, and
  `set_value` beat the mouse. Reach for a GUI action only when there is no API,
  CLI, or DOM to drive.
- **Confirm before the irreversible.** Sending, submitting, paying, deleting,
  overwriting, or anything leaving the machine needs `question` first.
- **Never type secrets.** If a password field appears, ask the user to type it.
- **Refuse rather than bypass.** An elevated target returns
  `background_uipi_blocked`. Ask the user; do not hunt for a way around it.
- **Keyboard over mouse** when both work.

## Deprecated — do not call

`escalate_session`, `page`, and `get_session_state` are deprecated in 0.34.0.
The `capture_mode` parameter on `get_window_state` is deprecated **and
ignored**; the modality is chosen at action time by whether you pass an
`element_token` or `x,y`.

## The driver's own docs are available

It serves 11 documents as MCP resources — `skill://cua-driver/WINDOWS.md`,
`WORKFLOW.md`, `SKILL.md`, `VISUAL.md`, `BROWSER.md` and more. Read them before
disagreeing with this skill, and prefer them when the two conflict. They are
resources, not a competing installed skill, so they do not create the
instruction conflict `cua-driver skills install` would.

This skill stays the single source of *routing* decisions; the driver's
documents are the source of *platform* detail.

## Cost

Screenshots dominate context. Prefer `get_accessibility_tree` over a capture
when you only need to identify a window. Bound `get_window_state` with
`max_elements`, `max_depth`, and `query`; use `include_screenshot: false` to
re-index cheaply. Both backends capture the **active window** by default — ask
for a full-desktop capture only when the target spans displays.

## More

- `references/routing.md` — seven layers, ladders, per-host capability tables, deprecations
- `references/decision-table.json` — routing, effects, refusals and gates, tabulated
- `references/recipes.md` — worked flows: opening apps, file dialogs, form filling
- `references/troubleshooting.md` — blank captures, missed clicks, focus, wrong-window input
