/**
 * Batch decision calls to the Gemini Decisions API, for the sdd `gemini`
 * adapter's default kind.
 *
 *     bun run gemini-decide.ts [flags] <request.json> <results.json>
 *     bun run gemini-decide.ts [flags] --inline '<request json>' <results.json>
 *     ... with --out-auto in place of <results.json> (a fresh temp dir is used)
 *
 * Leading flags (all optional, always BEFORE the positionals; the original
 * `<request.json> <results.json>` form is unchanged and still works):
 *   --inline <json>      the request itself instead of a file path; relative
 *                        media paths resolve against the job cwd
 *   --out-auto           no results path: write `<mkdtemp>/results.json` and
 *                        report it in the result marker
 *   --model <id>         overrides request.model
 *   --deadline-ms <n>    overall deadline: stop scheduling new items, flush
 *
 * `gemini-decision-1` is a decision model: it never writes text. It reads one
 * shared multimodal `input` (text, images, video, audio, PDF; up to 262,144
 * tokens) and answers up to 1,000 named questions about it in one forward
 * pass: `noul` (yes/no) -> {noul, confidence}, `choice` -> {choice,
 * probabilities, confidence}, `score` -> {score, probabilities, legend,
 * confidence}. Verified live 2026-11-13 against
 * `POST https://generativelanguage.googleapis.com/v1beta/decisions`.
 * List price $0.10 per 1M input tokens, $0 output. A score question's
 * `criteria` is a string rubric (verified 2026-11-14: an object is rejected).
 * A choice question's `criteria` is an object `{label: description}`; a plain
 * list of labels is converted (verified 2026-11-14: the API rejects a list).
 *
 * KEY: `GEMINI_API_KEY` from the environment when set, otherwise from a
 * `GEMINI_API_KEY=` line in the user-level `~/.config/sdd/.env`
 * (`$XDG_CONFIG_HOME/sdd/.env` when that is set), read by path on every job.
 * Never the job cwd's `.env`: the adapter runs bun with `--no-env-file`.
 *
 * REQUEST (the file the adapter's prompt names, or the inline JSON):
 *   {
 *     "questions": { "<name>": {"type": "noul"|"choice"|"score"|"boolean",
 *                                "instructions": "...", "criteria": ...}, ... },
 *     "items": [ {"id": "<unique>", "input": <string | block | block[]>}, ... ],
 *     "model"?: "gemini-decision-1",
 *     "resolution"?: "low"|"medium"|"high"|"ultra_high"   (default for media blocks; "low"),
 *     "concurrency"?: 1..32 (default 16),
 *     "maxItems"?: raise the default 500-item cap (hard ceiling 10000),
 *     "maxCostUsd"?: per-job cost cap, default 1.00: no new item is scheduled once
 *                    the accumulated cost reaches it; the rest are recorded as
 *                    {id, error:"skipped: maxCostUsd reached"} and the summary says stopped=budget,
 *     "dryRun"?: true  validate, stat media, estimate tokens and cost, call nothing,
 *     "allowOutsidePaths"?: true  allow media `path`s outside the request directory / job cwd
 *   }
 * A block is `{"type":"text","text":...}` or a media block
 * `{"type":"image"|"video"|"audio"|"document", "path"|"uri"|"data", "mime_type"?, "resolution"?}`.
 * `path` is a LOCAL file (relative paths resolve against the request file's
 * directory, or the job cwd for --inline) and must resolve (realpath) inside
 * that directory or the job cwd unless `allowOutsidePaths` is true. An item
 * whose inline media totals up to 14 MB raw is sent inline as base64; above
 * that its largest files are uploaded once through the Files API and
 * referenced by uri. `uri` passes a Files API uri or an HTTPS URL (15 MB cap)
 * straight through. YouTube URLs are NOT accepted by the API: download first
 * (the `yt-dlp` adapter).
 *
 * JEV-COMPATIBLE: a jev request runs unchanged. An item's `state` string is
 * read as its text `input`, and a question `type: "boolean"` is sent as
 * `noul`; its answer carries `probability` (= noul) next to the native fields.
 * Every answer also carries a uniform headline `p` (P(yes) for noul, the
 * chosen label's probability for choice, the score's probability for score).
 *
 * RESULTS JSON: {model, requestedModel, questionTypes, items, ok, failed,
 * inputTokens, costUsd, stopped?, results:[{id, answers, inputTokens, costUsd,
 * seconds} | {id, error}]}. inputTokens and costUsd are null (never 0) when
 * the API reported no usage or the model has no known price.
 *
 * CONTRACT (parsed by src/adapters/_gemini-decide.ts — keep in sync):
 *   SDD_GEMINI_USAGE:<json>   cumulative UsageRecord (docs/usage-contract.md); the LAST one wins;
 *                             also flushed on SIGTERM (then exit 143) and before any die()
 *                             after a billed call
 *   SDD_GEMINI_SUMMARY:items=<n> ok=<n> failed=<n> input_tokens=<n|unknown> cost_usd=<x|unknown> [skipped=<n>]
 *                       [stopped=<budget|deadline|fatal|circuit>] [failed_ids=<first 5>] [first_error=<...>]
 *   SDD_GEMINI_ANSWERS:<compact json>   only when <= 8 KB: {"<id>": {"<question>": <headline>} | {"error": ...}}
 *   SDD_GEMINI_RESULT:<absolute path to the results JSON>
 * Per-item failures (a safety block, a bad media file) are recorded in the
 * results JSON and do not fail the job. If NO item succeeded the file is still
 * written but the script exits 1 with the first error on stderr.
 *
 * FAIL FAST: the first item runs alone; HTTP 400/401/403 on it aborts the job
 * (the rest recorded as skipped) rather than firing the same failure N times.
 * 5 consecutive identical non-retryable errors abort it too.
 * PARTIAL RESULTS: each finished item is appended to `<results>.partial.jsonl`,
 * deleted after the final file is written (so it survives only a killed job).
 *
 * BUDGET (docs/usage-contract.md section 4): before the first API call the
 * script refuses (exit 1) if the gemini spend in `$SDD_LEDGER_PATH` (default
 * `~/.local/state/sdd/ledger.jsonl`) reaches `~/.config/sdd/budget.json`'s
 * daily (rolling 24 h) or monthly (local calendar month) limit.
 *
 * DATA EGRESS: every item's input, including any local file it names, is sent
 * to Google.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { budgetRefusal, emitUsage, resolveKey, retryAfterMs, type UsageRecord, unpricedModelRefusal } from "./gemini-common.ts";

const API = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-decision-1";
/** List price per 1M tokens, keyed by model. A model not listed has an unknown
 *  cost (null), never a guess. */
