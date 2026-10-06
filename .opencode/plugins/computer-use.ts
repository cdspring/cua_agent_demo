import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"

/**
 * Computer-use tool layer.
 *
 * This plugin only *executes*. The judgement — when to look, how to find a
 * target, when a click is safe, whether the result matches the goal — lives in
 * the `computer-use` skill, which teaches the model to drive these tools as a
 * closed observe -> act -> verify loop.
 *
 * All Win32 work is delegated to scripts/cu.ps1, which wraps SendInput and
 * BitBlt. PowerShell is the only thing on a stock Windows box that reaches
 * user32.dll without a compiler, and it keeps the native interop in one
 * auditable file instead of spread across this plugin.
 *
 * Screenshots come back as Tool.FileContent so the image reaches the model
 * directly; the JSON metadata rides alongside as text so the model keeps the
 * coordinate mapping it needs to act on what it just saw.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, "../skills/computer-use/scripts/cu.ps1")
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT]

type Args = Record<string, unknown>

type RunResult = {
  code: number
  stdout: string
  stderr: string
  json: any
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined
  return String(v)
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

function bool(v: unknown): boolean {
  return v === true || v === "true"
}

/** Spawn cu.ps1 and collect its single JSON line. Never rejects. */
function runScript(flags: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn("powershell.exe", [...PS, ...flags], { windowsHide: true })
    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (code: number) => {
      if (settled) return
      settled = true
      let json: any
      try {
        json = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "")
      } catch {
        json = undefined
      }
      done({ code, stdout, stderr, json })
    }

    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => {
      stderr += String(err)
      finish(127)
    })
    child.on("close", (code) => finish(code ?? 0))
    signal?.addEventListener("abort", () => {
      child.kill()
      finish(130)
    })
  })
}

/** Map tool input onto cu.ps1 parameters. Undefined values are omitted. */
function toFlags(action: string, input: Args): string[] {
  const flags: string[] = ["-Action", action]
  const add = (name: string, value: string | number | undefined) => {
    if (value === undefined) return
    flags.push(`-${name}`, String(value))
  }

  const region = input.region as
    | { x: number; y: number; width: number; height: number }
    | undefined

  if (region) {
    // cu.ps1 takes an explicit rectangle as start (x,y) and end (x2,y2).
    add("X", num(region.x))
    add("Y", num(region.y))
    add("X2", num(region.x + region.width))
    add("Y2", num(region.y + region.height))
  } else {
    add("X", num(input.x))
    add("Y", num(input.y))
    add("X2", num(input.x2))
    add("Y2", num(input.y2))
  }

  add("Button", str(input.button))
  add("ClickCount", num(input.clickCount))
  add("Amount", num(input.amount))
  add("Axis", str(input.axis))
  add("DurationMs", num(input.durationMs))
  add("DelayMs", num(input.delayMs))
  add("SettleMs", num(input.settleMs))
  add("Text", str(input.text))
  add("Key", str(input.key))
  add("Title", str(input.title))
  add("Index", num(input.index))
  add("Focus", str(input.focus))
  // Maps to -MustBeFront: PowerShell 5.1 silently drops a script parameter
  // named "Expect" when run via -File.
  add("MustBeFront", str(input.expect))
  add("Format", str(input.format))
  add("MaxWidth", num(input.maxWidth))
  add("Quality", num(input.quality))
  add("Windows", num(input.windowLimit))

  if (bool(input.foreground)) flags.push("-Foreground")
  return flags
}

/**
 * A failed action must not look like a successful one that changed nothing;
 * that ambiguity is what makes an agent retry blindly. Failures are returned as
 * explicit text stating that nothing changed.
 */
function toContent(result: RunResult, opts: { screenshot?: boolean } = {}) {
  const { json, stderr, code } = result
  const body: any[] = []

  if (opts.screenshot && json?.ok && json?.path && existsSync(json.path)) {
    body.push({
      type: "file" as const,
      uri: `file:///${String(json.path).replace(/\\/g, "/")}`,
      mime: str(json.mime) ?? "image/png",
      name: String(json.path).split(/[\\/]/).pop(),
    })
  }

  if (!json?.ok) {
    const reason = json?.error ?? stderr.trim() ?? `exit code ${code}`
    body.push({
      type: "text" as const,
      text:
        `Action failed: ${reason}\n` +
        `Nothing was changed. Look again with computer_screenshot or computer_screen before retrying.`,
    })
    return body
  }

  body.push({ type: "text" as const, text: JSON.stringify(json, null, 2) })
  return body
}

/** Map the model's action verb onto a cu.ps1 action plus any extra parameters. */
function resolveAction(requested: string): { action: string; extra: (a: Args) => string[] } {
  switch (requested) {
    case "double_click":
      return { action: "click", extra: () => ["-ClickCount", "2"] }
    case "right_click":
      return { action: "click", extra: () => ["-Button", "right"] }
    case "middle_click":
      return { action: "click", extra: () => ["-Button", "middle"] }
    default:
      return { action: requested, extra: () => [] }
  }
}

const COORDINATE_NOTE =
  "Coordinates are Windows virtual-desktop space: the origin is the top-left of the " +
  "leftmost/topmost monitor, so x and y may be negative. Convert pixels in a returned " +
  "image to screen coordinates by dividing by `scale` and adding the region origin."

