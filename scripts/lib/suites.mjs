// What every script in this repository is FOR, and when it is still expected to
// pass.
//
// Thirty-two scripts accumulated across six phases with no index, so "is this
// healthy?" meant knowing six filenames, and scripts that test against the
// Calculator looked broken rather than historical.
//
// Three classes:
//
//   active    run by verify-all.mjs. Expected to pass on a healthy machine.
//   record    documents a finding that is still true. Expected to FAIL or to
//             report a known limitation, because the thing it demonstrates no
//             longer holds on this host. Never "fix" these to make them pass.
//   diagnostic one-shot investigations, kept because re-deriving a conclusion
//             costs a session. Run by hand when the question comes up again.
//
// The Calculator class is the important one. A Windows update replaced it with a
// self-hosted build that exposes ZERO accessibility elements, so every script
// that drove it can no longer pass. Their finding ("this app is undrivable") is
// the durable result; their assertions are not.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
export const SCRIPT_DIR = join(HERE, "..")

export const SUITES = [
  // ---------------------------------------------------------------- active
  {
    name: "mcp-handshake",
    script: "verify-mcp.mjs",
    class: "active",
    why: "the Phase 2 question: can OpenCode connect and list tools at all",
  },
  {
    name: "bounded-mode",
    script: "verify-bounded.mjs",
    class: "active",
    why: "scoping works: listed apps allowed, unlisted refused, no deadlock",
  },
  {
    name: "coordinate-spaces",
    script: "verify-coords.mjs",
    class: "record",
    why: "confirms the three coordinate spaces. It resolves its target by window TITLE and only knows Calculator, which is undriveable and now absent, so it exits with 'no calculator'",
    expectPartial: true,
  },
  {
    name: "input-routes",
    script: "verify-input.mjs",
    class: "active",
    why: "type_text / set_value / press_key against a real text field",
  },
  {
    name: "unproven-closure",
    script: "verify-unproven.mjs",
    class: "active",
    why: "set_value proven; invoke_menu reachable but no app exposes a menu bar",
    // invoke_menu cannot pass on this host. Recorded so the failure is a known
    // quantity rather than a regression to be chased.
    expectFailing: ["invoke_menu reaches a real menu bar on a classic Win32 app"],
  },
  {
    name: "feasibility-gate",
    script: "probe-feasibility.mjs",
    class: "active",
    why: "answers can-this-app-be-driven for every window in one call",
  },
  {
    name: "browser-dom",
    script: "probe-browser-dom.mjs",
    class: "active",
    why: "the DOM rung end to end, on a driver-owned throwaway profile",
    // browser_screenshot is refused: no reviewed risk classification in this
    // runtime. A permission decision, not a malfunction.
    expectFailing: ["screenshot over the page route"],
  },
  {
    name: "docs-consistency",
    script: "check-docs.mjs",
    class: "active",
    why: "routing docs only name real tools",
  },

  // ---------------------------------------------------------------- record
  {
    name: "real-task-phase4",
    script: "verify-phase4.mjs",
    class: "record",
    why: "Calculator, Notepad, browser, user-data apps under bounded. The Calculator leg no longer passes; the other three do",
    expectPartial: true,
  },
  {
    name: "calculator-undrivable",
    script: "probe-calculator.mjs",
    class: "record",
    why: "proves CalculatorApp.exe exposes no accessibility tree in either mode. Must keep reporting 0 elements",
    expectPartial: true,
  },
  {
    name: "pixel-rung-dead",
    script: "probe-foreground-escalation.mjs",
    class: "record",
    why: "proves background pixels silently no-op and foreground escalation is blocked by the Windows foreground lock",
    expectPartial: true,
  },
  {
    name: "uia-worker-unusable",
    script: "probe-uia-worker.mjs",
    class: "record",
    why: "the documented remedy for foreground, cua-driver-uia.exe, exits 1 on every invocation",
    expectPartial: true,
  },
  {
    name: "pixel-task",
    script: "verify-phase4-pixel.mjs",
    class: "record",
    why: "the pixel-rung attempt against Calculator. Its value is the capture_id screenshot-space rule, not a pass",
    expectPartial: true,
  },
  {
    name: "actions-on-calculator",
    script: "verify-actions.mjs",
    class: "record",
    why: "drove Calculator for Phase 2 actions. Undriveable since the update, so it cannot pass now",
    expectPartial: true,
  },

  // ------------------------------------------------------------ diagnostic
  { name: "policy-schema", script: "bisect-policy-schema.mjs", class: "diagnostic", why: "which YAML shapes 0.34.0 accepts; run if the policy stops starting" },
  { name: "policy-enforcement", script: "probe-policy-enforcement.mjs", class: "diagnostic", why: "does the policy gate tools at all" },
  { name: "policy-arguments", script: "probe-policy-arguments.mjs", class: "diagnostic", why: "are argument constraints actually enforced" },
  { name: "policy-matrix", script: "probe-policy-matrix.mjs", class: "diagnostic", why: "allow.tools overrides allow.rules; measured four ways" },
  { name: "app-owners", script: "probe-app-owners.mjs", class: "diagnostic", why: "which executable owns each window. Run before editing the manifest" },
  { name: "existing-profile-grant", script: "probe-existing-profile-grant.mjs", class: "diagnostic", why: "whether --grant existing-profile does anything. Measured: it does not" },
  { name: "xhs-accessibility", script: "probe-xiaohongshu.mjs", class: "diagnostic", why: "what the accessibility rung yields on a Chromium SPA. Footer and 12 unattributed numbers" },
  { name: "xhs-settle", script: "probe-xiaohongshu-settle.mjs", class: "diagnostic", why: "whether Chromium UIA just needed to settle. It did not: 210 elements, stable" },
  { name: "bounded-matrix", script: "probe-bounded-matrix.mjs", class: "diagnostic", why: "which observation tools survive desktop.display: false" },
  { name: "ax-effect", script: "verify-ax-effect.mjs", class: "diagnostic", why: "does an AX click change application state" },
  { name: "listed-app", script: "probe-listed-app.mjs", class: "diagnostic", why: "is a manifest-listed launched app addressable" },
  { name: "driver-docs", script: "read-cua-docs.mjs", class: "diagnostic", why: "cross-check local docs against the driver's own MCP resources" },
  { name: "window-state-shape", script: "inspect-window-state.mjs", class: "diagnostic", why: "the shape of one get_window_state response" },
]

export const byClass = (c) => SUITES.filter((s) => s.class === c)