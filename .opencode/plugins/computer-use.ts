import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"

/**
 * Legacy capture backend. READ-ONLY BY CONSTRUCTION.
 *
 * This plugin used to register `computer_act`, a general mouse-and-keyboard tool
 * backed by SendInput. It is deliberately gone.
 *
 * Why remove it rather than deprecate it:
 *
 *   1. `cua-driver` supersedes it. `act` typed into whatever window held focus,
 *      with no target binding and no read-back. That is exactly how this project
 *      typed into a browser tab it did not mean to touch. The driver binds every
 *      action to a window plus a one-use capture id and reports whether the write
 *      applied; this plugin cannot do either.
 *   2. A tool named `computer_act` reads as executable no matter what any
 *      document says. Leaving it registered while telling the model not to use it
 *      relies on the model cooperating with a comment. Removing it makes the
 *      capability absent instead of discouraged.
 *
 * What remains is genuinely useful and genuinely read-only: an out-of-band
 * screenshot and a text dump of desktop state. Both answer questions the driver's
 * MCP surface does not, namely "what does the whole screen look like" and "what
 * is the coordinate space", and neither can change anything.
 *
 * Names are `capture` and `diagnose` rather than `screenshot` and `screen` so that
 * a glance at the tool list is enough to tell they do not act.
 *
 * All Win32 work is delegated to scripts/cu.ps1. PowerShell is the only thing on
 * a stock Windows box that reaches user32.dll without a compiler.
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

/**
 * Map read-only input onto cu.ps1 parameters.
 *
 * Only the flags these two tools need are wired. The previous version carried the
 * full action surface — Button, ClickCount, Amount, Axis, DurationMs, Text, Key,
 * Focus, MustBeFront — which existed solely for `computer_act`. Leaving them here
 * would be a thin disguise: the flags would parse, just with nothing to drive
 * them.
 */
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

  add("Format", str(input.format))
  add("MaxWidth", num(input.maxWidth))
  add("Quality", num(input.quality))
  add("Windows", num(input.windowLimit))
  add("Title", str(input.title))
  if (bool(input.wholeDesktop)) flags.push("-WholeDesktop")
  return flags
}

/**
 * A failed capture must not look like a successful one that changed nothing.
 * These tools cannot change anything, so the wording says what is actually true:
 * the capture failed and no image exists.
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
      text: `Capture failed: ${reason}\nNo image was produced. Use cua-driver get_window_state for a per-window capture.`,
    })
    return body
  }

  body.push({ type: "text" as const, text: JSON.stringify(json, null, 2) })
  return body
}

const COORDINATE_NOTE =
  "Coordinates are Windows virtual-desktop space: the origin is the top-left of the " +
  "leftmost/topmost monitor, so x and y may be negative. Convert pixels in a returned " +
  "image to screen coordinates by dividing by `scale` and adding the region origin. " +
  "Note this differs from cua-driver's window-local screenshot pixels."

export default Plugin.define({
  id: "computer-use.legacy-capture",
  async setup(ctx) {
    if (!existsSync(SCRIPT)) {
      console.error(`[computer-use] legacy capture script missing at ${SCRIPT}; tools disabled`)
      return
    }

    const maxWidth = Number(ctx.options.maxWidth ?? 1280)

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "computer",
        description:
          "Read-only desktop inspection. These two tools cannot click, type, or change anything. " +
          "For any action, use the cua-driver MCP tools instead.",
      })

      editor.add({
        name: "capture",
        description:
          "Capture a region or the active window as an image. Read-only. Use it to see the whole " +
          "screen when you need context the driver's per-window capture omits, such as a dialog " +
          "that is not the target window. It cannot act. For a single window prefer cua-driver " +
          "get_window_state, which returns the control tree alongside the image. " +
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
            wholeDesktop: {
              type: "boolean",
              description:
                "Capture every display instead of the active window. Costs several times more " +
                "image tokens and includes unrelated windows, so ask for it only when the target " +
                "spans displays.",
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
          const result = await runScript(
            toFlags("screenshot", {
              ...args,
              maxWidth: args.maxWidth ?? maxWidth,
              format: str(args.format) ?? "jpeg",
              quality: args.quality ?? 78,
            }),
            context.signal,
          )
          return { content: toContent(result, { screenshot: true }) as any }
        },
      })

      editor.add({
        name: "diagnose",
        description:
          "Read desktop state as text with no image cost: monitors, virtual screen bounds, " +
          "cursor position, the active window, or the list of open windows. Read-only. Use it to " +
          "learn which coordinate space you are in before acting with cua-driver. " +
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
    })
  },
})