const PRICES: Record<string, { input: number; output: number }> = {
  "gemini-decision-1": { input: 0.1, output: 0 },
};
const DEFAULT_MAX_ITEMS = 500;
const HARD_MAX_ITEMS = 10_000;
const DEFAULT_CONCURRENCY = 16;
const MAX_CONCURRENCY = 32;
const DEFAULT_MAX_COST_USD = 1.0;
const MAX_ATTEMPTS = 7;
const BREAKER_THRESHOLD = 5;
/** An item's inline media (raw bytes, summed over its blocks) above this goes
 *  through the Files API: 14 MB raw is about 18.7 MB base64, under the 20 MB
 *  request cap with room for the questions. */
const INLINE_MAX_BYTES = 14 * 1024 * 1024;
const ANSWERS_MAX_BYTES = 8 * 1024;
const DECISION_TIMEOUT_MS = 120_000;
const UPLOAD_START_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
const QUESTION_TYPES = new Set(["noul", "choice", "score", "boolean"]);
const MEDIA_TYPES = new Set(["image", "video", "audio", "document"]);
const RESOLUTIONS = new Set(["low", "medium", "high", "ultra_high"]);

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mpeg": "video/mpeg", ".mpg": "video/mpeg",
  ".mov": "video/mov", ".avi": "video/avi", ".webm": "video/webm", ".wmv": "video/wmv",
  ".flv": "video/x-flv", ".3gp": "video/3gpp",
  ".wav": "audio/wav", ".mp3": "audio/mp3", ".m4a": "audio/aac", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".flac": "audio/flac", ".aiff": "audio/aiff",
  ".pdf": "application/pdf",
};

type Block = Record<string, unknown>;

interface Item {
  id: string;
  input: string | Block[];
}

interface Request {
  model: string;
  questions: Record<string, unknown>;
  /** The type each question was written with (`boolean` stays `boolean`). */
  questionTypes: Record<string, string>;
  /** Questions that arrived as jev `boolean` and get a `probability` alias. */
  booleanQuestions: Set<string>;
  items: Item[];
  concurrency: number;
  resolution: string;
  baseDir: string;
  maxCostUsd: number;
  dryRun: boolean;
  allowOutsidePaths: boolean;
  /** Real directories a media path may live in. */
  roots: string[];
  /** How many items reference each (resolved) path, to cache shared base64 only. */
  pathRefs: Map<string, number>;
}

type ItemResult =
  | { id: string; answers: Record<string, unknown>; inputTokens: number | null; costUsd: number | null; seconds: number }
  | { id: string; error: string; status?: number; retryable?: boolean; skipped?: boolean };

type StopReason = "budget" | "deadline" | "fatal" | "circuit";

