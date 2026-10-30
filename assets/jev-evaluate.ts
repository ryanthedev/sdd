/**
 * Batch decision calls to TypeSafe Jev, for the sdd `jev` adapter.
 *
 *     bun run jev-evaluate.ts <request.json> <results.json>
 *
 * Jev is a decision model: it never writes text. It takes a `state` (up to
 * ~32k tokens) and named questions, and returns a probability per answer:
 * `boolean` -> {probability}, `choice` -> {choice, probabilities, confidence},
 * `score` -> {score, probabilities, confidence}. It is reached through the
 * Vercel AI Gateway (`POST /v1/evaluate`, model `typesafe-ai/jev`) with the
 * `AI_GATEWAY_API_KEY` bearer key, read from the environment only.
 *
 * REQUEST (the file the adapter's prompt names):
 *   {
 *     "questions": { "<name>": {"type": "boolean"|"choice"|"score",
 *                                "instructions": "...", "criteria": ...}, ... },
 *     "items": [ {"id": "<unique>", "state": "<text>"}, ... ],
 *     "model"?: "typesafe-ai/jev",
 *     "concurrency"?: 1..32 (default 16),
 *     "maxItems"?: raise the default 500-item cap (hard ceiling 10000)
 *   }
 * Every item is asked every question in ONE call (the "panel" pattern), and
 * items run in parallel. About 32 workers saturate one key.
 *
 * CONTRACT (parsed by src/adapters/jev.ts — keep these markers in sync):
 *   SDD_JEV_SUMMARY:items=<n> ok=<n> failed=<n> cost_usd=<x>
 *   SDD_JEV_RESULT:<absolute path to the results JSON>
 * Per-item failures are recorded in the results JSON and do not fail the job.
 * If NO item succeeded (bad key, gateway down) the file is still written but
 * the script exits 1 with the first error on stderr, so the job reads `failed`.
 *
 * Per item the results log the response `model` and the gateway's
 * `finalProvider`. Verified 2026-10-29: `model` only echoes the requested
 * alias (no version is exposed), and the gateway lists a fallback provider
 * (`digitalocean`) behind `typesafe-ai`, so two rankings are only comparable
 * when the same provider answered both.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
const DEFAULT_MODEL = "typesafe-ai/jev";
/** ~32k tokens of text; a longer state is rejected up front, not truncated. */
const MAX_STATE_CHARS = 120_000;
/** The key carries a monthly spend cap; a runaway batch should need an explicit opt-in. */
const DEFAULT_MAX_ITEMS = 500;
const HARD_MAX_ITEMS = 10_000;
const DEFAULT_CONCURRENCY = 16;
const MAX_CONCURRENCY = 32;
const MAX_ATTEMPTS = 7;
const QUESTION_TYPES = new Set(["boolean", "choice", "score"]);

interface Item {
  id: string;
  state: string;
}

interface Request {
  model: string;
  questions: Record<string, unknown>;
  items: Item[];
  concurrency: number;
}

type ItemResult =
  | {
      id: string;
      answers: Record<string, unknown>;
      model: string | null;
      provider: string | null;
      inputTokens: number;
      costUsd: number;
      seconds: number;
    }
  | { id: string; error: string };

