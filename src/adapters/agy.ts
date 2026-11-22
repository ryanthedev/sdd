/**
 * agy adapter — general-purpose review/implement harness invoked as
 * `agy <flags...> --print <prompt>`.
 *
 * FLAG ORDER: `--print` takes the single argv element immediately following
 * it as the prompt, so `buildArgs` keeps that pairing structural rather than
 * conventional — the prompt is always the LAST array element pushed and
 * `--print` always the element immediately before it, with no code path able
 * to insert anything after the prompt.
 *
 * CORRECTION (verified against agy 1.1.5, 2026-07-21): this header used to
 * call the above a "LANDMINE", asserting a trailing flag is "silently
 * absorbed into the prompt string" and that "agy exits 0 on this misparse".
 * Both halves are false for 1.1.5 — measured, agy rejects an unknown trailing
 * flag with "flags provided but not defined" and exit 2, and an invalid value
 * with exit 1, both before any model call. The ordering rule stays because it
 * is the house rule for every adapter, not because agy misbehaves.
 *
 * `parseResult` still requires the `AGY_RESULT:` marker (injected via
 * `injectContract`) and classifies a job `failed` without it regardless of
 * exit code — the general silent-misparse backstop for any harness that exits
 * clean without doing the work. See the Adapter port docs
 * (src/adapters/types.ts).
 *
 * MARKER-COLLISION LANDMINE: `injectContract` embeds the literal strings
 * `AGY_RESULT: DONE` / `AGY_RESULT: FAILED` into the prompt as instructions.
 * A harness that echoes those instructions back (verbose logging, a nested
 * agent restating context) before printing its real, final verdict makes
 * BOTH strings appear in stdout — the earlier one is the echoed instruction,
 * not the outcome. The contract (see `injectContract` below) defines the
 * marker as "the last line of output," so `parseResult` must scan for the
 * LAST marker-shaped line, not the first — otherwise an echoed `DONE`
 * example can mask a real, later `FAILED` verdict. `lastMarkerMatch`
 * (`_agy-shared.ts`) scans every match and keeps the final one for exactly
 * this reason.
 *
 * The argv-order guarantee and `lastMarkerMatch` live in `_agy-shared.ts`
 * (shared with `_agy-image.ts` and `_agy-vision.ts`) so the flag-order and marker-collision fixes
 * exist exactly once.
 */
import * as agyImage from "./_agy-image.ts";
import * as agyVision from "./_agy-vision.ts";
import { AGY_EFFORT_LEVELS, buildAgyArgv, lastMarkerMatch, pushAgyEffortFlag, pushAgyOptionalStringFlag } from "./_agy-shared.ts";
import { DEFAULT_KIND } from "./types.ts";
import type { Capability, ModelsProbe, MultiAdapterModule } from "./types.ts";
import type { AdapterResult, DispatchOpts, ModelInfo } from "../types.ts";
import { resolveOptionalAddDir, resolveReadOnly } from "../lib/path-barricade.ts";

export const name = "agy";

/** Verified against agy 1.5.14 (`agy --help`). */
export const effortLevels = AGY_EFFORT_LEVELS;
export const supportsReadOnly = true;
/** Shown by `list_adapters` beside `readOnly`, so a caller knows what readOnly agy can still do. */
export const readOnlyNote = "reads files by exact path only; no shell, writes, MCP or URL fetches";

/**
 * Permission rules denied under `readOnly` (agy 1.5.14, verified 2026-11-22).
 * Each is a `<namespace>(*)` rule in agy's permission syntax. Verified refused
 * (S7-S9): `command`, `write_file` (edit_file is checked as write_file), `mcp`,
 * and `unsandboxed` (run_workflow); subagents inherit the list. `read_url`,
 * `execute_url` and `download_url` are denied by rule but were not exercised.
 */
export const AGY_READ_ONLY_DENY = [
  "command(*)",
  "write_file(*)",
  "mcp(*)",
  "read_url(*)",
  "execute_url(*)",
  "download_url(*)",
  "unsandboxed(*)",
] as const;

/**
 * Constant `--settings` payload for readOnly runs. Deliberately carries no
 * `allow` key and is built from a fixed list: no caller input reaches it.
 */