/** Cumulative spend, the source of every usage marker. */
const st = {
  model: null as string | null,
  items: null as number | null,
  calls: 0,
  ok: 0,
  failed: 0,
  inputTokens: 0,
  inputUnknown: false,
  outputTokens: 0,
  outputUnknown: false,
  /** Sum of the per-call costs that WERE known (drives maxCostUsd). */
  costKnown: 0,
  priced: false,
};

function usageRecord(): UsageRecord {
  const price = st.model ? PRICES[st.model] : undefined;
  let costUsd: number | null = null;
  if (price && !st.inputUnknown && (price.output === 0 || !st.outputUnknown)) {
    costUsd = (st.inputTokens * price.input + st.outputTokens * price.output) / 1_000_000;
  }
  return {
    model: st.model,
    calls: st.calls,
    items: st.items,
    ok: st.ok,
    failed: st.failed,
    // No billed call means a KNOWN zero; an unreadable usage payload is null.
    inputTokens: st.inputUnknown ? null : st.inputTokens,
    outputTokens: st.outputUnknown ? null : st.outputTokens,
    costUsd,
    costIsEstimate: true,
  };
}

/** Always report usage once the script has started, even with zero billed calls,
 *  so the ledger records $0 rather than an unknown (charged) cost. */
function flushUsage(): void {
  emitUsage(usageRecord());
}

function die(msg: string): never {
  process.stderr.write(`gemini-decide: ${msg}\n`);
  flushUsage();
  process.exit(1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class PathPolicyError extends Error {}

// ---------------------------------------------------------------- CLI ----

interface Cli {
  deadlineMs: number | null;
  model: string | null;
  inline: string | null;
  outAuto: boolean;
  positionals: string[];
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = { deadlineMs: null, model: null, inline: null, outAuto: false, positionals: [] };
  let i = 0;
  while (i < argv.length && (argv[i] as string).startsWith("--")) {
    const flag = argv[i] as string;
    if (flag === "--out-auto") {
      cli.outAuto = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) die(`${flag} needs a value`);
    if (flag === "--deadline-ms") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) die(`--deadline-ms must be a positive number, got: ${value}`);
      cli.deadlineMs = n;
    } else if (flag === "--model") {
      if (!/^[a-z0-9][a-z0-9.-]{0,79}$/.test(value)) die(`--model must be a Gemini model id, got: ${value}`);
      cli.model = value;
    } else if (flag === "--inline") {
      cli.inline = value;
    } else {
      die(`unknown flag ${flag}`);
    }
    i += 2;
  }
  cli.positionals = argv.slice(i);
  const want = (cli.inline === null ? 1 : 0) + (cli.outAuto ? 0 : 1);
  if (cli.positionals.length !== want) {
    die("usage: gemini-decide.ts [--inline <json>] [--out-auto] [--model <id>] [--deadline-ms <n>] [<request.json>] [<results.json>]");
  }
  return cli;
}

// ------------------------------------------------------------ request ----

function parseQuestions(raw: unknown): Pick<Request, "questions" | "questionTypes" | "booleanQuestions"> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) die("request.questions must be a non-empty object of named questions");
  if (Object.keys(raw).length > 1000) die(`request has ${Object.keys(raw).length} questions; the API takes at most 1000`);
  const questions: Record<string, unknown> = {};
  const questionTypes: Record<string, string> = {};
  const booleanQuestions = new Set<string>();
  for (const [qname, q] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(qname)) die(`question name "${qname}" must match [A-Za-z0-9_-] and be at most 64 chars`);
    if (!isRecord(q) || typeof q.type !== "string" || !QUESTION_TYPES.has(q.type)) {
      die(`question "${qname}" needs type "noul", "choice" or "score" ("boolean" is read as "noul")`);
    }
    if (typeof q.instructions !== "string" || q.instructions.trim().length === 0) {
      die(`question "${qname}" needs non-empty instructions`);
    }
    questionTypes[qname] = q.type;
    if (q.type === "boolean") booleanQuestions.add(qname);
    questions[qname] = q.type === "boolean" || q.type === "noul" ? toNoul(q) : q.type === "choice" ? toChoice(q) : q;
  }
  return { questions, questionTypes, booleanQuestions };
}

/** A `choice` question's criteria must be an object `{label: description}`.
 *  A plain list of labels (the natural first guess, and jev's shape) is
 *  converted to `{label: ""}`; the API rejects the list form. */
function toChoice(q: Record<string, unknown>): Record<string, unknown> {
  const c = q.criteria;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    return { ...q, criteria: Object.fromEntries((c as string[]).map((label) => [label, ""])) };
  }
  return q;
}

/** A jev `boolean` (criteria `{true, false}`) becomes a Gemini `noul`
 *  (criteria `{true_description, false_description}`). Gemini-shaped criteria
 *  pass through untouched. */
