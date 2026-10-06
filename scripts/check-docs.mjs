// Validate the machine-readable routing table and scan the docs for stale claims.
import { readFileSync } from "node:fs"

const d = JSON.parse(readFileSync(".opencode/skills/computer-use/references/decision-table.json", "utf8"))
const keys = (o) => Object.keys(o).filter((k) => k !== "$comment").join(", ")
console.log("decision-table: valid JSON")
console.log("  effects :", keys(d.effects))
console.log("  routes  :", keys(d.routes))
console.log("  refusals:", keys(d.refusals))
console.log("  deprecated:", keys(d.deprecated))
console.log("  noWait  :", JSON.stringify(d.noWaitTool.alternatives))
console.log("  coordSpaces:", keys(d.coordinateSpaces))

// The 0.34.0 tool list, as verified by verify-mcp.mjs. Anything routing.md
// tells the model to call must exist.
const REAL_TOOLS = new Set([
  "bring_to_front", "check_for_update", "check_permissions", "click", "clipboard_read", "clipboard_write",
  "debug_window_info", "double_click", "drag", "end_session", "get_accessibility_tree", "get_browser_state",
  "get_config", "get_cursor_position", "get_desktop_state", "get_screen_size", "get_session", "get_window_state",
  "health_report", "hotkey", "install_extension", "install_ffmpeg", "invoke_menu", "kill_app", "launch_app",
  "list_apps", "list_sessions", "list_windows", "move_cursor", "press_key", "right_click", "scroll",
  "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_theme", "set_config", "set_value",
  "set_window_frame", "start_recording", "start_session", "stop_recording", "type_text", "verify_state", "zoom",
  "browser_click", "browser_dialog", "browser_download", "browser_navigate", "browser_pointer", "browser_prepare",
  "browser_set_input_files", "browser_type", "get_browser_state", "parse_visual_regions", "replay_trajectory",
  "history_status", "history_query", "history_enable", "history_disable", "history_pause", "history_resume",
  "history_status", "history_flush", "history_list", "history_show", "history_delete",
])

const docs = [
  ".opencode/skills/computer-use/SKILL.md",
  ".opencode/skills/computer-use/references/routing.md",
]
const mentioned = new Set()
for (const f of docs) {
  const text = readFileSync(f, "utf8")
  for (const m of text.matchAll(/`([a-z_]{4,})`/g)) mentioned.add(m[1])
}
const UNRELATED = new Set([
  "background", "foreground", "captured", "confirmed", "unverifiable", "suspected_noop", "partial", "refused",
  "delivered", "routable", "verifiable", "screenshot", "coordinates", "background_unavailable",
  "background_occluded", "background_uipi_blocked", "stale_element_token", "capture_coordinate_invalid",
  "screenshot_context_missing", "bounded_resource_outside_manifest", "authorization_required",
  "route_unavailable", "delivery_failed", "effect_unconfirmed", "permission_required", "unknown_reason",
  "untrusted_source", "satisfied", "unsatisfied", "unknown", "accessibility", "synthetic_events", "global_input",
  "dom", "trusted_input", "invalidated_snapshot_ids", "structuredContent", "sleep", "delay_ms", "timeout_ms",
  "amount", "pid", "window_id", "scope", "capture_id", "element_token", "element_token", "frame", "region",
  "max_elements", "max_depth", "max_image_dimension", "include_screenshot", "include_accessibility_tree",
  "capture_mode", "query", "x", "y", "label_contains", "text", "session", "codemode", "os", "value", "label",
  "role", "index", "frame", "true", "false", "null", "token", "name", "actions", "tool", "tools", "shell",
  "question", "browser", "browser_prepare", "z_index", "minimized", "bounds", "title", "app_name",
])
const suspects = [...mentioned].filter((m) => !REAL_TOOLS.has(m) && !UNRELATED.has(m) && /^[a-z][a-z0-9_]*$/.test(m))
console.log("\nbackticked identifiers in docs that are neither real tools nor known noise:")
console.log(suspects.length ? suspects.map((s) => `  ${s}`).join("\n") : "  (none)")
