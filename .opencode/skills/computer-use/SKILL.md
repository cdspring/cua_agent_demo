---
name: Computer Use
description: Drive the Windows desktop — take screenshots, click, type, scroll, drag, and inspect application controls. Use when a task needs a GUI app (native dialogs, installers, settings panes, Explorer, legacy desktop software) when shell and browser tools cannot reach it, when the user asks to "open", "click", "type into", or "check on screen", or when current desktop state must be seen.
---

# Computer use

You can see the screen, inspect application controls, and control the mouse and
keyboard. Use it for GUI work that `shell` and the `browser` tools cannot
reach.

## Read this before your first action

`references/routing.md` is the decision procedure. Read it, then act. It
defines seven layers and, most importantly, **which path to take when the
obvious one fails** — interface, then accessibility element, then pixel, then
page, then foreground. Skipping it is how ten turns get burned on a background
action an Electron app cannot accept.

`references/decision-table.json` is the same logic machine-readable: proven and
refused actions per Windows host, every `effect` and refusal code, and the
cost-control settings.

## Backends

| Backend | Tools | Status |
|---|---|---|
| `cua-driver` (MCP) | `get_window_state`, `list_windows`, `click`, `type_text`, `press_key`, `hotkey`, `scroll`, `drag`, `move_cursor`, `wait` | Preferred. Self-verifying, does not move the real mouse, addresses controls by token. |
| `cu.ps1` (this repo) | `computer_screenshot`, `computer_screen`, `computer_act` | Fallback. **Capture and diagnosis only.** |

`cua-driver` binds every action to a specific window and a one-use
`capture_id`, and reads state back to tell you whether the action actually
applied. `cu.ps1` acts on whatever window happens to be focused — that
limitation is exactly how this project once typed into the wrong application.

**Never use `computer_act` for `type_text`, `key`, or `click` when
`cua-driver` is available.** Use `computer_screenshot` and `computer_screen` for
cheap observation and diagnostics.

## The loop

**Look → locate → act → verify.** The last step is not optional. Acting without
re-reading state is how you double-click the wrong button, type into a search
field, or overwrite a file you meant to read.

1. **Look.** `list_windows` costs no image tokens — use it first to find the
   target's `pid` and `window_id`. Then `get_window_state` for its control tree
   and screenshot together.
2. **Locate.** Prefer an `element_token` from the tree over reading coordinates
   out of an image. Guess neither.
3. **Act.** One action per call. Choose the rung from `routing.md` L3.
4. **Verify.** Read `effect`. Only `confirmed` counts as success. `unverifiable`
   means the app may have echoed a write it never applied — observe again.
   `suspected_noop` means re-locate. `refused` means read the `code` and act on
   it, then follow `escalation.recommended` rather than improvising.

After two failed attempts on the same target, stop and report. You are
misreading the state, and clicking again makes it worse.

## Targeting

Every `cua-driver` action names its target explicitly — `{kind: "window", pid,
window_id}` or `{kind: "desktop", display_id: "primary"}`. Nothing is locked
to a session, and a malformed target fails before anything is sent.

`element_token` values are **one-use and expire**. A 5-minute idle timeout
retires the session and invalidates every token and snapshot from it. On
`stale_element_token`, re-observe. That is not a broken element route.

With the `cu.ps1` fallback, guards are mandatory on anything that types or
submits: `focus: "<title>"` activates the window and verifies it, and
`expect: "<title>"` aborts if it is not in front. Match a stable title fragment,
not a whole title copied once — unsaved documents gain a `*` prefix.

## Coordinates

All coordinates are **virtual desktop** space: the origin is the top-left of the
leftmost/topmost monitor, so `x` and `y` can be negative. A maximised window's
capture origin is typically `-13`, not `0`.

`cu.ps1` screenshots may be downscaled and report `scale` plus the region
origin:

```
screen_x = region.x + (image_x / scale)
screen_y = region.y + (image_y / scale)
```

A pixel-derived click must carry the same `capture_id` as the observation that
produced the coordinates. Aim at the centre of a target, never its edge.

## Judgement

- **Prefer the interface built for the job.** `shell`, `browser`, and `cu.ps1`
  internals beat the mouse. Reach for a GUI action when there is no API, CLI,
  or DOM to drive.
- **Confirm before the irreversible.** Sending, submitting, paying, deleting,
  overwriting, or anything that leaves the machine needs `question` first.
- **Never type secrets.** If a password field appears, ask the user to type it.
- **Refuse rather than bypass.** An elevated target returns
  `background_uipi_blocked`. Ask the user; do not hunt for a way around it.
- **Keyboard over mouse** when both work — shortcuts survive window resizes and
  DPI differences.

## Cost

Screenshots dominate context. Prefer `list_windows` over a capture when you only
need to identify a window. Bound `get_window_state` with `max_elements` and
`max_depth`, reuse `pid` and `window_id`, and batch text into one `type_text`.
On their Calculator example those changes cut uncached input from 71,088 to
12,251 tokens.

## More

- `references/routing.md` — the seven layers, ladders, and per-host capability tables
- `references/decision-table.json` — machine-readable routing, effects, refusals, gates
- `references/recipes.md` — worked flows: opening apps, file dialogs, form filling
- `references/troubleshooting.md` — blank captures, missed clicks, focus, wrong-window input
