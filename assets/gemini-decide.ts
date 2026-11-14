/**
 * Batch decision calls to the Gemini Decisions API, for the sdd `gemini`
 * adapter's default kind.
 *
 *     bun run gemini-decide.ts <request.json> <results.json>
 *
 * `gemini-decision-1` is a decision model: it never writes text. It reads one
 * shared multimodal `input` (text, images, video, audio, PDF; up to 262,144
 * tokens) and answers up to 1,000 named questions about it in one forward
 * pass: `noul` (yes/no) -> {noul, confidence}, `choice` -> {choice,
 * probabilities, confidence}, `score` -> {score, probabilities, legend,
 * confidence}. Verified live 2026-11-13 against
 * `POST https://generativelanguage.googleapis.com/v1beta/decisions`.
 * List price $0.10 per 1M input tokens, $0 output.
 *
 * KEY: `GEMINI_API_KEY` from the environment when set, otherwise from a
 * `GEMINI_API_KEY=` line in the user-level `~/.config/sdd/.env`
 * (`$XDG_CONFIG_HOME/sdd/.env` when that is set), read by path on every job.
 * Never the job cwd's `.env`: the adapter runs bun with `--no-env-file`.
 *
 * REQUEST (the file the adapter's prompt names):
 *   {
 *     "questions": { "<name>": {"type": "noul"|"choice"|"score",
 *                                "instructions": "...", "criteria": ...}, ... },
 *     "items": [ {"id": "<unique>", "input": <string | block | block[]>}, ... ],
 *     "model"?: "gemini-decision-1",
 *     "resolution"?: "low"|"medium"|"high"   (default for media blocks; "low"),
 *     "concurrency"?: 1..32 (default 16),
 *     "maxItems"?: raise the default 500-item cap (hard ceiling 10000)
 *   }
 * A block is `{"type":"text","text":...}` or a media block
 * `{"type":"image"|"video"|"audio"|"document", "path"|"uri"|"data", "mime_type"?, "resolution"?}`.
 * `path` is a LOCAL file (relative paths resolve against the request file's
 * directory): up to 20 MB it is sent inline as base64, above that it is
 * uploaded once through the Files API and referenced by uri. `uri` passes a
 * Files API uri or an HTTPS URL (15 MB cap) straight through. YouTube URLs
 * are NOT accepted by the API: download first (the `yt-dlp` adapter).
 *
 * JEV-COMPATIBLE: a jev request runs unchanged. An item's `state` string is
 * read as its text `input`, and a question `type: "boolean"` is sent as
 * `noul`. Answers come back in Gemini's shape, not jev's.
 *
 * CONTRACT (parsed by src/adapters/_gemini-decide.ts — keep in sync):
 *   SDD_GEMINI_SUMMARY:items=<n> ok=<n> failed=<n> input_tokens=<n> cost_usd=<x>
 *   SDD_GEMINI_RESULT:<absolute path to the results JSON>
 * Per-item failures (a safety block, a bad media file) are recorded in the
 * results JSON and do not fail the job. If NO item succeeded the file is still
 * written but the script exits 1 with the first error on stderr.
 *
 * DATA EGRESS: every item's input, including any local file it names, is sent
 * to Google.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const API = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-decision-1";
const PRICE_PER_M_INPUT = 0.1;
const DEFAULT_MAX_ITEMS = 500;
const HARD_MAX_ITEMS = 10_000;
const DEFAULT_CONCURRENCY = 16;
const MAX_CONCURRENCY = 32;
const MAX_ATTEMPTS = 7;
/** Above this a local file goes through the Files API instead of inline base64. */
const INLINE_MAX_BYTES = 20 * 1024 * 1024;
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
  items: Item[];
  concurrency: number;
  resolution: string;
  baseDir: string;
}

type ItemResult =
  | { id: string; answers: Record<string, unknown>; inputTokens: number; seconds: number }
  | { id: string; error: string };

function die(msg: string): never {
  process.stderr.write(`gemini-decide: ${msg}\n`);
  process.exit(1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseQuestions(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) die("request.questions must be a non-empty object of named questions");
  if (Object.keys(raw).length > 1000) die(`request has ${Object.keys(raw).length} questions; the API takes at most 1000`);
  const out: Record<string, unknown> = {};
  for (const [qname, q] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(qname)) die(`question name "${qname}" must match [A-Za-z0-9_-] and be at most 64 chars`);
    if (!isRecord(q) || typeof q.type !== "string" || !QUESTION_TYPES.has(q.type)) {
      die(`question "${qname}" needs type "noul", "choice" or "score" ("boolean" is read as "noul")`);
    }
    if (typeof q.instructions !== "string" || q.instructions.trim().length === 0) {
      die(`question "${qname}" needs non-empty instructions`);
    }
    out[qname] = q.type === "boolean" || q.type === "noul" ? toNoul(q) : q;
  }
  return out;
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

function parseRequest(raw: unknown, requestPath: string): Request {
  if (!isRecord(raw)) die("request must be a JSON object");
  const questions = parseQuestions(raw.questions);

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
  const model = typeof raw.model === "string" && raw.model.length > 0 ? raw.model : DEFAULT_MODEL;
  return { model, questions, items: parsed, concurrency, resolution, baseDir: dirname(requestPath) };
}

/** Env first, then the user-level sdd config file — see header. */
function resolveKey(): string {
  const fromEnv = process.env.GEMINI_API_KEY;
  if (fromEnv) return fromEnv;
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const file = join(configHome, "sdd", ".env");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // Missing file reads the same as a missing line.
  }
  const m = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/m.exec(text);
  if (m?.[1]) return m[1];
  die(`GEMINI_API_KEY is not set in the sdd server's environment or in ${file}`);
}

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
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new Error(`Files API upload start failed: HTTP ${start.status} ${(await start.text()).slice(0, 200)}`);
  const done = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: Bun.file(path),
  });
  if (!done.ok) throw new Error(`Files API upload failed: HTTP ${done.status} ${(await done.text()).slice(0, 200)}`);
  const file = ((await done.json()) as { file?: { name?: string; uri?: string; state?: string } }).file;
  if (!file?.name || !file.uri) throw new Error("Files API upload returned no file name/uri");
  let state = file.state;
  for (let i = 0; state === "PROCESSING" && i < 120; i++) {
    await Bun.sleep(2000);
    const res = await fetch(`${API}/v1beta/${file.name}`, { headers: { "x-goog-api-key": key } });
    state = res.ok ? ((await res.json()) as { state?: string }).state : state;
  }
  if (state !== "ACTIVE") throw new Error(`uploaded file ${file.name} ended in state ${state ?? "unknown"}`);
  return file.uri;
}