export const AGY_READ_ONLY_SETTINGS = JSON.stringify({ permissions: { deny: [...AGY_READ_ONLY_DENY] } });

/**
 * Prepended to the prompt under readOnly so the model knows up front which
 * tools are refused and what to do instead. Ends with a blank line so the
 * original prompt (and its trailing marker contract) follows untouched.
 */
export const AGY_READ_ONLY_NOTICE =
  "READ-ONLY SESSION: this run cannot execute shell or terminal commands, write or edit files, " +
  "call MCP tools, or fetch URLs; any such call is refused with a permission error, so do not " +
  "attempt one. The only workspace tool that works is reading a file by its exact path; you cannot " +
  "list directories or search file contents. Work only from the file paths and content given in " +
  "this prompt. Answer directly in your response. If the task asks for a plan, write the plan in " +
  "your response; do not write plan files and do not wait for approval, because nobody can reply. " +
  "If the task cannot be done this way, say what is missing and end with AGY_RESULT: FAILED.\n\n";

/**
 * Marker line the harness must echo verbatim to confirm a real outcome.
 * Anchored to the WHOLE line (start-to-end, modulo surrounding whitespace) so
 * a marker mentioned mid-sentence doesn't collide; `g` so every occurrence in
 * stdout can be enumerated and the LAST one taken (see `lastMarkerMatch`).
 */
const RESULT_MARKER_RE = /^AGY_RESULT:\s*(DONE|FAILED)\s*$/gm;

export function buildArgs(prompt: string, opts: DispatchOpts): string[] {
  const readOnly = resolveReadOnly(name, opts, true);
  const addDir = resolveOptionalAddDir(name, opts);
  const flags: string[] = [];
  pushAgyOptionalStringFlag(flags, opts, "model", "--model");
  pushAgyEffortFlag(flags, opts);
  if (addDir !== undefined) flags.push("--add-dir", addDir);

  // SECURITY / headless posture (verified against agy 1.5.14, 2026-11-22):
  //   - Default (writable): `--sandbox --dangerously-skip-permissions`.
  //   - `readOnly: true`: `--sandbox --mode plan --settings <deny list>`.
  // Plan mode alone is NOT read-only. Headless plan mode honours the user's
  // global agy allow list (`command(*)`, `mcp(*)` ran shell and MCP calls), and
  // the OS sandbox still allows writes into temp directories. agy evaluates
  // rules Deny > Ask > Allow, so the deny list in AGY_READ_ONLY_SETTINGS beats
  // every allow rule; a refused call comes back to the model as a tool error
  // and the turn goes on. Verified refused: command, write_file (incl.
  // edit_file), mcp and unsandboxed (run_workflow), inherited by subagents.
  // We never add allow rules (they cannot keep a shell read-only) and never
  // pass `allow: []` (a refused call then ends the turn with no verdict).
  // Under readOnly the notice goes first so the marker contract stays the tail.
  // Structural flag order: `buildAgyArgv` always pushes `--print` and the
  // prompt last, in that order — nothing lands after the prompt.
  const modeFlags = readOnly
    ? ["--sandbox", "--mode", "plan", "--settings", AGY_READ_ONLY_SETTINGS]
    : ["--sandbox", "--dangerously-skip-permissions"];
  return buildAgyArgv([...modeFlags, ...flags], readOnly ? AGY_READ_ONLY_NOTICE + prompt : prompt);
}

export function injectContract(prompt: string): string {
  return (
    `${prompt}\n\n` +
    "When you have completed the review/implementation above, end your response " +
    "with exactly one line, the last line of output, in one of these two exact forms:\n" +
    "AGY_RESULT: DONE\n" +
    "AGY_RESULT: FAILED\n" +
    "Do not include this line unless it reflects the true outcome."
  );
}

/** Collapse whitespace runs so a summary renders on one line (as `wait` does). */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();
/** Last `n` chars of the whitespace-collapsed text. */
const tail = (text: string, n: number): string => dropLoneLow(collapse(text).slice(-n)).trimStart();

