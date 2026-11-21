/**
 * grok adapter — xAI Grok Build CLI. Verified against `grok --help`
 * (Grok 0.2.93): the non-interactive one-shot form is `grok -p/--single
 * "<prompt>"`, with the answer on stdout in the default (text) output format.
 * Auth: XAI_API_KEY (or GROK_API_KEY / GROK_DEPLOYMENT_KEY) in the environment
 * (never handled here — the JobStore passes process.env through).
 *
 * Always emits `--always-approve` so the agent can act headlessly, which means
 * it may modify the tree it is dispatched into. Whether that is safe right now
 * — and whether two jobs may share one tree — is the CALLER's decision, not
 * this adapter's. No `danger-full-access`/full-access knob is ever emitted.
 *
 * Model selection: `opts.model` (e.g. "grok-4.5") is passed through as
 * `-m <model>`. Omitting it keeps the CLI's default model
 * (grok-4.20-*-non-reasoning today). Available ids come from `grok models`.
 */
import type { AdapterResult, DispatchOpts, ModelInfo } from "../types.ts";
import { DEFAULT_KIND } from "./types.ts";
import type { Capability, ModelsProbe, MultiAdapterModule } from "./types.ts";
import { injectReviewContract, parseReviewResult } from "../lib/review-contract.ts";
import { resolveOptionalAddDir, resolveReadOnly } from "../lib/path-barricade.ts";
import {
  appendSavePath,
  injectImageContract,
  markerFor,
  parseImageResult,
  resolveImageOutputPath,
} from "../lib/image-contract.ts";

export const name = "grok";
export const supportsReadOnly = true;

function buildGrokArgv(prompt: string, opts: DispatchOpts, allowReadOnly: boolean): string[] {
  const readOnly = resolveReadOnly(name, opts, allowReadOnly);
  const addDir = resolveOptionalAddDir(name, opts);
  // All flags precede `-p` so the prompt stays the LAST argv element (a flag
  // placed after the prompt is absorbed as prompt text).
  const argv = readOnly ? ["grok", "--permission-mode", "plan"] : ["grok", "--always-approve"];
  const { model } = opts;
  if (model !== undefined) {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError(`grok: opts.model must be a non-empty string if provided, got ${typeof model}`);
    }
    argv.push("-m", model);
  }
  if (addDir !== undefined) argv.push("--add-dir", addDir);
  argv.push("-p", prompt);
  return argv;
}

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  return buildGrokArgv(prompt, opts, true);
}

/**
 * NOT wired, deliberately: `opts.effort`.
 *
 * grok 0.2.93 does expose `--reasoning-effort` (alias `--effort`), so this
 * looks like an easy passthrough. It is not: grok does NOT validate the value.
 * Measured — `grok --reasoning-effort definitely-not-valid -p "x"` is accepted
 * and the turn runs anyway. Forwarding a value grok may silently ignore would
 * make the opt LOOK honored while changing nothing, which is worse than not
 * forwarding it. Wire this only once grok's accepted value set is actually
 * known, not inferred from the flag's existence.
 */

export const injectContract = injectReviewContract;

export function parseResult(stdout: string, _stderr: string, exitCode: number): AdapterResult {
  return parseReviewResult(name, stdout, exitCode);
}

/**
 * Image generation — grok's second kind.
 *
 * VERIFIED, not assumed (2026-07-21, grok 0.2.93). grok ships an `imagine`
 * SKILL (`~/.grok/skills/imagine/SKILL.md`, loaded in this repo per
 * `grok inspect`) documenting two compiled built-in tools, `image_gen` and
 * `image_edit`. Like codex's `imagegen`, none of that is visible to
 * `grok --help` — skills and built-in tools are not the flag surface.
 *
 * The open question when this was first surveyed was WHERE grok writes images,
 * since no path literal exists in the binary. Measured end-to-end, that turned
 * out not to matter: told an absolute destination in the prompt, headless
 * `grok --always-approve -p` wrote a real 1024x1024 PNG to exactly that path
 * and echoed the marker line back. The shared image contract names the path
 * and then stats the file, so a harness default location is irrelevant.
 */
const IMAGE_MARKER = "GROK_IMAGE_SAVED";
const IMAGE_MARKER_RE = markerFor(IMAGE_MARKER);

/**
 * Live model-catalog probe via `grok models`. Verified against grok 1.0.77.
 */
export const readModels: ModelsProbe = {
  transport: "cli-stdout",
  binary: "grok",
  args: ["models"],
};

/**
 * Parse `grok models` stdout (`* <id> (default)` and `- <id>` lines).
 * Tolerant: skips headers and blank lines.
 */
export function parseModels(raw: unknown): ModelInfo[] {
  if (typeof raw !== "string") return [];
  const out: ModelInfo[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*([*-])\s+([a-z0-9][a-z0-9._/-]*)(?:\s+\(([^)]+)\))?\s*$/i.exec(line);
    if (!match) continue;
    const isDefault = match[1] === "*" || match[3]?.toLowerCase() === "default";
    out.push({ id: match[2]!, ...(isDefault ? { isDefault: true } : {}) });
  }
  return out;
}

function buildImageArgs(prompt: string, opts: DispatchOpts): string[] {
  const outPath = resolveImageOutputPath(name, opts);
  // Reuse the shared argv assembly; readOnly is rejected because image
  // generation must write the PNG.
  return buildGrokArgv(appendSavePath(prompt, outPath), opts, false);
}

export const capabilities: Record<string, Capability> = {
  [DEFAULT_KIND]: { buildArgs, injectContract, parseResult },
  image: {
    buildArgs: buildImageArgs,
    injectContract: (prompt: string) => injectImageContract(prompt, IMAGE_MARKER),
    parseResult: (stdout: string, _stderr: string, exitCode: number) =>
      parseImageResult(name, IMAGE_MARKER_RE, stdout, exitCode),
  },
};

/** Review / second opinion is what `grok` means with no `kind`. */
export const defaultKind = DEFAULT_KIND;

const _check: MultiAdapterModule = {
  name,
  capabilities,
  defaultKind,
  supportsReadOnly,
  readModels,
  parseModels,
};
void _check;