function toNoul(q: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...q, type: "noul" };
  const c = q.criteria;
  if (isRecord(c) && ("true" in c || "false" in c)) {
    const mapped: Record<string, unknown> = {};
    if (typeof c.true === "string") mapped.true_description = c.true;
    if (typeof c.false === "string") mapped.false_description = c.false;
    out.criteria = mapped;
  }
  return out;
}

function parseItemInput(item: Record<string, unknown>, label: string): string | Block[] {
  const input = item.input ?? item.state;
  if (typeof input === "string") {
    if (input.trim().length === 0) die(`${label} has an empty input`);
    return input;
  }
  const blocks = Array.isArray(input) ? input : isRecord(input) ? [input] : null;
  if (!blocks || blocks.length === 0) die(`${label} needs an "input" (string, block, or array of blocks) or a jev-style "state"`);
  for (const [i, b] of blocks.entries()) {
    if (!isRecord(b) || typeof b.type !== "string") die(`${label} input[${i}] must be an object with a "type"`);
    if (b.type === "text") {
      if (typeof b.text !== "string") die(`${label} input[${i}] text block needs a "text" string`);
      continue;
    }
    if (!MEDIA_TYPES.has(b.type)) die(`${label} input[${i}] has unsupported type "${b.type}"`);
    const sources = ["path", "uri", "data"].filter((k) => typeof b[k] === "string" && (b[k] as string).length > 0);
    if (sources.length !== 1) die(`${label} input[${i}] needs exactly one of "path", "uri" or "data"`);
    if (typeof b.uri === "string" && /(^|\.)youtube\.com\/|youtu\.be\//.test(b.uri)) {
      die(`${label} input[${i}]: YouTube URLs are not accepted by the Decisions API; download the video first (yt-dlp adapter) and pass its path`);
    }
    if (b.resolution !== undefined && (typeof b.resolution !== "string" || !RESOLUTIONS.has(b.resolution))) {
      die(`${label} input[${i}] resolution must be one of low, medium, high, ultra_high`);
    }
  }
  return blocks as Block[];
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Resolve a media `path` and enforce containment: the REAL path must sit in
 *  the request directory or the job cwd unless the request allows otherwise.
 *  Throws ENOENT for a missing file, PathPolicyError for an escape. */
function mediaPath(req: Request, p: string): string {
  const abs = resolve(req.baseDir, p);
  if (req.allowOutsidePaths) return abs;
  const real = realpathSync(abs);
  if (!req.roots.some((r) => real === r || real.startsWith(r + sep))) {
    throw new PathPolicyError(
      `media path ${p} resolves to ${real}, outside the request directory and the job cwd; set "allowOutsidePaths": true in the request to allow it`,
    );
  }
  return real;
}

function parseRequest(raw: unknown, baseDir: string, cli: Cli): Request {
  if (!isRecord(raw)) die("request must be a JSON object");
  const q = parseQuestions(raw.questions);

  const items = raw.items;
  if (!Array.isArray(items) || items.length === 0) die("request.items must be a non-empty array");
  const maxItems = Math.min(typeof raw.maxItems === "number" ? raw.maxItems : DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS);
  if (items.length > maxItems) {
    die(`request has ${items.length} items, over the cap of ${maxItems} (set "maxItems" to raise it, up to ${HARD_MAX_ITEMS})`);
  }
  const seen = new Set<string>();
  const parsed: Item[] = [];
  for (const [i, item] of items.entries()) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) die(`items[${i}] needs a non-empty string id`);
    if (seen.has(item.id)) die(`duplicate item id "${item.id}"`);
    seen.add(item.id);
    parsed.push({ id: item.id, input: parseItemInput(item, `item "${item.id}"`) });
  }

  const resolution = raw.resolution === undefined ? "low" : raw.resolution;
  if (typeof resolution !== "string" || !RESOLUTIONS.has(resolution)) die(`request.resolution must be one of low, medium, high, ultra_high`);
  const concurrency =
    typeof raw.concurrency === "number" && Number.isInteger(raw.concurrency)
      ? Math.max(1, Math.min(raw.concurrency, MAX_CONCURRENCY))
      : DEFAULT_CONCURRENCY;
  const model = cli.model ?? (typeof raw.model === "string" && raw.model.length > 0 ? raw.model : DEFAULT_MODEL);
  if (raw.maxCostUsd !== undefined && (typeof raw.maxCostUsd !== "number" || !(raw.maxCostUsd > 0))) {
    die("request.maxCostUsd must be a positive number");
  }
  const req: Request = {
    model,
    ...q,
    items: parsed,
    concurrency,
    resolution,
    baseDir,
    maxCostUsd: typeof raw.maxCostUsd === "number" ? raw.maxCostUsd : DEFAULT_MAX_COST_USD,
    dryRun: raw.dryRun === true,
    allowOutsidePaths: raw.allowOutsidePaths === true,
    roots: [...new Set([realOrResolved(baseDir), realOrResolved(process.cwd())])],
    pathRefs: new Map(),
  };

  // Containment is a request-level policy: refuse before any call. A missing
  // file is a per-item error later, not a policy violation.
  for (const item of parsed) {
    if (typeof item.input === "string") continue;
    for (const b of item.input) {
      if (typeof b.path !== "string") continue;
      try {
        const abs = mediaPath(req, b.path);
        req.pathRefs.set(abs, (req.pathRefs.get(abs) ?? 0) + 1);
      } catch (e) {
        if (e instanceof PathPolicyError) die(`item "${item.id}": ${e.message}`);
      }
    }
  }
  return req;
}