/** agy's headless auto-deny diagnostic, e.g. `... required the "command" permission that headless mode cannot prompt for ...`. */
const AUTO_DENY_RE = /required the "([a-z_]{1,20})" permission that headless mode cannot prompt for/;
/**
 * Matches any stderr line containing "auto-denied": the loose test that a line is
 * an auto-deny diagnostic at all, even when AUTO_DENY_RE cannot read a permission
 * name from it (then the permission is reported as `unknown`).
 */
const AUTO_DENY_FALLBACK_RE = /\bauto-denied\b/;

/** Why a permission is refused under readOnly, for the auto-deny summary. */
function blockedClause(permission: string): string {
  if (permission === "command") return "shell commands are blocked there";
  if (permission === "write_file") return "file writes are blocked there";
  return "that tool is blocked there";
}

/**
 * Permission named by the LAST auto-deny line on stderr. That line alone
 * decides: if its name is overlong or outside [a-z_] the answer is `unknown`,
 * never an earlier line's permission. Undefined when stderr has no auto-deny line.
 */
function autoDeniedPermission(stderr: string): string | undefined {
  const lastLine = stderr.split("\n").findLast((line) => AUTO_DENY_FALLBACK_RE.test(line));
  if (lastLine === undefined) return undefined;
  return AUTO_DENY_RE.exec(lastLine)?.[1] ?? "unknown";
}

/** Drop a UTF-16 surrogate half left dangling at a cut edge, so a pair is never split. */
const dropLoneHigh = (t: string): string => (/[\ud800-\udbff]$/.test(t) ? t.slice(0, -1) : t);
const dropLoneLow = (t: string): string => (/^[\udc00-\udfff]/.test(t) ? t.slice(1) : t);

/**
 * Head + tail of the model's stated cause, whole when it fits in `max` chars.
 * The refusal usually opens the text and the request closes it, so a pure tail
 * would lose the reason. Each cut backs off to the nearest space when there is
 * one (otherwise it cuts mid-token) and never splits a surrogate pair.
 */
function excerpt(text: string, max = 270, head = 130, tailLen = 135): string {
  if (text.length <= max) return text;
  const headCut = dropLoneHigh(text.slice(0, head));
  const headPart = text[head] === " " ? headCut : headCut.replace(/\s*\S*$/, "") || headCut;
  const tailCut = dropLoneLow(text.slice(-tailLen));
  const tailPart = text[text.length - tailLen - 1] === " " ? tailCut : tailCut.replace(/^\S*\s*/, "") || tailCut;
  return `${headPart.trimEnd()} … ${tailPart.trimStart()}`;
}

/**
 * Stdout tail for the generic summary. Model-authored stdout may quote agy's
 * auto-deny message, and a summary must never read as an auto-deny diagnosis
 * when it is not one. So the check runs on the exact text that would be
 * emitted (the collapsed tail): a copy lowercased with every non a-z character
 * removed is searched for `autodenied` or `permission`, which is immune to
 * spacing, line wraps, markdown, casing and hyphen variants. On a hit the whole
 * tail is replaced by a fixed placeholder (the full text stays in `raw`). This
 * is a heuristic on the 70 emitted chars only; it can also omit an innocent
 * tail that mentions "permission".
 */
function safeStdoutTail(stdout: string, n: number): string {
  const out = tail(stdout, n);
  const letters = out.toLowerCase().replace(/[^a-z]/g, "");
  return letters.includes("autodenied") || letters.includes("permission")
    ? "(stdout tail omitted: it quotes agy's permission message; see raw)"
    : out;
}

/**
 * Failure summaries keep their cause inside the first 300 chars, which is all
 * `wait` renders. Two no-marker shapes: auto-deny and generic. With a marker:
 * non-zero exit is `failed`, a FAILED marker is `failed` with the model's
 * excerpt (the third cause-bearing shape), and DONE on exit 0 is `done`.
 */
