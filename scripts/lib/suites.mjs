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

  // ---------------------------------------------------------------- lifecycle
  // These were operating the project rather than verifying a claim about the
  // driver, so they had no entry and sat outside the index. check-convergence
  // reported them as drift, which is what prompted registering them: an
  // unlisted script still runs and still holds a finding, and nobody notices
  // when it rots.
  { name: "install", script: "install.mjs", class: "lifecycle", why: "idempotent installer into the detected global config and skills directory" },
  { name: "doctor", script: "doctor-project.mjs", class: "lifecycle", why: "drift detection: version, paths, policy schema, live per-app capability" },
  { name: "convergence", script: "check-convergence.mjs", class: "lifecycle", why: "how many MCP scripts still bypass the shared client, gating ones first" },
  { name: "cleanup-scratch", script: "cleanup-scratch.mjs", class: "lifecycle", why: "safeKill demo: refuses an untracked window, closes only our own fixtures" },
  { name: "cleanup-windows", script: "cleanup-windows.mjs", class: "lifecycle", why: "polite close for classic Win32 windows, orphan client sweep" },
  { name: "phase2-legacy", script: "verify-phase2.mjs", class: "diagnostic", why: "the original Phase 2 daemon checks; superseded by mcp-handshake and bounded-mode" },
  { name: "xhs-public-channel", script: "probe-xhs-public.mjs", class: "diagnostic", why: "measures whether the DOM rung carries content on a logged-out public SPA. Read-only, throwaway profile" },
  { name: "exemption-risk", script: "check-exemption-risk.mjs", class: "lifecycle", why: "asserts un-converged scripts still classify refusals by CODE, so an exemption cannot silently become a lie" },
]

/** Suites that gate. A false PASS here is the expensive failure. */
export const GATING = SUITES.filter((s) => s.class === "active")

export const byClass = (c) => SUITES.filter((s) => s.class === c)

/**
 * Scripts that deliberately do NOT use the shared MCP client.
 *
 * Convergence is not a virtue in itself. Putting the harness behind a script that
 * exists to test the harness would verify the abstraction instead of the thing
 * under test. These are exempt, each for a stated reason, so that
 * check-convergence.mjs reports an honest number rather than a flattering one.
 */
export const LOW_LEVEL_EXEMPT = {
  "verify-mcp.mjs":
    "This IS the handshake test. The harness's connect() performs initialize and " +
    "notifications/initialized; wrapping it here would verify the harness's handshake " +
    "rather than the raw protocol OpenCode will actually speak.",
  "bisect-policy-schema.mjs":
    "Measures whether the driver STARTS for a given policy file. Startup failure is " +
    "the signal, and it is observed on process exit and stderr, not through a live client.",
  "verify-phase2.mjs":
    "Shells out to `cua-driver call`, not MCP. No harness applies.",

  // -------------------------------------------------------------------------
  // AUDITED, NOT MIGRATED. These are gating suites, so migrating them was the
  // stated priority. The audit says migration buys them nothing:
  //
  //   verify-bounded   0 uses of element_token, 14 refusal comparisons against
  //                    codes, 0 prose matches
  //   probe-browser-dom 0 uses of element_token,  7 refusal comparisons against
  //                    codes, 0 prose matches
  //
  // The two bug classes the harness exists to prevent are one-use token reuse
  // (prevented by fresh()) and refusal matching on prose rather than codes
  // (prevented by call().refusals). Neither script has either. Their remaining
  // regexes match window app_name/title and the startup stdout line, not driver
  // responses.
  //
  // Rewriting two currently-PASSING gates to satisfy a convergence metric, with
  // no measured defect to fix, is the wrong trade: it risks a working gate for a
  // number. Exempt with the evidence recorded, so the next person re-audits
  // rather than either migrating blindly or trusting this note.
  "verify-bounded.mjs":
    "AUDITED 2026-10: 0 element_token uses and 0 prose refusal matches, so the two " +
    "defects fresh() and refusals{} prevent cannot occur here. 14 assertions already " +
    "compare structuredContent codes. Migrating a passing 21-check gate for a metric " +
    "would risk it for nothing. Re-audit if it ever starts acting on elements.",
  "probe-browser-dom.mjs":
    "AUDITED 2026-10: 0 element_token uses and 0 prose refusal matches; 7 assertions " +
    "already compare codes. Its one regex matches the URL under test, not a refusal. " +
    "Same reasoning as verify-bounded.",
}