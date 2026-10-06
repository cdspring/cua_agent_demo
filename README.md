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

### Phase 5 — closing the gaps

Four findings from this round, three of which corrected something I had asserted
earlier without measuring it.

#### The policy file was never decorative. It was misconfigured.

I previously told the user `config/cua-policy.yaml` was read by nothing. **That
was wrong.** `CUA_DRIVER_POLICY_FILE` and `CUA_DRIVER_MANAGED_POLICY_FILE` are
both present in the driver binary, and setting the variable made the driver
**refuse to start**: `Policy loading error: user policy: failed to parse YAML
policy`. A working control, disabled by a schema bug on our side.

`scripts/bisect-policy-schema.mjs` starts the driver against 25 candidate files
and reports which initialise. The schema, measured:

| Construct | Result |
|---|---|
| `max_length`, `min`, `max`, `pattern`, `allowed` | **accepted** |
| `maxLength` | **rejected** — not in the operator vocabulary, despite being the more idiomatic spelling |
| `required` | **rejected — does not exist** |
| any unknown operator | rejected |
| unknown argument name, unknown tool name | **accepted**, then binds to nothing |

So the constraint model is `constraints: {<argumentName>: {<operator>: <value>}}`
where the outer key is unvalidated and the inner key is strictly validated. Our
file failed on `required: true`, the rule that asked "click must name a target".
That rule is simply not expressible.

**And the rule that actually matters is the opposite of the intuitive
arrangement.** `allow.tools` grants a tool **unconditionally and overrides
`allow.rules`**:

| Configuration | 600 chars into Notepad |
|---|---|
| `type_text` in `allow.tools` only | **written**, `max_length: 500` ignored |
| `type_text` in `allow.rules` only | **refused** — `argument constraints were not satisfied` |
| `type_text` in **both** | **written** — the rule is silently ignored |

Listing a tool in both, which is what the original file did, disables every
constraint written for it, with no warning. `config/cua-policy.yaml` is rewritten
so every constrained tool appears only under `rules`.

The policy is **not wired into any runtime**. The global config runs `standard`
with no policy variable, by explicit decision. Note that activating it is a
*tightening*: it is deny-by-default for tools.

#### Foreground activation: the Windows foreground lock, and it is not recoverable here

Phase 4 reported `GetForegroundWindow() == 0x0` and concluded the desktop had no
foreground window. That was one transient state, not the cause.

| Measurement | Result |
|---|---|
| window station / thread desktop / INPUT desktop | `WinSta0` / `Default` / `Default` — **all correct and identical** |
| session | 4, the console session |
| attached display | `DISPLAY1` 1440x810, present |
| foreground over 6 samples | `0x4066E`, `Chrome_WidgetWin_1`, the user's Edge window — **stable** |
| `SetForegroundWindow` on 21 other windows | **refused for all 21** (`ret=False`) |
| `bring_to_front` (`AttachThreadInput`) | `Windows kept foreground on hwnd 0x20818` |

The foreground window exists and moves normally. The constraint is the **Windows
foreground lock**: a process that does not own the current foreground window, and
was not started by it, cannot take focus — and `AttachThreadInput` does not defeat
it here either.

The documented remedy is `bin/cua-driver-uia.exe`, a `uiAccess="true"` binary
that is present and validly signed (`CN="Cua AI, Inc."`, status Valid). But it
**exits with code 1 for every invocation**, and the running daemon is the
non-UIA `cua-driver.exe` (pid 19188, started by the `cua-driver-serve`
scheduled task at `RunLevel=Highest`, which is admin, not UIAccess).

So the pixel rung stays unusable for tree-less apps on this host. **That is a
host limitation to record, not a defect to route around.**

#### The driver already refuses to kill foreign processes

`kill_app` on a window opened by an earlier, now-exited MCP child returned
`foreign_process_termination_denied` — enforced even in `standard` mode, and the
same guard as the manifest's `terminate: driver_launched`.

Worth recording plainly: **the original Notepad incident could not have happened
through this path.** It went through PowerShell's `Stop-Process -Force`, which
bypassed the driver entirely. The driver-side guard was there; the mistake was
reaching around it.

#### New in the harness

- `scripts/lib/cua-client.mjs` — the spawn/JSON-RPC/call boilerplate that was
  duplicated across eight scripts, plus `fresh()`/`freshUntil()` for one-shot
  tokens, `tally()` with `ok`/`refused` helpers that match on codes instead of
  prose, `feasibility()`, and `safeKill()`.
