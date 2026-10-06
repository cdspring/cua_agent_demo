# Troubleshooting

Diagnose before retrying. Most failures are a wrong assumption about focus or
coordinates, and retrying the same action repeats the same mistake.

## The screenshot is black, blank, or stale

- **Blank or black**: the session may be locked, on a secure desktop, or the
  capture ran without an interactive desktop. Confirm with `computer_screen` —
  if it reports sensible monitors and cursor position, the desktop is fine and
  the capture is the problem.
- **Stale**: another window took focus after you captured. Re-capture before
  acting.
- **The window is missing from it**: it may be minimized (off-screen
  coordinates around `-32000`) or on another virtual desktop. `computer_screen`
  with `windows: true` reports minimized bounds, which is the tell.

## The click misses the target

Almost always coordinates:

1. Did you convert for `scale`? `screen_x = region.x + image_x / scale`.
2. Is `region.x`/`region.y` non-zero? A `-Foreground` capture of a maximized
   window starts at `-13`, so image `(100, 100)` is screen `(87, 87)`.
3. Are you clicking the centre? Aim inside the target, not on its border.
4. Did the layout move between capture and click? Re-capture.

To confirm the coordinate mapping without guessing, call
`computer_act action=move` to a known point, then `computer_screen` — the
cursor position it reports must equal what you asked for.

## Text went to the wrong window

The action succeeded but the keystrokes landed elsewhere, which means focus
moved between capture and action. This is the most damaging failure mode,
because it can type into the wrong document.

1. Add `expect: "<title>"` to every typing action. It converts this from silent
   corruption into a clean abort.
2. Add `focus: "<title>"` so the window is activated and verified first.
3. If `focus` itself reports failure, the window title changed. Re-read titles
   with `computer_screen windows: true` — unsaved documents gain a `*`.

## Focus will not stick

- Windows blocks focus changes from background processes. The script works
  around this with `AttachThreadInput`, but an app with an always-on-top window
  or a modal system dialog can still block it.
- A `focus` result with `verified: false` means the foreground is still
  something else. Screenshot to see what is covering the target.
- A modal dialog steals focus legitimately. Deal with the dialog first.

## Typing is dropped or garbled

- Raise `delayMs` to 40–60 for Electron, Java, or remote-desktop apps.
- Some apps ignore synthetic input from `SendInput` entirely. Games with
  anti-cheat, and some secure fields, will not accept it.
- Verify the caret is actually in the target field before typing. A field can
  look focused while the window is inactive.

## Unicode input does not appear

Text goes through `KEYEVENTF_UNICODE`, which bypasses the active keyboard
layout — that is what makes CJK work. If characters are missing:

- Confirm the field accepts Unicode at all (some numeric and code fields reject
  it).
- Type a short ASCII probe first to separate "field is not focused" from "the
  characters are being rejected".

## Actions report failure

`Action failed` means nothing changed. The message names the cause: a missing
window, an out-of-range index, an unknown key name, or an `expect` mismatch.
Read it rather than retrying the identical call.

## The screen is much larger than expected

High-DPI displays report a virtual desktop in physical pixels (2880x1620 on a
1440x810 logical display). All coordinates here are in those physical pixels,
which is what the screenshot shows, so no conversion is needed — but do not
assume the numbers match the monitor's labelled resolution.