function die(msg: string): never {
  process.stderr.write(`jev-evaluate: ${msg}\n`);
  process.exit(1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRequest(raw: unknown): Request {
  if (!isRecord(raw)) die("request must be a JSON object");

  const questions = raw.questions;
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    die('request.questions must be a non-empty object of named questions');
  }
  for (const [qname, q] of Object.entries(questions)) {
    if (!isRecord(q) || typeof q.type !== "string" || !QUESTION_TYPES.has(q.type)) {
      die(`question "${qname}" needs type "boolean", "choice" or "score"`);
    }
    if (typeof q.instructions !== "string" || q.instructions.trim().length === 0) {
      die(`question "${qname}" needs non-empty instructions`);
    }
  }

  const items = raw.items;
  if (!Array.isArray(items) || items.length === 0) die("request.items must be a non-empty array");
  const maxItems = Math.min(typeof raw.maxItems === "number" ? raw.maxItems : DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS);
  if (items.length > maxItems) {
    die(`request has ${items.length} items, over the cap of ${maxItems} (set "maxItems" to raise it, up to ${HARD_MAX_ITEMS})`);
  }
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) die(`items[${i}] needs a non-empty string id`);
    if (seen.has(item.id)) die(`duplicate item id "${item.id}"`);
    seen.add(item.id);
    if (typeof item.state !== "string" || item.state.trim().length === 0) die(`item "${item.id}" needs a non-empty state`);
    if (item.state.length > MAX_STATE_CHARS) {
      die(`item "${item.id}" state is ${item.state.length} chars, over the ${MAX_STATE_CHARS}-char limit (~32k tokens)`);
    }
  }

  const concurrency =
    typeof raw.concurrency === "number" && Number.isInteger(raw.concurrency)
      ? Math.max(1, Math.min(raw.concurrency, MAX_CONCURRENCY))
      : DEFAULT_CONCURRENCY;
  const model = typeof raw.model === "string" && raw.model.length > 0 ? raw.model : DEFAULT_MODEL;
  return { model, questions, items: items as Item[], concurrency };
}

async function evaluate(key: string, model: string, questions: Record<string, unknown>, item: Item): Promise<ItemResult> {
  const body = JSON.stringify({ model, state: item.state, questions });
  let lastError = "no attempt made";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      lastError = `network error: ${e instanceof Error ? e.message : String(e)}`;
      await Bun.sleep(500 * 2 ** attempt + Math.random() * 250);
      continue;
    }
    // Rate limit or a transient upstream failure: back off and retry.
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      await Bun.sleep(500 * 2 ** attempt + Math.random() * 250);
      continue;
    }
    if (!res.ok) return { id: item.id, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const data = (await res.json()) as Record<string, any>;
    if (!isRecord(data.answers)) return { id: item.id, error: "response carried no answers object" };
    return {
      id: item.id,
      answers: data.answers,
      model: typeof data.model === "string" ? data.model : null,
      provider: typeof data.providerMetadata?.gateway?.routing?.finalProvider === "string"
        ? data.providerMetadata.gateway.routing.finalProvider
        : null,
      inputTokens: Number(data.usage?.inputTokens ?? 0),
      costUsd: Number(data.providerMetadata?.gateway?.cost ?? 0),
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
  if (!requestArg || !outArg || process.argv.length !== 4) die("usage: jev-evaluate.ts <request.json> <results.json>");

  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) die("AI_GATEWAY_API_KEY is not set in the environment the sdd server was started from");

  const requestPath = resolve(requestArg);
  const outPath = resolve(outArg);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(requestPath, "utf8"));
  } catch (e) {
    die(`cannot read request ${requestPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const req = parseRequest(raw);

  const results = await pool(req.items, req.concurrency, (item) => evaluate(key, req.model, req.questions, item));
  const ok = results.filter((r) => !("error" in r));
  const failed = results.length - ok.length;
  const costUsd = ok.reduce((sum, r) => sum + ("costUsd" in r ? r.costUsd : 0), 0);
  const inputTokens = ok.reduce((sum, r) => sum + ("inputTokens" in r ? r.inputTokens : 0), 0);
  const distinct = (pick: (r: ItemResult) => string | null) =>
    [...new Set(ok.map(pick).filter((v): v is string => v !== null))];
  const models = distinct((r) => ("model" in r ? r.model : null));
  const providers = distinct((r) => ("provider" in r ? r.provider : null));

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      { requestedModel: req.model, models, providers, items: results.length, ok: ok.length, failed, costUsd, inputTokens, results },
      null,
      2,
    ),
  );

  // Markers last, so a partially written file can never look like a success.
  process.stdout.write(`SDD_JEV_SUMMARY:items=${results.length} ok=${ok.length} failed=${failed} cost_usd=${costUsd.toFixed(6)}\n`);
  process.stdout.write(`SDD_JEV_RESULT:${outPath}\n`);

  if (ok.length === 0) {
    const first = results.find((r) => "error" in r);
    die(`every item failed; first error: ${first && "error" in first ? first.error : "unknown"}`);
  }
}

await main();