export function parseResult(stdout: string, stderr: string, exitCode: number): AdapterResult {
  const match = lastMarkerMatch(RESULT_MARKER_RE, stdout);
  const failed = (summary: string): AdapterResult => ({ status: "failed", summary, artifacts: [], raw: stdout });
  if (!match) {
    // stderr only: a model may quote the auto-deny sentence in stdout.
    const permission = autoDeniedPermission(stderr);
    if (permission !== undefined) {
      return failed(
        `agy: stopped with no verdict: it auto-denied a tool needing the "${permission}" permission (headless mode cannot prompt). ` +
          `If this job ran readOnly, ${blockedClause(permission)}. ` +
          "Name the exact files to read, or paste the diff or command output, into the prompt. (missing AGY_RESULT marker)",
      );
    }
    const err = tail(stderr, 130);
    const out = safeStdoutTail(stdout, 70);
    return failed(
      `agy: missing AGY_RESULT marker (exit ${exitCode})` +
        (err ? `: ${err}` : "") +
        ". If this job ran readOnly, name the exact files, or paste the diff or command output, into the prompt." +
        (out ? ` stdout: ${out}` : ""),
    );
  }
  if (exitCode !== 0) return failed(`agy: exited with code ${exitCode}`);
  if (match[1] === "FAILED") {
    const cause = excerpt(collapse(stdout.slice(0, match.index)));
    return failed(cause ? `agy: reported FAILED: ${cause}` : "agy: reported FAILED");
  }
  return { status: "done", summary: stdout.trim(), artifacts: [], raw: stdout };
}

/**
 * Live model-catalog probe via `agy models`. Pure data; executed by
 * `src/lib/models.ts`. Verified against agy 1.5.14.
 */
export const readModels: ModelsProbe = {
  transport: "cli-stdout",
  binary: "agy",
  args: ["models"],
};

/**
 * Parse `agy models` stdout (`<id>   <Display Name>` per line, stripping any
 * leading `\r`-delimited spinner frames). Tolerant: skips non-matching lines.
 */
export function parseModels(raw: unknown): ModelInfo[] {
  if (typeof raw !== "string") return [];
  const out: ModelInfo[] = [];
  for (const rawLine of raw.split("\n")) {
    // Strip trailing \r (CRLF) before splitting on spinner \r frames so the
    // final segment is never empty on CRLF input.
    const segment = rawLine.replace(/\r+$/, "").split("\r").at(-1)?.trim() ?? "";
    if (!segment) continue;
    const match = /^([a-z0-9][a-z0-9._-]+)(?:\t|\s{2,})(.+)$/.exec(segment);
    if (!match) continue;
    const id = match[1]!;
    const displayName = match[2]!.trim();
    out.push({ id, displayName, effortLevels: [...effortLevels] });
  }
  return out;
}

/**
 * Everything agy can be asked for, under ONE adapter name.
 *
 * These used to be three separate adapters — `agy`, `agy-image`, `agy-vision` —
 * which meant a caller had to know that "generate a picture with agy" was
 * spelled as a different harness. That is an internal file-layout detail, not
 * something the caller should carry. Same binary, same auth, same account: one
 * name, three kinds.
 *
 * The implementations still live in their own modules (`_agy-image.ts`,
 * `_agy-vision.ts`) — each is a few hundred lines of path barricades and
 * contract parsing, and the leading `_` keeps discovery from loading them as
 * adapters in their own right. Splitting the FILES was never the problem;
 * splitting the NAMES was.
 */
export const capabilities: Record<string, Capability> = {
  [DEFAULT_KIND]: { buildArgs, injectContract, parseResult },
  image: { buildArgs: agyImage.buildArgs, injectContract: agyImage.injectContract, parseResult: agyImage.parseResult },
  vision: {
    buildArgs: agyVision.buildArgs,
    injectContract: agyVision.injectContract,
    parseResult: agyVision.parseResult,
  },
};

/** Review/implement is what `agy` means with no `kind` — the other two are opt-in. */
export const defaultKind = DEFAULT_KIND;

// Compile-time-only proof that this module's exports satisfy the multi-
// capability port shape — discoverAdapters duck-types at runtime, so this is
// the only place a signature drift would be caught by tsc.
const _check: MultiAdapterModule = {
  name,
  capabilities,
  defaultKind,
  effortLevels,
  supportsReadOnly,
  readOnlyNote,
  readModels,
  parseModels,
};
void _check;