- `scripts/probe-feasibility.mjs` — one call answers "can this app be driven"
  for every window on the desktop. It took three rounds of hand-built probes to
  establish that answer; this is now a single call.
- `scripts/cleanup-scratch.mjs` — demonstrates `safeKill()` refusing an
  untracked window.
- SKILL.md gained a **Step 0 feasibility gate** before look/locate/act/verify,
  and a "never terminate an app you did not launch" section.

### Phase 6 — actually mounting it into OpenCode

Everything above was a working system that **was not loaded**. Five phases of
hand-built wiring, and the skill the whole project exists to teach was invisible
to the model the entire time.


#### M1 — the skill was never loaded

`/api/skill` lists every skill the running server has actually loaded. On this
machine it returned eleven entries and `computer-use` was not among them. Three
assumptions were wrong, all of them mine:

| Assumption | Reality |
|---|---|
| the project `opencode.jsonc` is the config | `/api/config` reports **one** document: `~/.config/opencode/opencode.jsonc`. The project's copy is read by nobody. |
| skills live beside the config | they live in **`~/.agents/skills/`**. `~/.config/opencode/skills` does not exist. |
| the skill is loaded because it is on disk | a file on disk is not a loaded skill. |

A skill file in the repo directory, with the server rooted at the home directory,
is inert. It looked completely installed.

#### M2–M3 — installation is now a command

`scripts/lib/opencode-paths.mjs` probes all of the above rather than assuming it,
and `scripts/install.mjs` performs the install. It is idempotent and prints what
it changed. Current state: **5/5, and `/api/skill` reports `computer-use` loaded
from `C:\Users\spring\.agents\skills\computer-use\SKILL.md`.**

Four things it deliberately refuses to do, each for a reason that cost something:

- **upgrade cua-driver** — a silent upgrade is what moved the Calculator to a new
  owning executable and broke the closed-loop test;
- **switch permission mode** — standard vs bounded is a trust decision;
- **splice the MCP entry** — it is hand-edited jsonc with other entries in it, and
  a bad splice is worse than a missing one; it prints the block to paste;
- **rewrite manifest paths** — they carry hand-written warnings that a generator
  would erase.

#### M4 — the dead backend no longer looks alive

`.opencode/plugins/computer-use.ts` used to register `computer_act`, a general
mouse-and-keyboard tool that typed into whatever held focus. It is **removed**.
The plugin now exposes only `computer_capture` and `computer_diagnose`, which
cannot act, under names that say so at a glance. The action-only flag plumbing was
removed with it — leaving `Button`, `ClickCount`, `Focus` and `Text` in a
read-only tool would be a thin disguise.

#### M5 — drift is now detected instead of discovered

`scripts/doctor-project.mjs`. Everything in this project was true when written and
silently stopped being true:

