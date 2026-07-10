# Multi-platform video ingestion → transcript + visual understanding

**What this is:** A capability for the `sdd` plugin that ingests videos from multiple platforms (YouTube, Instagram Reels/posts/Stories, TikTok, X) and produces a machine-consumable understanding combining the full **spoken transcript** with **captured visual content** the transcript misses — sight gags, on-screen text, reaction shots, memes.

**Date:** 2026-07-08 · **Status:** draft
**Research model:** Fable (4 parallel dimensions) + verified live probes this session.

**What's still open (must resolve before/inside planning):**
1. **The "full access" question inverts under scrutiny** — see §5. User's instinct was full-access; research says fetch=full-access, analyze=sandboxed. Needs an explicit decision, gated on the threat model.
2. ~~Can a sandboxed agy read external frame files?~~ **RESOLVED (verified live 2026-07-08):** yes. `agy --sandbox --add-dir <dir> --model "Gemini 3.1 Pro (High)"` read an external frame correctly (`COLORS: red, blue`, exit 0). `--sandbox` blocks network/shell but **not** `--add-dir` file reads — so the split-privilege containment in §5 is viable: the analysis step can be sandboxed *and* still see the frames. This removes the only blocker to the recommended posture.
3. Frame budget / dedup defaults are proposed (§4), not yet tuned on real target content.

---

## 1. Confirmed intent

