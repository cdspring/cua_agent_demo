# cua_agent_demo

Windows computer-use agent for OpenCode: a skill that teaches the routing
decisions, a plugin that exposes a dependency-free fallback backend, and
configuration for the production backend.

Nothing here is trained. It runs on a general-purpose vision model.

## The idea

Qwen-CUA ([arXiv:2608.02352](https://arxiv.org/abs/2608.02352)) reaches 86.2
on OSWorld-Verified with a 397B-A17B model, 100k vCPUs and 40k verifiable
tasks. In the same table, GPT-5.5 scores 78.7 and Claude Opus 4.8 scores 83.4 —
**neither was trained for computer use.** Scaling Qwen-CUA past a trillion
parameters buys 1.4 more points.

So the interface is the capability, not the weights. That is what this
repository implements.

## Layout

```
opencode.jsonc                                    config + verified permission action names
config/
  cua-bounded.yaml                                capability manifest for bounded mode
  cua-policy.yaml                                 agent-layer argument policy
.opencode/
  plugins/computer-use.ts                         fallback backend: 3 tools
  skills/computer-use/
    SKILL.md                                      the procedure
    references/routing.md                        seven layers, ladders, host capability tables
    references/decision-table.json               routing, effects and refusals, tabulated
                                               (reference only; nothing reads it at runtime)
    references/recipes.md                         worked task flows
    references/troubleshooting.md                 failure modes
    scripts/cu.ps1                                Win32 actions: SendInput, BitBlt
scripts/resolve-mcp-permission-action.ps1         derives MCP action names from the CLI
```

## Two backends

| | `cua-driver` (preferred) | `cu.ps1` (this repo) |
|---|---|---|
| Moves the real mouse | No — agent cursor overlay, excluded from capture | Yes |
| Self-verifying | `effect` + accessibility read-back | Reports only "sent" |
| Addressing | `element_token`, pixels, DOM | Pixels only |
| Target binding | one-use `capture_id` | "Whatever is focused" |
| Platforms | Windows, macOS, Linux | Windows only |
| Dependency | installed binary | none |

**Use `cu.ps1` for observation and diagnosis only, once `cua-driver` is
available.** Its input actions land on the focused window with no target
binding, which is how this project typed into a YouTube tab during
development. That failure is why the guard parameters exist, and why the
fallback is not for input.

## Setup

### Phase 1 — install and verify, outside OpenCode

```powershell
irm https://cua.ai/driver/install.ps1 | iex
cua-driver doctor
```

Verify before wiring it in. The two checks that matter most:

```powershell
# does it see the desktop?
cua-driver call get_desktop_state

# does an element-level click work without stealing focus?
cua-driver call list_windows
#   -> pick a pid/window_id, then
cua-driver call get_window_state --pid <pid> --window_id <id>
#   -> click a button by element_token, then confirm effect=confirmed
#      and that the foreground window and cursor position did not change
```

If `doctor` reports a session or permission problem, stop. On Windows the
daemon must run in the interactive session; Session 0 cannot see the desktop.

### Phase 2 — enable in OpenCode

In `opencode.jsonc`, change `mcp.servers.cua.disabled` to `false` and restart
OpenCode. Two details are deliberate:

- **Servers nest under `mcp.servers`.** V2 does not accept a server name
  directly under `mcp`.
- **`codemode: false`** keeps these tools on the provider's native tool list.
  The default is `true`, which routes them through Code Mode as
  `tools.<server>.<tool>` and makes the permission action name ambiguous.

Permission action names are **verified, not guessed**. OpenCode names an MCP
tool `<server>_<tool>`, replacing characters other than letters, numbers, `_`
and `-` with `_`. The sanitiser in the v2.0.22 CLI is:

```js
Kr = (e) => e.name.replace(/[^a-zA-Z0-9_-]/g, "_")
```

The trailing hyphen is a literal member of the set, not a range operator, so
hyphens survive: `cua-driver` + `get_window_state` →
**`cua-driver_get_window_state`**. Re-derive after a CLI upgrade:

```powershell
powershell -File scripts/resolve-mcp-permission-action.ps1
```

### Do not install the official agent skill pack

`cua-driver skills install` links a second skill (`@cua/driver`) that teaches
the same routing. Two skills giving conflicting instructions is worse than one.
This skill is the single source of truth here; the driver's platform details can
still be read directly from its docs.

### Phase 3 — narrow the permissions

`standard` mode allows input to **any** application with no prompt. Once the
setup is stable, move to `bounded`:

```powershell
$env:CUA_DRIVER_PERMISSION_MODE = "bounded"
$env:CUA_DRIVER_CAPABILITY_MANIFEST_FILE = "$PWD\config\cua-bounded.yaml"
$env:CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED = "1"
```

Test three cases before leaving it unattended: an in-scope call succeeds
silently; the same tool against another app returns
`bounded_resource_outside_manifest`; an unlisted tool returns
`permission_denied`.

Add the argument policy for a second layer:

```powershell
$env:CUA_DRIVER_POLICY_FILE = "$PWD\config\cua-policy.yaml"
```

The manifest decides which apps and files are reachable. The policy decides
which arguments are acceptable. Neither prompts the user — for that, use
`permissions` in `opencode.jsonc`.

Set these as `environment` entries under `mcp.servers.cua` in `opencode.jsonc`,
or export them before launching OpenCode. Use absolute paths for the manifest.

### Phase 4 — validate on real tasks

| # | Task | What it proves |
|---|---|---|
| 1 | Calculator: compute 6×7, read back 42 | closed loop with verification |
| 2 | Notepad: type mixed CJK and ASCII, save to a path | element routing, file dialog |
| 3 | Change a setting in a WinUI3 app | real WinUI3 coverage |
| 4 | Complete a DOM-only browser action | that it takes the `page` rung, not pixels |

Pass criteria: no manual rescue, no keystroke in the wrong window, task 4
resolves via `page`.

## Routing

Seven layers. Read `references/routing.md` before the first action.

| | Layer | Choice |
|---|---|---|
| L0 | Better interface? | shell, then browser (CDP), then GUI |
| L1 | Backend | `cua-driver`; `cu.ps1` capture-only |
| L2 | Observation | `list_windows` (free) → window-scoped capture |

Observation is window-scoped by default in both backends. A whole-desktop
capture is available but costs several times more image tokens and includes
unrelated windows, so it is opt-in.
| L3 | Addressing | **AX → PX → page → foreground** |
| L4 | Delivery | background, escalate only on refusal |
| L5 | Verification | `confirmed` is not the task outcome; check the postcondition |
| L6 | Risk | permissions, irreversible, secrets, integrity |

L3 order matters: `page` sits **above** `px`, so a pixel failure in a browser
escalates to the DOM, not to foreground.

L5 is the layer that makes this trustworthy. **Action facts are not task
outcomes** — `effect: confirmed` means only that readable state exists, and the
task postcondition still needs separate checking. Treat `unverifiable`,
`suspected_noop`, `partial` and `refused` as *unknown*, not *failed*, and
confirm by re-observing. Use `verify_state` for expressible postconditions; its
`unknown` result is not success. Never replay a cancelled or unknown action
automatically: an interrupted transport may already have delivered it.

## Known limits

Windows, from the driver's own `docs/action-support.md`:

- **Electron cannot take background typing.** `type_text`, `press_key`,
  `hotkey` and `scroll` all return `background_unavailable`. Expect foreground.
- WinUI3 right and double click are unproven in background.
- A lower-integrity process cannot inject into an elevated app
  (`background_uipi_blocked`). Refuse; do not look for a bypass.
- `element_token` is one-use and expires after 5 idle minutes. `stale_element_token`
  means re-observe, not that the element route is broken.

Do not install the optional `cua-perception` extension: it bundles an
AGPL-3.0-only OmniParser artifact, and network distribution would trigger
source obligations.

## Verification

Run on this machine against cua-driver 0.34.0.

| Check | Result |
|---|---|
| `doctor` | all green: interactive session 3, UIA available, 13 windows |
| MCP handshake over stdio | protocolVersion 2025-06-18, 59 tools, clean exit on stdin EOF |
| Registered in OpenCode | `{"name":"cua","status":"connected"}` |
| Element-level AX click | `route: accessibility`, state changed, **real cursor unmoved, z-index unchanged** |
| Pixel click + `capture_id` | dispatches with window-local coordinates, same result |
| `type_text` on a real edit field | **`effect: confirmed`**, document changed, cursor unmoved, window not raised |
| `press_key` | dispatches via `synthetic_events`, `effect: unverifiable` |
| `launch_app` hidden | launched without stealing focus |

Not yet proven: the `set_value` success path, `background_unavailable` →
foreground escalation (needs an Electron host), `bounded` mode, `invoke_menu`.

### Facts the official docs do not state

- Element `frame` is **desktop** pixels; a pixel action carrying `capture_id`
  must use **window-local** pixels (`local = frame - window_bounds.origin`).
  Passing the desktop value is refused with `capture_coordinate_invalid`.
- `capture_id` is optional; omitting it routes through `synthetic_events`.
- There is **no `wait` tool** in 0.34.0.
- `click` needs `pid` even when `element_token` is supplied, despite the schema.
- Every one-shot `cua-driver call` gets a **disposable session**, so
  `element_token` and `capture_id` do not cross the process boundary. Pass one
  `session` label across a multi-step interaction; a long-lived MCP connection
  is unaffected.
- **Action facts are not task outcomes.** On WinUI3 Calculator both a button AX
  click and a pixel click returned `unverifiable` while demonstrably changing
  state, so `unverifiable` means *unknown*, not *failed*.
- Control labels are localised: Calculator's keypad is `一 二 三 …`.

**Windows caveat that bit twice:** PowerShell 5.1 strips quotes from
multi-field positional JSON argv, so `cua-driver call` must be driven from Node
or PowerShell 7+. Every script under `scripts/` is Node for that reason.

### bounded mode

Verified 21/21 by `scripts/verify-bounded.mjs`, which runs bounded over MCP with
the manifest and approval environment variables — the same path OpenCode uses —
so the standard-mode daemon is untouched.

| Check | Result |
|---|---|
| `bounded` with no manifest | refused at startup, does not degrade to standard |
| `bounded` with manifest but no approval | refused at startup |
| `list_windows`, `get_screen_size` | allowed |
| Listed app (`charmap.exe`) | addressable, 15 elements |
| Unlisted app (`SystemSettings.exe`, `explorer.exe`) | `bounded_resource_outside_manifest` |
| Tool not in `allow.tools` (4 tested) | `permission_denied` |

Three findings that are not in the driver's docs:

- **`desktop.display` must be `true` on Windows.** With `false`, `list_windows`,
  `list_apps`, `get_accessibility_tree`, `click` and `type_text` are all refused
  as *"desktop display observation is outside the capability manifest"*. The
  agent cannot learn a pid, so the manifest deadlocks. The flag means "may the
  agent see the desktop at all", not "may it screenshot the display".
- **The two refusal codes identify different layers.** `permission_denied` means
  the tool *name* is absent from `allow.tools`; `bounded_resource_outside_manifest`
  means the tool is allowed but the *resource* is out of scope. They live in
  `structuredContent`, not in `content[].text`.
- **App scope matches the executable that owns the window, not the one
  launched.** Calculator's window is owned by `ApplicationFrameHost.exe`, so
  listing `calc.exe` will not authorise it. Check `list_windows`' `app_name`
  before writing an app entry.

`config/cua-bounded.yaml` carries all three as comments, because they are easy
to get wrong and each one produces a refusal that looks like a different
problem.

### Scripts

| Script | Purpose |
|---|---|
| `verify-mcp.mjs` | MCP handshake, tool inventory, checks routing.md names only real tools |
| `verify-bounded.mjs` | 21 checks over bounded mode, including fail-closed startup |
| `verify-phase2.mjs` | Element click with cursor/focus side-effect assertions |
| `verify-input.mjs` | `type_text` / `set_value` / `press_key` against a real edit field |
| `verify-coords.mjs` | Desktop vs window-local coordinate conversion |
| `verify-actions.mjs` | `capture_id`, foreground delivery, restoration |
| `probe-bounded-matrix.mjs` | Which tools survive a given manifest shape |
| `probe-app-owners.mjs` | Prints the real owning executable per window |
| `check-docs.mjs` | Validates the decision table; flags stale tool names in the docs |
| `read-cua-docs.mjs` | Downloads the driver's own MCP resources for cross-checking |

The driver publishes its own documentation as MCP resources —
`skill://cua-driver/WINDOWS.md`, `WORKFLOW.md`, `SKILL.md`, `VISUAL.md` and
seven more. Prefer them over this repository when the two disagree.

## References

- Qwen-CUA: Native Computer Use for (almost) Everything — arXiv:2608.02352
- trycua/cua — cua-driver, `docs/action-support.md` is the authority for proven behaviour
- Anthropic, best practices for computer and browser use — cache-aware batched pruning