// -------------------------------------------------------------- media ----

/** Upload a large local file through the Files API (resumable protocol) and
 *  wait until it is ACTIVE. Returns the file uri. */
async function uploadFile(key: string, path: string, mime: string): Promise<string> {
  const size = statSync(path).size;
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: basename(path) } }),
    signal: AbortSignal.timeout(UPLOAD_START_TIMEOUT_MS),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new Error(`Files API upload start failed: HTTP ${start.status} ${(await start.text()).slice(0, 200)}`);
  const done = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: Bun.file(path),
    // Proportionate: two minutes plus two seconds per MB.
    signal: AbortSignal.timeout(120_000 + Math.ceil(size / 1_000_000) * 2000),
  });
  if (!done.ok) throw new Error(`Files API upload failed: HTTP ${done.status} ${(await done.text()).slice(0, 200)}`);
  const file = ((await done.json()) as { file?: { name?: string; uri?: string; state?: string } }).file;
  if (!file?.name || !file.uri) throw new Error("Files API upload returned no file name/uri");
  let state = file.state;
  for (let i = 0; state === "PROCESSING" && i < 120; i++) {
    await Bun.sleep(2000);
    const res = await fetch(`${API}/v1beta/${file.name}`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    state = res.ok ? ((await res.json()) as { state?: string }).state : state;
  }
  if (state !== "ACTIVE") throw new Error(`uploaded file ${file.name} ended in state ${state ?? "unknown"}`);
  return file.uri;
}

interface MediaCaches {
  uploads: Map<string, Promise<string>>;
  /** base64 of paths shared by more than one item (others are read per use). */
  b64: Map<string, string>;
}

function readBase64(req: Request, caches: MediaCaches, abs: string): string {
  const shared = (req.pathRefs.get(abs) ?? 0) > 1;
  const hit = shared ? caches.b64.get(abs) : undefined;
  if (hit !== undefined) return hit;
  const data = readFileSync(abs).toString("base64");
  if (shared) caches.b64.set(abs, data);
  return data;
}

/** Turn request blocks into API blocks. Path blocks become inline data while
 *  the item's inline total stays within INLINE_MAX_BYTES; the largest ones
 *  that don't fit are uploaded once per job through the Files API. */
async function materialize(key: string, req: Request, input: string | Block[], caches: MediaCaches): Promise<string | Block[]> {
  if (typeof input === "string") return input;
  interface Plan { b: Block; abs?: string; size: number; upload: boolean }
  const plans: Plan[] = [];
  let inlineTotal = 0;
  for (const b of input) {
    if (b.type === "text") {
      plans.push({ b, size: 0, upload: false });
      continue;
    }
    if (typeof b.path === "string") {
      const abs = mediaPath(req, b.path);
      const size = statSync(abs).size;
      plans.push({ b, abs, size, upload: false });
      inlineTotal += size;
    } else {
      plans.push({ b, size: 0, upload: false });
      if (typeof b.data === "string") inlineTotal += Math.floor((b.data.length * 3) / 4);
    }
  }
  const pathPlans = plans.filter((p) => p.abs !== undefined).sort((a, b) => b.size - a.size);
  for (const p of pathPlans) {
    if (inlineTotal <= INLINE_MAX_BYTES) break;
    p.upload = true;
    inlineTotal -= p.size;
  }
  if (inlineTotal > INLINE_MAX_BYTES) {
    throw new Error(`inline "data" blocks total ${(inlineTotal / 1048576).toFixed(1)} MB, over the ${INLINE_MAX_BYTES / 1048576} MB inline cap; use "path" or "uri" blocks`);
  }

  const out: Block[] = [];
  for (const p of plans) {
    const b = p.b;
    if (b.type === "text") {
      out.push(b);
      continue;
    }
    const { path, ...rest } = b;
    const block: Block = { ...rest };
    if (block.resolution === undefined && (b.type === "image" || b.type === "video")) block.resolution = req.resolution;
    if (typeof path === "string" && p.abs) {
      const mime = typeof b.mime_type === "string" ? b.mime_type : MIME_BY_EXT[extname(p.abs).toLowerCase()];
      if (!mime) throw new Error(`cannot infer mime_type for ${p.abs}; set "mime_type" on the block`);
      block.mime_type = mime;
      if (p.upload) {
        if (!caches.uploads.has(p.abs)) caches.uploads.set(p.abs, uploadFile(key, p.abs, mime));
        block.uri = await caches.uploads.get(p.abs)!;
      } else {
        block.data = readBase64(req, caches, p.abs);
      }
    }
    out.push(block);
  }
  return out;
}

