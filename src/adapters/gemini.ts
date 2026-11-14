/**
 * gemini adapter — Google's Gemini API, reached with the user's API key
 * through bundled bun scripts (no Gemini CLI involved). One harness, two kinds:
 *
 * - `default` — the Gemini Decisions API (`gemini-decision-1`): batch typed
 *   questions (`noul` / `choice` / `score`) over text OR media, returning
 *   probabilities. A multimodal decision model for ranking, routing, and
 *   classifying; legacy `state` / `boolean` request fields still work. See `_gemini-decide.ts`.
 * - `vision` — video-ingest fusion over `generateContent` on the cheapest
 *   Flash-Lite model: the fallback for agy's `vision` kind when agy is out of
 *   quota or down. Same opts and output shape as agy's. See `_gemini-vision.ts`.
 *
 * HARNESS: `bun` (the sdd server already runs on it). KEY: `GEMINI_API_KEY`
 * from the server's environment, else a `GEMINI_API_KEY=` line in
 * `~/.config/sdd/.env`, read by path on every job so a new key works without
 * restarting Claude Code. Scripts run hermetically: the job cwd's bunfig
 * preload and `.env` never load (`_gemini-shared.ts`).
 *
 * `probeable = false`: both kinds need request files or artifact dirs that a
 * generic check_adapter probe cannot supply, and a probe would spend from the
 * key. No `readLimits`: an API key exposes no quota-read endpoint.
 */
import * as decide from "./_gemini-decide.ts";
import * as vision from "./_gemini-vision.ts";
import type { UsageRecord } from "../types.ts";
import { DEFAULT_KIND } from "./types.ts";
import type { Capability, MultiAdapterModule } from "./types.ts";

export const name = "gemini";
/** CLI binary is `bun` — it runs the bundled API clients. */
export const binary = "bun";
export const probeable = false;

/** Capability plus the optional pure usage parser (docs/usage-contract.md
 *  section 1); collapses into plain `Capability` once the port declares it. */
type UsageCapability = Capability;

export const capabilities: Record<string, UsageCapability> = {
  [DEFAULT_KIND]: { buildArgs: decide.buildArgs, injectContract: decide.injectContract, parseResult: decide.parseResult, parseUsage: decide.parseUsage },
  vision: { buildArgs: vision.buildArgs, injectContract: vision.injectContract, parseResult: vision.parseResult, parseUsage: vision.parseUsage },
};

/** Decisions are what `gemini` means with no `kind`. */
export const defaultKind = DEFAULT_KIND;

const _check: MultiAdapterModule = { name, capabilities, defaultKind };
void _check;
