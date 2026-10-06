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
    references/decision-table.json                the same logic, machine-readable
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

Set `mcp.cua.enabled` to `true` in `opencode.jsonc` and restart OpenCode.

Permission action names are **verified, not guessed**. OpenCode builds them as
`<server>_<tool>`, and the sanitiser in the v2.0.22 CLI is:

```js
Kr = (e) => e.name.replace(/[^a-zA-Z0-9_-]/g, "_")
```

The trailing hyphen is a literal, not a range operator, so hyphens survive:
`cua-driver` + `get_window_state` → **`cua-driver_get_window_state`**.
Re-derive after a CLI upgrade:

```powershell
powershell -File scripts/resolve-mcp-permission-action.ps1
```

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
| L2 | Observation | `list_windows` (free) → `get_window_state` |
| L3 | Addressing | **AX → PX → page → foreground** |
| L4 | Delivery | background, escalate only on refusal |
| L5 | Verification | only `effect: confirmed` is success |
| L6 | Risk | permissions, irreversible, secrets, integrity |

L3 order matters: `page` sits **above** `px`, so a pixel failure in a browser
escalates to the DOM, not to foreground.

L5 is the layer that makes this trustworthy. A delivered event is not an
applied change — Electron and web content can echo a write they never applied,
so the driver reports `unverifiable` rather than `confirmed`. Treat the other
four outcomes (`unverifiable`, `suspected_noop`, `partial`, `refused`) as
"observe again".

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

## References

- Qwen-CUA: Native Computer Use for (almost) Everything — arXiv:2608.02352
- trycua/cua — cua-driver, `docs/action-support.md` is the authority for proven behaviour
- Anthropic, best practices for computer and browser use — cache-aware batched pruning