// ------------------------------------------------------------- answers ----

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** P(key) from a probabilities payload that may be an object keyed by label,
 *  or an array of {label|choice|score|name, p|probability|value} entries. */
function probOf(probs: unknown, key: string): number | null {
  if (isRecord(probs)) return num(probs[key]);
  if (Array.isArray(probs)) {
    for (const e of probs) {
      if (!isRecord(e)) continue;
      const label = e.label ?? e.choice ?? e.score ?? e.name;
      if (String(label) === key) return num(e.p ?? e.probability ?? e.value);
    }
  }
  return null;
}

/** The headline probability of one native answer, or null when it can't be read. */
function headlineP(a: Record<string, unknown>): number | null {
  if ("noul" in a) return num(a.noul);
  if (typeof a.choice === "string") return probOf(a.probabilities, a.choice);
  if ("score" in a) return probOf(a.probabilities, String(a.score));
  return null;
}

/** Native answers plus the uniform `p` (and jev's `probability` for a
 *  question that arrived as `boolean`). */
function enrichAnswers(req: Request, answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [qname, a] of Object.entries(answers)) {
    if (!isRecord(a)) {
      out[qname] = a;
      continue;
    }
    const e: Record<string, unknown> = { ...a };
    const p = headlineP(a);
    if (p !== null) e.p = p;
    if (req.booleanQuestions.has(qname) && "noul" in a) e.probability = a.noul;
    out[qname] = e;
  }
  return out;
}

const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function headline(a: unknown): unknown {
  if (!isRecord(a)) return null;
  const p = headlineP(a);
  if ("noul" in a) return p === null ? null : r4(p);
  if (typeof a.choice === "string") return p === null ? { choice: a.choice } : { choice: a.choice, p: r4(p) };
  if ("score" in a) return p === null ? { score: a.score } : { score: a.score, p: r4(p) };
  return null;
}

/** `{"<id>": {"<question>": <headline>}}` compact, or null over 8 KB. */
function answersMarker(results: ItemResult[]): string | null {
  const compact: Record<string, unknown> = {};
  for (const r of results) {
    if ("error" in r) {
      compact[r.id] = { error: r.error.replace(/\s+/g, " ").slice(0, 120) };
      continue;
    }
    const per: Record<string, unknown> = {};
    for (const [qname, a] of Object.entries(r.answers)) per[qname] = headline(a);
    compact[r.id] = per;
  }
  const text = JSON.stringify(compact);
  return Buffer.byteLength(text) <= ANSWERS_MAX_BYTES ? text : null;
}

// ------------------------------------------------------------- the API ----

function costOf(model: string, inputTokens: number | null): number | null {
  const price = PRICES[model];
  return price && inputTokens !== null ? (inputTokens * price.input) / 1_000_000 : null;
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250;
}

async function decide(key: string, req: Request, item: Item, caches: MediaCaches): Promise<ItemResult> {
  let input: string | Block[];
  try {
    input = await materialize(key, req, item.input, caches);
  } catch (e) {
    return { id: item.id, error: e instanceof Error ? e.message : String(e), retryable: false };
  }
  const body = JSON.stringify({ model: req.model, input, questions: req.questions });
  let lastError = "no attempt made";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(`${API}/v1beta/decisions`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      });
    } catch (e) {
      lastError = `network error: ${e instanceof Error ? e.message : String(e)}`;
      await Bun.sleep(backoff(attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      await Bun.sleep(retryAfterMs(res) ?? backoff(attempt));
      continue;
    }
    if (!res.ok) {
      return { id: item.id, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, status: res.status, retryable: false };
    }
    const data = (await res.json()) as Record<string, any>;
    // The call reached the API and answered: it is billed whatever the body holds.
    const inTok = num(data.usage?.total_input_tokens);
    const outTok = num(data.usage?.total_output_tokens);
    st.calls++;
    if (inTok === null) st.inputUnknown = true;
    else st.inputTokens += inTok;
    if (outTok === null) st.outputUnknown = true;
    else st.outputTokens += outTok;
    const cost = costOf(req.model, inTok);
    if (cost !== null) st.costKnown += cost;
    if (typeof data.model === "string" && data.model.length > 0) st.model = data.model;
    if (!isRecord(data.answers)) {
      return { id: item.id, error: `response carried no answers object: ${JSON.stringify(data).slice(0, 200)}`, retryable: false };
    }
    return {
      id: item.id,
      answers: enrichAnswers(req, data.answers),
      inputTokens: inTok,
      costUsd: cost,
      seconds: (performance.now() - t0) / 1000,
    };
  }
  return { id: item.id, error: `retries exhausted (last: ${lastError})`, retryable: true };
}