/** Turn request blocks into API blocks: local paths become inline data or a
 *  Files API uri (each distinct path uploaded once per job). */
async function materialize(
  key: string,
  req: Request,
  input: string | Block[],
  uploads: Map<string, Promise<string>>,
): Promise<string | Block[]> {
  if (typeof input === "string") return input;
  const out: Block[] = [];
  for (const b of input) {
    if (b.type === "text") {
      out.push(b);
      continue;
    }
    const { path, ...rest } = b;
    const block: Block = { ...rest };
    if (block.resolution === undefined && (b.type === "image" || b.type === "video")) block.resolution = req.resolution;
    if (typeof path === "string") {
      const abs = resolve(req.baseDir, path);
      const mime = typeof b.mime_type === "string" ? b.mime_type : MIME_BY_EXT[extname(abs).toLowerCase()];
      if (!mime) throw new Error(`cannot infer mime_type for ${abs}; set "mime_type" on the block`);
      block.mime_type = mime;
      const size = statSync(abs).size;
      if (size <= INLINE_MAX_BYTES) {
        block.data = Buffer.from(readFileSync(abs)).toString("base64");
      } else {
        if (!uploads.has(abs)) uploads.set(abs, uploadFile(key, abs, mime));
        block.uri = await uploads.get(abs)!;
      }
    }
    out.push(block);
  }
  return out;
}

async function decide(key: string, req: Request, item: Item, uploads: Map<string, Promise<string>>): Promise<ItemResult> {
  let input: string | Block[];
  try {
    input = await materialize(key, req, item.input, uploads);
  } catch (e) {
    return { id: item.id, error: e instanceof Error ? e.message : String(e) };
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
      });
    } catch (e) {
      lastError = `network error: ${e instanceof Error ? e.message : String(e)}`;
      await Bun.sleep(500 * 2 ** attempt + Math.random() * 250);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      await Bun.sleep(500 * 2 ** attempt + Math.random() * 250);
      continue;
    }
    if (!res.ok) return { id: item.id, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const data = (await res.json()) as Record<string, any>;
    if (!isRecord(data.answers)) return { id: item.id, error: `response carried no answers object: ${JSON.stringify(data).slice(0, 200)}` };
    return {
      id: item.id,
      answers: data.answers,
      inputTokens: Number(data.usage?.total_input_tokens ?? 0),
      seconds: (performance.now() - t0) / 1000,
    };
  }
  return { id: item.id, error: `retries exhausted (last: ${lastError})` };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const [requestArg, outArg] = process.argv.slice(2);
  if (!requestArg || !outArg || process.argv.length !== 4) die("usage: gemini-decide.ts <request.json> <results.json>");

  const key = resolveKey();
  const requestPath = resolve(requestArg);
  const outPath = resolve(outArg);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(requestPath, "utf8"));
  } catch (e) {
    die(`cannot read request ${requestPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const req = parseRequest(raw, requestPath);

  const uploads = new Map<string, Promise<string>>();
  const results = await pool(req.items, req.concurrency, (item) => decide(key, req, item, uploads));
  const ok = results.filter((r) => !("error" in r));
  const failed = results.length - ok.length;
  const inputTokens = ok.reduce((sum, r) => sum + ("inputTokens" in r ? r.inputTokens : 0), 0);
  const costUsd = (inputTokens / 1_000_000) * PRICE_PER_M_INPUT;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({ model: req.model, items: results.length, ok: ok.length, failed, inputTokens, costUsd, results }, null, 2),
  );

  // Markers last, so a partially written file can never look like a success.
  process.stdout.write(
    `SDD_GEMINI_SUMMARY:items=${results.length} ok=${ok.length} failed=${failed} input_tokens=${inputTokens} cost_usd=${costUsd.toFixed(6)}\n`,
  );
  process.stdout.write(`SDD_GEMINI_RESULT:${outPath}\n`);

  if (ok.length === 0) {
    const first = results.find((r) => "error" in r);
    die(`every item failed; first error: ${first && "error" in first ? first.error : "unknown"}`);
  }
}

await main();