export default Plugin.define({
  id: "computer-use.tools",
  async setup(ctx) {
    if (!existsSync(SCRIPT)) {
      console.error(`[computer-use] action script missing at ${SCRIPT}; tools disabled`)
      return
    }

    const maxWidth = Number(ctx.options.maxWidth ?? 1280)

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "computer",
        description: "Drive the Windows desktop: capture the screen, control the mouse and keyboard.",
      })

      editor.add({
        name: "screenshot",
        description:
          "Capture the screen and return it as an image. This is the first step of every " +
          "interaction: look before you act. Use it again after acting to check the result. " +
          "Pass `foreground: true` when you already know which app you are working in. " +
          COORDINATE_NOTE,
        input: {
          type: "object",
          properties: {
            region: {
              type: "object",
              description: "Capture only this rectangle, in virtual-desktop coordinates.",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
              required: ["x", "y", "width", "height"],
              additionalProperties: false,
            },
            foreground: {
              type: "boolean",
              description: "Capture only the active window. Cheaper and clearer when the target app is known.",
            },
            maxWidth: {
              type: "number",
              description: `Downscale to this width in pixels. Default ${maxWidth}. Smaller costs far fewer tokens.`,
            },
            format: { type: "string", enum: ["png", "jpeg"] },
            quality: { type: "number", description: "JPEG quality 1-100. Ignored for png." },
          },
          additionalProperties: false,
        },
        options: { namespace: "computer" },
        execute: async (input, context) => {
          const args = input as Args
          const format = str(args.format) ?? "jpeg"
          const flags = toFlags("screenshot", {
            ...args,
            maxWidth: args.maxWidth ?? maxWidth,
            format,
            quality: args.quality ?? 78,
          })
          const result = await runScript(flags, context.signal)
          return { content: toContent(result, { screenshot: true }) as any }
        },
      })

      editor.add({
        name: "screen",
        description:
          "Read desktop state as text with no image cost: monitors, virtual screen bounds, " +
          "cursor position, the active window, or the list of open windows. Use it to learn the " +
          "coordinate space and to find a window by the exact title you will pass to `focus`. " +
          COORDINATE_NOTE,
        input: {
          type: "object",
          properties: {
            windows: {
              type: "boolean",
              description: "List visible top-level windows in z-order instead of just the desktop state.",
            },
            windowLimit: { type: "number", description: "How many windows to report. Default 30." },
          },
          additionalProperties: false,
        },
        options: { namespace: "computer" },
        execute: async (input, context) => {
          const args = input as Args
          const action = bool(args.windows) ? "windows" : "info"
          const result = await runScript(toFlags(action, args), context.signal)
          return { content: toContent(result) as any }
        },
      })

      editor.add({
        name: "act",
        description:
          "Perform one mouse or keyboard action. Follow a computer_screenshot with this, then " +
          "verify with another screenshot; never fire several actions blind. Pass `focus` to " +
          "activate a window by title before acting, and `expect` to abort unless that window is " +
          "in front. Always pass both when the action types text or submits something. " +
          COORDINATE_NOTE,
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "click",
                "double_click",
                "right_click",
                "middle_click",
                "move",
                "drag",
                "scroll",
                "type",
                "key",
                "wait",
              ],
              description:
                "click/move/scroll accept x and y. drag needs x,y then x2,y2. scroll takes amount, " +
                "positive is down. type needs text. key needs key, such as 'enter', 'escape' or 'ctrl+s'.",
            },
            x: { type: "number" },
            y: { type: "number" },
            x2: { type: "number" },
            y2: { type: "number" },
            button: { type: "string", enum: ["left", "right", "middle"] },
            clickCount: { type: "number", description: "1-5, where 2 is a double click." },
            amount: { type: "number", description: "Scroll wheel ticks. Positive scrolls down." },
            axis: { type: "string", enum: ["vertical", "horizontal"] },
            durationMs: { type: "number", description: "Drag duration. Longer is more reliable for drop targets." },
            delayMs: { type: "number", description: "Delay between keystrokes. Raise it for slow apps." },
            settleMs: { type: "number", description: "Hold time between mouse button down and up." },
            text: { type: "string", description: "Text for `type`. Unicode, including CJK, is supported." },
            key: { type: "string", description: "Key or combo for `key`: 'enter', 'escape', 'ctrl+s', 'alt+tab'." },
            waitMs: { type: "number", description: "For `wait`: milliseconds to pause, for UI to settle." },
            focus: {
              type: "string",
              description: "Activate the window whose title contains this first. Verified, not assumed.",
            },
            expect: {
              type: "string",
              description: "Abort unless the foreground title contains this. Stops text reaching the wrong app.",
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "computer" },
        execute: async (input, context) => {
          const args = input as Args
          const { action, extra } = resolveAction(str(args.action) ?? "click")
          const flags = toFlags(action, args)
          if (action === "wait") flags.push("-DurationMs", String(num(args.waitMs) ?? 500))
          flags.push(...extra(args))
          const result = await runScript(flags, context.signal)
          return { content: toContent(result) as any }
        },
      })
    })
  },
})