- a Windows update made the Calculator undrivable with no error anywhere;
- manifest paths carry version-stamped WindowsApps paths that break on update;
- **one manifest entry pointed at a path that never existed, justified by
  reasoning that was also wrong** — I claimed `msedgewebview2.exe` was needed
  because "Chromium's renderer and GPU children are separate processes". They are
  not; renderer children are `msedge.exe`. `msedgewebview2.exe` is the WebView2
  embedding runtime, and the path was `…\EdgeWebView\Application\154.0.4258.53\`.
  The doctor found the dead path; the false reasoning is now recorded next to it
  so it is not repeated;
- the skill was invisible.

Current doctor output: one genuine problem, correctly reported — three apps
expose no accessibility tree and the pixel fallback is blocked.

The doctor also produced a false positive on its first run, by matching the word
`required:` inside the comment explaining that `required` does not exist. It now
strips comments before checking. A checker that cries wolf is worse than none.

#### M6 — one of the two unproven paths is now proven

`set_value` — **proven.** `Set AXValue on [0] (UIA ValuePattern)`, and the
document read back as `"set_value wrote this"` with the seed gone, so it replaces
rather than appends.

`invoke_menu` — **still unproven, and now for a known reason.** It is reachable:
under bounded it returned `permission_denied` (absent from the manifest's
`allow.tools`), and under standard it returns a correct structured
`menu_path_unavailable: menu path segment 0 was not found`. The problem is that
**no application on this machine exposes an application menu bar.** charmap has
one `MenuItem` labelled `系统`, which is the window's *system* menu; regedit
exposes 1 element. Menu labels are also localised, so English paths never resolve.
Modern Windows has retired the classic menu-bar apps and the survivors are XAML.

#### M7 — an explicit do-not-call list

The driver advertises 59 tools. SKILL.md now names the ones that are never a task
action, with the reason for each: `kill_app`, the recording and history tools,
`install_extension`, `parse_visual_regions`, `revoke`, `bring_to_front`,
`browser_download`, and the page-mutation routes. This expresses the boundary in
the skill rather than by narrowing the tool surface, which keeps the `standard`
mode decision intact.

#### Two windows left open, and they are mine

| Window | Why it is still open |
|---|---|
| `注册表编辑器` (regedit, pid 27428) | opened to look for a menu bar; `kill_app` returned `foreign_process_termination_denied` |
| `字符映射` (charmap, pid 22100) | opened for `invoke_menu`; same |

Neither was open before this work. Both need closing by hand. `kill_app` refuses
because the launching MCP child has exited — which is the same guard that would
have prevented the original Notepad incident.


### Phase 7 — the framework itself

Every phase so far verified one thing. Nobody could ask "is this healthy?" in one
command, and thirty-two scripts had grown with no index.

#### `verify-all.mjs` — one entry point

```
node scripts/verify-all.mjs             the active suites
node scripts/verify-all.mjs --record    plus the historical ones
node scripts/verify-all.mjs --list      the index
node scripts/verify-all.mjs --only a,b  named suites
```

Current state: **7 active suites pass, exit 0.** Scripts are classified in
`lib/suites.mjs` into three kinds:

- **active** — gates. Expected to pass.
- **record** — documentation. Expected to report a limitation, and **never
  gates**, because reporting a durable finding as FAIL invites someone to "fix"
  it into a bug.
- **diagnostic** — one-shot investigations, kept because re-deriving a conclusion
  costs a session. Run by hand.

#### Four defects the entry point found immediately

**1. `verify-coords.mjs` was classified active but cannot run.** It resolves its
target by window title and only knows Calculator, which no longer exists — it
exits `no calculator`. Reclassified as record.

**2. `verify-input.mjs` failed 1 check in 2, then 2 checks in 1.** Not flaky
hardware: two of its assertions were wrong.

- `set_value reports confirmed` required `effect === "confirmed"`. That route
  returns `effect: "unverifiable"` — a documented value meaning delivery could
  not self-prove the write — and the write lands regardless. The test was
  asserting the provider's *phrasing*.
- `type_text leaves the cursor put` used `get_cursor_position`, which is
  **session-scoped to the agent cursor overlay**. The driver documents that "a
  pure accessibility (AX) action snaps the cursor with a brief pulse on its first
  action", so it moves *by design* — and whether the pulse had finished between
  two reads is a race. That was the 5/6-then-4/6. It now reads the real OS cursor
  from outside the driver.

Same lesson as everywhere else in this project: **assert the outcome, not the
action fact.**

**3. `verify-mcp.mjs` listed `wait` among the tools that should exist.** There is
no `wait` tool in 0.34.0; `routing.md` and `SKILL.md` both say so explicitly. My
checker disagreed with my own documentation. Removed.

**4. A test failed because a target was not running.** `verify-phase4.mjs`
reported four failures for Obsidian and WeChat that were simply absent. A browser
test must not fail when no browser is open. Added a **SKIP** state, distinct from
both pass and fail, so "not applicable" is not silently a regression.

#### The skill's own path ambiguity

The installed skill references `scripts/probe-feasibility.mjs`. In the repo that
file is under `scripts/`, not under `.opencode/skills/computer-use/scripts/`; the
installer copies it in. SKILL.md now states the installed layout explicitly and
says why the repo path looks wrong.

#### Known finding, deliberately left visible

`actions-on-calculator` reports `D3 real cursor unmoved by foreground click:
1433,1095 -> 1999,1574`. **Foreground delivery moved the real pointer**, which is
consistent with it being an explicit foreground escalation rather than a
background action. It is printed as a finding, not suppressed and not declared

### Phase 4 — real tasks

`scripts/verify-phase4.mjs` runs four tasks under `bounded`, asserting each
postcondition from a fresh observation rather than trusting action feedback.

| Task | Result |
|---|---|
| Calculator: 7 × 6 = | **PASS** on the old build; **not drivable** on the new one — see below |
| Notepad: mixed CJK + ASCII | **PASS** — `type_text` twice, both `effect: confirmed`, document read back as `phase4 seed / ASCII-123 中文输入 OK` |
| Browser DOM route | **PASS** — `scripts/probe-browser-dom.mjs`, real page content read over CDP |
| Obsidian / WeChat addressability | Obsidian **PASS** (125 elements, 108 named); WeChat **PASS** (minimized, tree degraded to 1 element) |

No input was sent to Obsidian or WeChat, by design: they hold the user's notes
and messages.

#### The finding that matters most

**This agent can only drive an app that exposes an accessibility tree or a DOM.
For an app with neither, there is no working rung in this deployment.**

A Windows update replaced the Calculator with a self-hosted
`CalculatorApp.exe` that exposes **zero** accessibility elements — at
`max_depth` 12, 25 and 40, in both `standard` and `bounded` mode
(`scripts/probe-calculator.mjs` is the control). The driver says so itself:

```
degraded=true  reason="ax_tree_empty: the UIA walk returned no actionable
elements ... switch to the visual path."
```

The visual path then fails twice over:

- **background pixel click** → `tool_invocation_failed` carrying the text
  `操作成功完成(0x00000000)`, i.e. Win32 `S_OK` — and **the display did not
  change**. Pressing `C` did not clear it. That `S_OK` is the return of the
  `PostMessage`, not of the click. Reading it as success is exactly the mistake
  the driver's WORKFLOW.md warns about, and it is invisible without re-observing.
- **foreground escalation** → `foreground_unavailable: Windows did not activate
  exact target HWND 0x5065e (actual foreground HWND 0x0)`. `bring_to_front`,
  which uses `AttachThreadInput` to defeat the foreground lock, fails the same
  way. Root cause checked three ways: window station `WinSta0`, desktop
  `Default`, session 4 (console) — all correct — while `GetForegroundWindow()`
  returns `0x0`. The desktop has no foreground window, so `SetForegroundWindow`
  cannot succeed.

So `background_unavailable` → foreground escalation, previously listed as
unproven, is now known to be **unreachable on this machine**. A capability the
driver exposes in principle can be unavailable in a given environment, and only a
measurement tells the two apart.

#### Three more findings from this round

- **A capture-bound pixel click is validated in the *screenshot's* pixel space,
  not window-local.** With `max_image_dimension: 900`, an 828×1064 window is
  downscaled to ~700×900 and window-local `(718,1002)` is refused as
  `capture_coordinate_invalid`. Pass `max_image_dimension: 0` for native pixels,
  or scale by `window_bounds / screenshot_width,height`. There are three
  coordinate spaces, not two.
- **The browser DOM route is two stages.** `browser_prepare` prepares an endpoint;
  `get_browser_state(pid, window_id)` is what mints `target_id` and `tab_id`.
  Expecting an id from the prepare response is the natural first mistake.
  Attaching to the user's running profile is refused with
  `browser_requires_setup`, and that refusal names its own remedy —
  `allow_launch: true` with `profile: {mode: "isolated_new"}`, which touches
  neither the real profile nor its cookies.
- **Calculator's keypad is 6 rows × 4 columns of 200px buttons, digits starting
  at row 2**; rows 0 and 1 are functions (percent, CE, C, backspace, reciprocal,
  square, root, divide). An earlier revision assumed row 0 held the digits,
  pressed percent then divide, and reported 9. Locating keys by geometry rather
  than label is what made this reliable — the labels are localised and arrive
  mojibake'd through a Windows console. `=` is required; without it the
  calculator shows the running expression and reads as a click that did nothing.
- **Minimized windows keep their permission but lose their tree.** WeChat
  minimized exposed 1 element against 8 when visible. Do not read a small element
  count on a minimized window as a permission problem.
- **Two harness bugs that looked like driver bugs.** Notepad text appeared to
  triple: the harness matched a stale window by a loose title pattern and appended
  to a previous buffer. It also "reset" state by rewriting a file on disk while
  Notepad kept its buffer. A third: an action order written as an object literal
  was reordered at runtime, because `Object.entries` hoists integer-like keys
  (`"6"`, `"7"`) ahead of string keys — it pressed 6, 7, C, ×, =. All three are
  recorded in the scripts so the next person does not re-diagnose them.

Encoding note: CJK literals in the verification scripts are written as `\u`
escapes. PowerShell's `Set-Content -Encoding UTF8` corrupted an embedded
`计算器` mid-token once, producing an unterminated regex.

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