| Dimension | Decision |
|---|---|
| **Output** | Feed-into-next-step: raw fused transcript+visual understanding as input to a downstream process (user's own analysis, a post, etc.). Not a polished digest, not extracted clips — a structured understanding object. |
| **Surface shape** | Multiple adapters under the hood, surfaced as **a single "vision"/video tool** to the caller. |
| **Platforms** | YouTube + Instagram + TikTok + X, generically (yt-dlp covers all four). |
| **Prior art in repo** | None — greenfield. Engram + code confirm: no video/vision-analysis path exists; `agy-image` is generation only. |

**Verified live this session:** agy (v1.1.0) *can* read a local frame in `--print` mode — it correctly read a red/blue test frame — but **only** with a strong vision model (`Gemini 3.1 Pro (High)`) + `--add-dir`. `Gemini 3.5 Flash (Low)` looped ("I will wait for the search task…") and timed out. **Model choice is load-bearing for the vision step.** agy's `--sandbox` is opt-in in the binary; the current adapter *adds* it.

---

## 2. Platform coverage & auth (yt-dlp, verified July 2026)

**Whisper is mandatory for everything.** No platform gives reliable subtitle tracks: Instagram has *none*, X effectively none, TikTok has real auto-captions but coverage is spotty and currently regressed. Treat any captions as an opportunistic skip-whisper optimization, never the primary path.

| Platform | Anon access | Auth needed when | Captions | Rate-limit posture |
|---|---|---|---|---|
| **TikTok** | ✅ videos + profiles | private/login-gated only | Real VTT/SRT auto-captions, but intermittent (regression #15657) | Moderate; IP-level (status 10204); `--sleep-requests 3` |
| **X/Twitter** | ✅ public tweets (guest token) | NSFW / protected accounts (`auth_token`) | Effectively none (rare HLS/Periscope) | Gentlest; auto-falls back to syndication on 429. Stale cookies can *break* it — try dropping cookies |
| **Instagram** | ⚠️ some reels, rate-limited fast | Stories & private **always**; realistically always | **None** (post "caption" = description text only) | **Most aggressive — punishes the ACCOUNT, not just IP.** Warnings after <20 dl/month. Use a burner account's cookies |

**Auth mechanics:** `--cookies-from-browser <browser>` and `--cookies cookies.txt` (Netscape header, LF endings) both work. On macOS: Firefox is friction-free; Chrome triggers a Keychain prompt; Safari needs Full Disk Access. Instagram is chronically flaky — **run the nightly channel** (`yt-dlp --update-to nightly`). Whole-profile: Instagram's profile extractor is broken (`_WORKING=False`) — TikTok/X profiles partially work; use gallery-dl/instaloader for bulk profile grabs.

**Instagram posture (the hard one):** burner account cookies (Firefox source), nightly yt-dlp, `--sleep-requests 2 --sleep-interval 5 --max-sleep-interval 15`, low volume, residential IP. Expect account risk, not just IP bans.

---

## 3. Architecture fit within sdd (codebase-grounded)

**The hexagon already answers the design question: an adapter wraps exactly one child process; orchestration is the caller's job.** An adapter is pure data + pure functions with no I/O (`src/adapters/types.ts`), and one dispatch = one spawned process (`src/lib/jobs.ts` `#spawnAndTrack`). There is no DAG/chaining primitive. So:

| # | Decision | Rationale |
|---|---|---|
| 3.1 | **Not one mega-adapter.** | A `buildArgs` returning a wrapper script hides multi-step I/O outside the hexagon, collapses per-step logs into one blob, makes cancel all-or-nothing, and needs a 3-in-1 contract (`agy-image.ts`: "one output contract per adapter"). |
| 3.2 | **Thin `read`-mode tool adapters** (`yt-dlp`, `whisper`, `ffmpeg-frames`) — or plain main-thread Bash. | Adapters buy the JobStore's real value: background execution, per-job logs, process-group cancel, non-blocking dispatch. Whisper on an hour of audio is exactly that workload. Precedent that non-agent tool adapters are OK: `agy-image.parseResult` already does read-only `existsSync`. Classification for these = exit-code + output-file existence (`injectContract` must be **identity** — the "prompt" is a URL/path; a contract marker would corrupt argv). |
| 3.3 | **Media lands OUTSIDE the source tree**, caller-named absolute artifact dir (validated like `agy-image.resolveOutputPath`), so every step stays `mode:"read"` and transcribe ∥ frame-extraction fan out concurrently without tripping the write-write guard. In-tree media would make every step honestly `write` and serialize the whole pipeline per cwd. |
| 3.4 | **Full-access agy = a pinned variant file `agy-full.ts`, NOT an `opts.sandbox` flag.** | The codebase names the exact attack: `codex.ts` refuses config passthrough because a caller could set `danger-full-access`; `_codex-shared.ts` calls that "structurally unreachable." An `opts.sandbox` flag would put the most dangerous knob at the untrusted MCP-client boundary. The `_codex-factory.ts` pattern ("the pin IS the point") is the sanctioned template. Precede it with an extracted `_agy-shared.ts` owning the flag-order landmine + `lastMarkerMatch` (currently copy-pasted between `agy.ts` and `agy-image.ts`). |
| 3.5 | **The "single vision tool" surface** = the Skills layer + the caller sequencing dispatches (`dispatch(fetch)→wait→dispatch(transcribe) ∥ dispatch(frames)→wait→dispatch(agy-full fusion)`), per existing SKILL.md doctrine. The one agent-contract step is the fusion dispatch. |

**Frictions to expect:**
- **DispatchOpts switchboard:** `DispatchOpts` is open (index signature) but the MCP tool schema is closed — every adapter opt is hand-listed in `dispatch.ts`'s zod shape. New opts (`outputDir`, `frameCount`, `cookies`, `sceneThreshold`) each mean editing `dispatch.ts`. "No central registry" holds for discovery, already violated for opts.
- **`parseResult` gets no `opts`** — a tool adapter can't know its expected output path/count; falls back to exit-code + existence. Real departure from "missing marker → failed even on exit 0" — state it in each tool adapter's header.
- **In-memory job state** (accepted v1): a multi-step pipeline amplifies restart loss — a dead server orphans the pipeline mid-sequence with artifacts on disk and no job map.

---

## 4. Visual-capture technique (and where it breaks)

**Pipeline:** scene-cut keyframes (ffmpeg) → dedup → timestamp-align/interleave with transcript → feed budgeted frame set + interleaved transcript to the vision model.

- **Scene detect:** `ffmpeg -i in.mp4 -vf "select='gt(scene,0.35)',showinfo" -vsync vfr -frame_pts 1 f_%d.jpg 2> scenes.log` then grep `pts_time`. Threshold band **0.3–0.5**; 0.25–0.3 for fast-cut reels/animation, 0.45–0.5 for hard cuts. Newer `scdet` filter emits `lavfi.scd.time`. `thumbnail=n=N` is a tuning-free "one representative frame per chunk" fallback.
- **Frame budget:** short-form **8–20 frames** (a 60s reel at 1fps dedups to ~8–12); long-form **50–150** (Gemini-class saturates ~50; smaller VLMs plateau 16–32). Dedup via pixel mean-abs-diff (~8% threshold) or dhash Hamming <12 to kill A-B-A cutaway resends. Progressive refinement (overview grid → zoom) beats one big dump.
- **On-screen text:** **just ask the vision model** — Tesseract 34.4% vs VLM 73.5% on stylized/busy text; the frame is going to the model anyway. Reserve tesseract only as a zero-cost "does this frame contain text at all" pre-filter.
- **Alignment:** interleave chronologically — transcript segment `[00:42–00:47] "…"` immediately followed by frames whose PTS falls in that window. Battle-tested trick: **burn the timestamp into the frame pixels** (survives any model's image handling; lets the model cite `t=` back). Or name files `frame_00m42s.jpg` and state the convention.

**Where it breaks (set expectations):**
- **Motion-only humor** (pratfall, double-take, dance) is invisible in stills — GPT-5/Gemini 3 Pro still fail motion-only discrimination.
- **Timing/rhythm jokes** (comedic beats, pause length, audio-visual sync) need audio+temporal signal a frame set can't carry.
- **Fast cuts / meme-flash** shorter than the sampling interval vanish; fades/dissolves evade both scene filters.
- **Shuffle invariance:** video LLMs often read frames as a bag of images — setup→punchline ordering is weakly used. Make the interleaved transcript carry the causality explicitly.

---

## 5. Security / containment — the open decision

Untrusted video content flows into an agent. Two distinct injection vectors:
- **Transcript text** — standard indirect prompt injection (uploader controls captions; crafted audio mis-heard by ASR).
- **On-screen text in frames (text-in-image)** — **the stronger, less-defended vector.** Rendered "ignore previous instructions" enters as visual embeddings *downstream of any text sanitizer*. Reported attack-success up to **82%**; cross-model transfer confirmed on GPT-4V/Claude/Gemini. Real CVEs in 2025–26 (e.g. CVE-2025-53773).

**What this means for "full access":** the current `agy-image` fence (BEGIN/END + "treat as data") is the *weak* delimiter tier and does **nothing** against pixel-borne instructions. Its real protection was never the fence — it was `--sandbox`. The **lethal trifecta** (private data + untrusted content + network egress) is exactly what a full-access fusion agent holds.

**Recommended posture — split privilege across the process boundary:**
- **Fetch** (`yt-dlp`, network, *no model*) runs full-access — it needs the network, but never sees model instructions.
- **Fuse/analyze** (transcript + frames → the step that eats untrusted content) runs **sandboxed: no network, no shell** — a compromised analyzer then has nothing to exfiltrate through and no command path.
- This *inverts* the user's initial "give it full access": full-access is for the download; the thinking step is the one to contain.

**✅ Tension resolved (verified live 2026-07-08):** a *sandboxed* agy (`--sandbox --add-dir <dir>`, Gemini 3.1 Pro High) read the external frame correctly. `--sandbox` restricts network/shell but not `--add-dir` file reads. So the analysis step can be **both** sandboxed (no net/shell) **and** able to read the frames — the split-privilege posture has no blocker. Note this means the `agy-full` (no-sandbox) variant is needed **only** for the fetch step or a one-shot autonomous mode; the *fusion* step should use the normal sandboxed `agy` with `--add-dir` pointed at the artifact dir.

**Threat-model calibration (for the decision):** if this is a *personal* tool ingesting videos the user hand-picks, the practical injection risk is lower than a service ingesting arbitrary attacker URLs — but not zero (a random viral frame can still carry an injection, and the agent runs on the user's machine with real creds in env). The decision is: accept full-access-analysis convenience for personal use, or build the split-privilege containment. Research recommendation: build the split; it's cheap and it's the only architecturally robust control.

---

## 6. Proposed build shape (for planning, not yet decided)

1. `_agy-shared.ts` — extract flag-order + `lastMarkerMatch` from `agy.ts`.
2. `agy-full.ts` — pinned no-sandbox variant (keeps `--dangerously-skip-permissions`, adds `--add-dir`, defaults to a vision-capable model, `mode:"write"`). Header documents the removed barricade.
3. Thin `read`-mode tool adapters (or Bash): `yt-dlp` (fetch, cookies/sleep opts), `whisper` (mlx-whisper large-v3-turbo), `ffmpeg-frames` (scene-cut + budget + dedup). Media → external artifact dir.
4. A **skill** (the "single vision tool" surface) documenting the sequence, the fan-out point (transcribe ∥ frames), frame budgets, timestamp-interleaving, and the split-privilege containment.
5. **Verify open item #2** (sandboxed external-file read) before locking the containment design.

**Next:** `/code-foundations:plan .code-foundations/research/2026-07-08-multi-platform-video-ingestion.md`