// ------------------------------------------------------------- dry run ----

/** Rough input-token estimate for one item (text ~4 chars/token; media from
 *  file size at typical bitrates). An estimate, not a quote. */
function estimateTokens(req: Request, item: Item, qTokens: number, problems: { id: string; error: string }[]): number {
  let t = qTokens;
  if (typeof item.input === "string") return t + Math.ceil(item.input.length / 4);
  for (const b of item.input) {
    if (b.type === "text") {
      t += Math.ceil(String(b.text).length / 4);
      continue;
    }
    let size = 0;
    if (typeof b.path === "string") {
      try {
        size = statSync(mediaPath(req, b.path)).size;
      } catch (e) {
        problems.push({ id: item.id, error: e instanceof PathPolicyError ? e.message : `cannot stat ${b.path}: ${e instanceof Error ? e.message : String(e)}` });
      }
    } else if (typeof b.data === "string") {
      size = Math.floor((b.data.length * 3) / 4);
    }
    if (b.type === "image") t += 600;
    else if (b.type === "video") t += Math.ceil(size / 2500);
    else if (b.type === "audio") t += Math.ceil(size / 500);
    else t += Math.ceil(size / 200);
  }
  return t;
}

// ---------------------------------------------------------------- main ----

const STOP_TEXT: Record<StopReason, string> = {
  budget: "maxCostUsd reached",
  deadline: "deadline reached",
  fatal: "aborted after a fatal error on the first item",
  circuit: `aborted after ${BREAKER_THRESHOLD} identical errors in a row`,
};

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function main(): Promise<void> {
  // A cancelled job still reports what it spent (docs/usage-contract.md section 2).
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      flushUsage();
      process.exit(143);
    });
  }
  const startedAt = Date.now();
  const cli = parseCli(process.argv.slice(2));

  let raw: unknown;
  let baseDir: string;
  if (cli.inline !== null) {
    baseDir = process.cwd();
    try {
      raw = JSON.parse(cli.inline);
    } catch (e) {
      die(`inline request is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    const requestPath = resolve(cli.positionals[0] as string);
    baseDir = dirname(requestPath);
    try {
      raw = JSON.parse(readFileSync(requestPath, "utf8"));
    } catch (e) {
      die(`cannot read request ${requestPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const req = parseRequest(raw, baseDir, cli);
  st.model = req.model;
  const unpriced = unpricedModelRefusal(req.model, (m) => m in PRICES, "gemini-decide");
  if (unpriced) die(unpriced);
  st.items = req.items.length;

  const outArg = cli.outAuto ? null : (cli.positionals[cli.positionals.length - 1] as string);
  const outPath = outArg !== null ? resolve(outArg) : join(mkdtempSync(join(tmpdir(), "sdd-gemini-")), "results.json");
  mkdirSync(dirname(outPath), { recursive: true });

  if (req.dryRun) {
    const qTokens = Math.ceil(JSON.stringify(req.questions).length / 4);
    const problems: { id: string; error: string }[] = [];
    const inputTokens = req.items.reduce((n, item) => n + estimateTokens(req, item, qTokens, problems), 0);
    const costUsd = costOf(req.model, inputTokens);
    writeFileSync(
      outPath,
      JSON.stringify(
        { dryRun: true, model: req.model, requestedModel: req.model, questionTypes: req.questionTypes, items: req.items.length, estimate: { inputTokens, costUsd, note: "rough: text at 4 chars/token, media from file size" }, problems },
        null,
        2,
      ),
    );
    process.stdout.write(
      `SDD_GEMINI_SUMMARY:dry_run=1 items=${req.items.length} est_input_tokens=${inputTokens} est_cost_usd=${costUsd === null ? "unknown" : costUsd.toFixed(6)} problems=${problems.length}\n`,
    );
    process.stdout.write(`SDD_GEMINI_RESULT:${outPath}\n`);
    return;
  }

  const { key } = resolveKey();
  if (!key) die(`GEMINI_API_KEY is not set in the sdd server's environment or in ${resolveKey().file}`);
  const refusal = budgetRefusal("gemini-decide");
  if (refusal) die(refusal);

  const deadlineAt = cli.deadlineMs !== null ? startedAt + cli.deadlineMs : Infinity;
  const caches: MediaCaches = { uploads: new Map(), b64: new Map() };
  const partialPath = `${outPath}.partial.jsonl`;
  rmSync(partialPath, { force: true });

  const results: (ItemResult | undefined)[] = new Array(req.items.length);
  let stop: StopReason | null = null;
  let fatalMessage = "";
  let streak = { msg: "", n: 0 };
  let lastUsagePrint = 0;

  const finish = (i: number, r: ItemResult): void => {
    results[i] = r;
    if ("error" in r) st.failed++;
    else st.ok++;
    appendFileSync(partialPath, `${JSON.stringify(r)}\n`);
    if ("error" in r) {
      if (r.retryable === false) {
        streak = streak.msg === r.error ? { msg: r.error, n: streak.n + 1 } : { msg: r.error, n: 1 };
        if (streak.n >= BREAKER_THRESHOLD && !stop) stop = "circuit";
      }
    } else {
      streak = { msg: "", n: 0 };
    }
    if (st.costKnown >= req.maxCostUsd && !stop) stop = "budget";
    // Throttled running total, so even a SIGKILLed job leaves a recent figure.
    if (st.calls > 0 && Date.now() - lastUsagePrint > 2000) {
      lastUsagePrint = Date.now();
      flushUsage();
    }
  };
  const runOne = async (i: number): Promise<void> => {
    finish(i, await decide(key, req, req.items[i] as Item, caches));
  };

  // The first item runs alone: a request that fails the same way for every
  // item (bad key, bad question shape) fails once, not N times.
  await runOne(0);
  const first = results[0];
  if (first && "error" in first && (first.status === 400 || first.status === 401 || first.status === 403)) {
    stop = "fatal";
    fatalMessage = first.error;
  }
  let next = 1;
  await Promise.all(
    Array.from({ length: Math.min(req.concurrency, req.items.length - 1) }, async () => {
      while (next < req.items.length && !stop) {
        if (Date.now() >= deadlineAt) {
          stop = "deadline";
          break;
        }
        await runOne(next++);
      }
    }),
  );

  const reasonText = stop === "fatal" ? `${STOP_TEXT.fatal}: ${oneLine(fatalMessage, 150)}` : stop ? STOP_TEXT[stop] : "";
  const final: ItemResult[] = req.items.map((item, i) => results[i] ?? { id: item.id, error: `skipped: ${reasonText}`, skipped: true });
  const ok = final.filter((r) => !("error" in r));
  const failed = final.length - ok.length;
  const skipped = final.filter((r) => "error" in r && r.skipped).length;
  const usage = usageRecord();

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        model: st.model ?? req.model,
        requestedModel: req.model,
        questionTypes: req.questionTypes,
        items: final.length,
        ok: ok.length,
        failed,
        ...(skipped > 0 ? { skipped } : {}),
        ...(stop ? { stopped: stop } : {}),
        inputTokens: usage.inputTokens,
        costUsd: usage.costUsd,
        results: final.map((r) => {
          if (!("error" in r)) return r;
          const { retryable: _r, status: _s, skipped: _k, ...rest } = r;
          return rest;
        }),
      },
      null,
      2,
    ),
  );
  rmSync(partialPath, { force: true });

  // Markers last, so a partially written file can never look like a success.
  flushUsage();
  const real = final.filter((r): r is Extract<ItemResult, { error: string }> => "error" in r && !r.skipped);
  let summary =
    `SDD_GEMINI_SUMMARY:items=${final.length} ok=${ok.length} failed=${failed}` +
    ` input_tokens=${usage.inputTokens ?? "unknown"} cost_usd=${usage.costUsd === null ? "unknown" : usage.costUsd.toFixed(6)}`;
  if (skipped > 0) summary += ` skipped=${skipped}`;
  if (stop) summary += ` stopped=${stop}`;
  if (real.length > 0) {
    summary += ` failed_ids=${real.slice(0, 5).map((r) => r.id.replace(/[\s,]/g, "_")).join(",")}`;
    summary += ` first_error=${oneLine((real[0] as { error: string }).error, 200)}`;
  }
  process.stdout.write(`${summary}\n`);
  const answers = answersMarker(final);
  if (answers !== null) process.stdout.write(`SDD_GEMINI_ANSWERS:${answers}\n`);
  process.stdout.write(`SDD_GEMINI_RESULT:${outPath}\n`);

  if (ok.length === 0) {
    const firstErr = final.find((r) => "error" in r);
    die(`every item failed; first error: ${firstErr && "error" in firstErr ? firstErr.error : "unknown"}`);
  }
}

await main();
