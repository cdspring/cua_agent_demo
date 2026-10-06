# Recipes

Each recipe is the observe -> act -> verify loop written out. Read the step that
matches your task.

## Open an application and use it

```
computer_act  action=key  key="win"                                  # open Start
computer_act  action=type  text="notepad"  focus=… expect=…          # search
computer_act  action=key   key="enter"
computer_screen                                                   # confirm which window opened
```

Prefer launching through shell when the app has a console entry point
(`shell`: `notepad notes.txt`) — it is deterministic, does not depend on the
Start menu, and does not risk typing into the wrong window.

## Interact with a file open dialog

File dialogs are a common source of data loss: the wrong path silently
overwrites the wrong file.

```
computer_screen windows=true                 # learn the exact dialog title
computer_act   action=focus…                 # bring it forward first
computer_screenshot foreground=true          # see the current folder and filename field
computer_act   action=click  x=… y=…         # click the filename box
computer_act   action=key   key="ctrl+a"     # select existing text, do not append blindly
computer_act   action=type  text="C:\path\to\file.txt"
computer_screenshot                          # VERIFY the full path before submitting
```

Only then send `enter`. Read the path back out of the screenshot. If the user
did not name the target file, ask before saving over anything that exists.

## Fill a form

```
computer_screenshot foreground=true        # find the first empty field
computer_act action=click x=… y=…           # focus it
computer_act action=type text="value" focus="…" expect="…"
computer_screenshot                          # confirm it landed in the right field
```

Repeat per field. **Never** batch several fields into one blind sequence: fields
shift as content reflows, and a `tab` chain that started one row off writes real
data into the wrong place.

## Scroll to find something

```
computer_act   action=scroll amount=5       # positive is down
computer_screenshot                         # see what is now visible
```

Scroll, look, scroll. Do not scroll a fixed large amount and assume.

## Drag and drop

```
computer_act action=move  x=… y=…
computer_screenshot                        # confirm hover state / drag ghost
computer_act action=drag  x=… y=…  x2=… y2=…  durationMs=800
computer_screenshot                        # confirm it landed
```

Use a long `durationMs` (500–1000). Fast drags get cancelled by many apps. If a
drag fails, check the screenshot for a drop-target highlight before retrying.

## Dismiss a dialog you did not expect

A dialog mid-task usually means the app wants a decision. Look at it, decide,
then act — do not press `escape` reflexively, since `escape` can discard a form
you were partway through filling.

## Text entry that fails

If `type` reports success but nothing appears:

1. `computer_screen` to see the actual foreground window — focus probably moved.
2. `computer_screenshot` to see whether a field is focused and showing a caret.
3. Retry with `focus` **and** `expect` set, and a higher `delayMs` (50) if the
   app drops characters.

## Keyboard navigation beats clicking

When a dialog supports it, `tab` / `shift+tab` / `enter` / `alt+mnemonic` are
more reliable than clicking a specific pixel, because they survive window
resizes and DPI differences. Prefer them whenever the mnemonic is visible.
