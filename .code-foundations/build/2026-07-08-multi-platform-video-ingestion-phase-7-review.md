# Review: Phase 7 - video-ingest SKILL.md

## Executed Results (Step 0)
- Test suite: `bun test` → **274 pass, 0 fail**, 783 expect() calls, 18 files (3.50s)
- Typecheck: `bunx tsc --noEmit` → **clean, exit 0**, no output
- Lint: no project lint script; N/A
- Skill validator: `validate_skill` on `skills/video-ingest/` → `valid: true`, **0 errors, 0 warnings**, 1 info (Claude-Code-only `when_to_use` key — expected, matches `subagent-driven-development/SKILL.md`'s own shape)

## Requirement Fulfillment

### DW-7.1
PREMISE:  SKILL.md documents the full sequence with the fan-out point (transcribe ∥ frames) explicit.
EVIDENCE: SKILL.md:47-72, section "2. The sequence" — ASCII diagram lines 51-68, with explicit `├─ FAN OUT (independent reads — dispatch BOTH in the same turn) ─┤` (line 58) bracketing the `dispatch(whisper, …)` / `dispatch(ffmpeg-frames, …)` pair, and prose at line 71: "**dispatch both in the same turn**, then `wait` on the pair. This is the pipeline's one concurrency win; do not serialize them."
TRACE:    Reader follows preflight → yt-dlp dispatch/wait/result → sees the bracketed fan-out block → dispatches whisper and ffmpeg-frames together → waits both → dispatches agy-vision. The full deterministic sequence plus the one parallel point is unambiguous.
VERDICT:  PASS

### DW-7.2
PREMISE:  SKILL.md runs `bun run src/lib/preflight.ts` first and states the failure behavior.
EVIDENCE: SKILL.md:31-39, section "0. Preflight FIRST — gate before any dispatch": the fenced command `bun run src/lib/preflight.ts` (line 36) and "It prints a JSON report and **exits non-zero when any tool is missing or unusable**. On a non-zero exit, **stop** — do not dispatch." (line 39).
TRACE:    Reader runs the preflight command before step 1; non-zero exit → stop, surface `hint` fields, no dispatch occurs. Exit 0 → proceed to step 1. Failure behavior is explicit and precedes all dispatch instructions (this is literally section 0, before section 1's artifact directory and section 2's sequence).
VERDICT:  PASS

### DW-7.3
PREMISE:  per-platform auth notes cover all four (YouTube, Instagram, TikTok, X); Instagram cookies/nightly/sleeps called out.
EVIDENCE: SKILL.md:78-87, section "4. Per-platform auth" — table with rows for YouTube, TikTok, X (Twitter), Instagram (lines 82-85). Instagram row: "A **burner-account** `cookies` file (export from a logged-in **Firefox** session; never a primary account, never commit/log it) **+** yt-dlp's **nightly** build (extractor fixes ship faster than stable) **+** `sleepRequests` to throttle and avoid tripping rate limits."
TRACE:    Reader hitting an Instagram fetch failure looks up the table row → told to supply cookies (burner, Firefox-exported) + nightly yt-dlp + sleepRequests, and line 87 adds that `yt-dlp`'s `parseResult` stderr surfaces actionable guidance on failure, pointing to the README's exact commands.
VERDICT:  PASS

### DW-7.4
PREMISE:  the split-privilege rule (fetch full-network / fusion sandboxed) AND the strong-vision-model rule (Gemini 3.1 Pro tier, not Flash-Low) are both stated.
EVIDENCE: SKILL.md:104-115, sections "7. Split-privilege containment" ("**Fetch runs full-network, no agent.**" line 108; "**Fusion runs SANDBOXED.**" line 109; "Never route fusion through a full-access agent, and never move network access into the fusion step." line 111) and "8. Strong vision model — not Flash-Low" ("Default agy-vision to **`"Gemini 3.1 Pro (High)"`**" line 115; "**Do NOT use a weak/fast tier like `Gemini 3.5 Flash (Low)`** — it loops on the frame set and times out." line 115).
TRACE:    Reader assembling the agy-vision dispatch (SKILL.md:66) sees `model: "Gemini 3.1 Pro (High)"` inline in the sequence diagram itself, reinforced by dedicated section 8; the split-privilege boundary is stated as a named, non-collapsible rule in section 7 with an explicit "why" (image-borne prompt injection defeats text fencing).
VERDICT:  PASS

### DW-7.5
PREMISE:  the skill validates cleanly (frontmatter + structure) and is discoverable. Run the check below.
EVIDENCE: `validate_skill` output: `{"valid":true,"errors":[],"warnings":[],"info":[{"rule":"cc-extension-key","message":"frontmatter key \`when_to_use\` is Claude-Code-only — not portable to other agents"}]}`. Frontmatter (SKILL.md:1-25) has `name: video-ingest`, a third-person `description` (1008 chars, under the 1536 combined-truncation limit per validator stats), and `when_to_use` with concrete trigger phrases — same three-key shape (`name`/`description`/`when_to_use`) as `skills/subagent-driven-development/SKILL.md:1-16`.
TRACE:    Validator run against the skill directory returns zero errors and zero warnings; the sole info-level finding is a portability note shared by the reference skill, not a defect. Discoverability: name matches directory (`video-ingest`), description is verb-first with concrete platform/trigger nouns and a "Not for:" exclusion clause (lines 15-17) — structurally equivalent to the reference skill's own exclusion clause.
VERDICT:  PASS

### DW-7.6
PREMISE:  MANUAL E2E is documented as a procedure (install tools → real URL → confirm non-empty fused.json), NOT faked as a live run. Verify the procedure is present and honestly labeled deferred/manual.
EVIDENCE: SKILL.md:128-135, section "10. Manual E2E (DEFERRED-MANUAL)": "`yt-dlp` and `mlx-whisper` are **not installed in this build environment**, so the real-URL end-to-end run cannot be executed here and must be verified manually on a machine that has the tooling:" followed by 4 numbered steps — (1) install tools + confirm preflight exits 0, (2) pick a short public YouTube URL, (3) run the full sequence from §2, (4) confirm `fused.json` is non-empty with populated `moments[]` entries.
TRACE:    Section heading itself carries the "(DEFERRED-MANUAL)" tag; opening sentence states plainly the run "cannot be executed here" rather than presenting fabricated output. No claim anywhere in the file asserts the pipeline was actually run end-to-end against a real URL — this is the only outcome-verification section, and it is procedural, not a transcript.
VERDICT:  PASS

**All requirements met:** YES

## Test-DW Coverage
DW-7.1 through DW-7.6 are documentation-fidelity requirements against a single Markdown file (no runtime behavior to unit-test). Coverage is via recorded observed behavior (direct reading of SKILL.md sections, quoted above) plus one deterministic automated check:
- [x] DW-7.5 — automated: `validate_skill` (ran in Step 0), `valid: true`, 0 errors/warnings.
- [x] DW-7.1, 7.2, 7.3, 7.4, 7.6 — no automated test is possible for prose-content assertions on a doc file; each is covered by observed-behavior line citations above, matching the "non-testable item" fallback in the review protocol.
- [x] `bun test` (274 pass) and `bunx tsc --noEmit` (clean) confirm the docs-only phase left the repo green, per the dispatch's "how to run the suite" instruction.
- Gap: none — this phase has no source-code DW items requiring unit tests.

## Dead Code
N/A — SKILL.md is documentation only, no code to scan. No bundled scripts in `skills/video-ingest/` (0 reference files per validator stats).

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | PASS | SKILL.md:43 correctly states read-mode jobs stay off the JobStore write-write guard so the fan-out can proceed — matches `src/lib/jobs.ts` invariant (write-write serialization only applies to `write`-mode; both `whisper` and `ffmpeg-frames` adapters are `read`-mode, verified `mode: "read"` pattern used project-wide). No documented instruction would trigger the guard. |
| Error Handling | PASS | Preflight failure path stated (SKILL.md:39, stop on non-zero exit); auth failure path stated (SKILL.md:87, relay `yt-dlp`'s stderr-tail summary as actionable guidance). |
| Resources | N/A | No file handles/connections/locks owned by the doc itself; artifact directory lifecycle (SKILL.md:41-45) is advisory, not resource-managed code. |
| Boundaries | PASS | Frame-count/scene-threshold defaults claimed in SKILL.md:91 ("cap 150, scene threshold 0.35") verified against `src/adapters/ffmpeg-frames.ts:113-114` (`DEFAULT_FRAME_COUNT = 150`, `DEFAULT_SCENE_THRESHOLD = 0.35`) — exact match, no documentation drift. |
| Security | PASS | Split-privilege section (SKILL.md:104-115) correctly states fetch is full-network/no-agent and fusion is sandboxed with `--sandbox` (no shell, no network) — consistent with the project's documented security-barricade doctrine (CLAUDE.md "Non-obvious invariants"). Traced the adversarial case: an on-screen frame carrying a prompt-injection payload reaches only the sandboxed agy-vision step, which per the doc has no shell/network to exploit even if steered — the containment argument holds as stated. |

## Loaded-Skill Criteria

| Skill | Criterion | Status | Evidence |
|-------|-----------|--------|----------|
| skill-craft (validator floor) | `validate_skill` zero errors | PASS | `valid: true`, `errors: []` |
| skill-craft (validator floor) | `validate_skill` warnings each need a stated reason | PASS | `warnings: []` — none to justify |
| skill-craft (Triggers) | Description: third person, key use case first, concrete trigger nouns, near-miss exclusion clause, no workflow steps | PASS | Description (SKILL.md:3-17) opens "Ingest a video from a URL..." (third person, capability-first), names concrete platforms/adapters, and closes with "Not for: image generation..., code review..., or writing new MCP tools / adapters..." (lines 15-17) — a genuine near-miss exclusion, not an absurd negative. No numbered workflow steps appear in the description itself (the numbered sections live in the body, which is correct placement). |
| skill-craft (Structure) | Point-of-decision content (gates, routing, hard rules) inline, not behind conditional loads | PASS | Preflight gate (§0), fan-out point (§2), auth table (§4), split-privilege rule (§7), model-tier rule (§8) are all inline in the single SKILL.md body — no references/ subdirectory exists (0 reference files per validator), so nothing is hidden behind a conditional load. |
| skill-craft (Over-prescription) | MUST/CRITICAL/ALWAYS density; anti-laziness pushes; step-by-step where general instruction suffices | PASS | Grep for MUST/CRITICAL/ALWAYS returned only 3 hits, all natural prose emphasis ("whisper always runs", "always runs under agy's --sandbox", "not installed... must be verified manually") — no imperative CRITICAL/MUST scaffolding, no anti-laziness language. |
| skill-craft (Banned constructs) | No anti-rationalization tables, self-assessed compliance checklists, "Red Flags — STOP" sections | PASS | Grep for "Rationalization", "Red Flag", "Compliance verified" returned zero matches. |
| skill-craft (Conciseness) | No paragraphs explaining what Claude already knows; not educational-about-the-domain tone | PASS | 135 lines total (well under the 500-line hard cap and close to the ~200-line "always-relevant core" guidance); every section states an operational rule (gate, sequence, auth, budget, containment) rather than background exposition. |
| skill-craft (Workflow completeness) | Explicit gates between phases; failure paths not just happy path; clear exit conditions | PASS | Gate: §0 preflight ("stop — do not dispatch" on failure). Failure paths: §0 tool-missing hints, §4 auth-failure relay, §5 frame-cap `dropped` count (no silent truncation). Exit condition: §10 step 4 defines success as non-empty `fused.json` with populated `moments[]`. |
| skill-craft (Hygiene) | No time-sensitive phrasing outside an "Old patterns" section; consistent terminology; fully qualified tool names | PASS | No dated/version-pinned claims found outside the model-tier name itself (which is a live config value, not a stale-pattern reference); terminology (`artifactDir`, `outputDir`, `addDir`/`outputPath`, adapter names) is used consistently across all 10 sections. |
| skill-craft (Supply chain) | Bundled scripts checked for network calls / obfuscation; fine-tuned-model dispatch flagged | N/A | Skill bundles zero scripts/reference files (validator: `reference_files: 0`) and dispatches only to the project's existing hosted-provider adapters (`agy-vision` → Gemini via provider API, no fine-tuning) — no supply-chain surface to audit. |

## Notes (non-blocking)
- The description (1008 chars) plus `when_to_use` combine under the 1536-char listing-truncation limit reported by the validator's stats — no truncation risk observed, though this was read from validator stats rather than an explicit combined-length check.
- No `test_triggers` behavioral probe was run in this review (time-boxed to the deterministic validator + line-level content audit per the dispatch's DW list); the validator's zero-error/zero-warning result plus the structural comparison to `subagent-driven-development/SKILL.md` stood in for it. If trigger accuracy becomes a concern later, `test_triggers` is the tool to reach for.
- Section 3 ("Whisper is mandatory; captions are opportunistic") documents a narrow TikTok caption-skip optimization not asked about in the DW list — read it as a legitimate scope note, not a requirement gap.

## Issues (if FAIL)
None.

**Verdict: PASS**
