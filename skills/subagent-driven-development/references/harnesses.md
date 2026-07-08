# Harness roster — capabilities & auth

A *harness* here is an external CLI agent (`codex`, `agy`, and friends) that `sdd` spawns as a child process in the current working tree to do one bounded task — review, second opinion, implementation, or image generation — and report back a structured `{status, summary, artifacts, raw}` result. Each harness is wrapped by an adapter in `src/adapters/`; `list_adapters` enumerates them.

The load-bearing distinction: **a harness that shows up in `list_adapters` with `binaryPresent: true` is INSTALLED, not necessarily USABLE.** `binaryPresent` is a `Bun.which` PATH check and nothing more — it cannot see whether the CLI is logged in, has an active subscription, or has an API key in the environment. The honest way to tell whether a harness will actually run is `check_adapter(name)`, which runs a real minimal probe through the dispatch path and reports what happened. See [Auth is not presence](#auth-is-not-presence) below.

## Capability table

| Adapter | Provider / CLI | PATH binary | mode | What it's for | Auth requirement |
|---|---|---|---|---|---|
| `codex` | OpenAI Codex, `codex exec` | `codex` | read | Review / second opinion; read-only sandbox; does its own web verification when a review needs it | codex's own login flow (a ChatGPT/OpenAI account or key) — not documented in the adapter source; verify with `check_adapter`, don't assert specifics |
| `codex-high` | OpenAI Codex, pinned `model_reasoning_effort=high` | `codex` | read | Deep-reasoning review — complex codebases, subtle correctness, security-sensitive code | same as `codex` |
| `codex-low` | OpenAI Codex, pinned `model_reasoning_effort=low` | `codex` | read | Fast/cheap spot-checks, lightweight reads | same as `codex` |
| `grok` | xAI Grok Build CLI 0.2.82, `grok -p` | `grok` | read | Review / second opinion | `GROK_API_KEY` / `GROK_DEPLOYMENT_KEY` env var |
| `kimi` | Moonshot Kimi (kimi-code 0.22.3), `kimi -p` | `kimi` | read | Review / second opinion | `MOONSHOT_API_KEY` env var |
| `qwen` | Alibaba Qwen Code (gemini-cli lineage), `qwen -p` | `qwen` | read | Review / second opinion | `DASHSCOPE_API_KEY` env var |
| `mistral` | Mistral Vibe, `vibe -p` | `vibe` (name ≠ binary) | read | Review / second opinion | `MISTRAL_API_KEY` env var |
| `agy` | General review/implement harness, `agy --print` | `agy` | write (default) | Review AND implement — edits the working tree | agy's own login flow — not documented in the adapter source; verify with `check_adapter` |
| `agy-image` | Nano Banana image generation (built into agy), `agy --print` | `agy` | read | Text prompt → exactly one PNG saved to an explicit absolute path | agy's own login flow (same as `agy`) |

## The read-review roster

`codex`, `grok`, `kimi`, `qwen`, and `mistral` are **interchangeable read-mode second-opinion harnesses**. They share the same output contract — a `VERDICT:` line plus a `## Findings` section — so any one of them can stand in for another, and they fan out cleanly in parallel for an *ensemble* review: dispatch several against the same target in one turn, then `wait` on the batch and compare their findings.

They differ along two axes:

- **Provider / model.** Each speaks to a different vendor's model, so their blind spots and strengths differ — the reason an ensemble is worth more than one call repeated.
- **Auth style.** `grok` / `kimi` / `qwen` / `mistral` are **API-key-auth** (a single env var), while `codex` uses **its own login flow** (an account/subscription). This matters for fan-out: an env-key harness fails instantly at spawn if the key is unset, whereas a login-flow harness fails only if the session isn't active.

`agy` in `mode: "read"` can also serve as a second opinion, but it is not part of this contract-sharing roster — its output contract is the `AGY_RESULT:` marker, not `VERDICT:`/`## Findings`.

## Auth is not presence

`binaryPresent` answers exactly one question: is the CLI binary on `PATH`? It says nothing about whether a dispatch will succeed, because every harness has a second gate that PATH can't see:

- **Env-key adapters** (`grok`, `kimi`, `qwen`, `mistral`) fail at spawn time if their key (`GROK_API_KEY`/`GROK_DEPLOYMENT_KEY`, `MOONSHOT_API_KEY`, `DASHSCOPE_API_KEY`, `MISTRAL_API_KEY`) is unset in the environment the server inherited.
- **Login-flow adapters** (`codex`, `agy`, and by extension `agy-image`) fail if the underlying CLI isn't logged in or the subscription/quota is inactive.

None of this is visible to `list_adapters`. The honest verification is **`check_adapter(name)`** — it runs a minimal live probe through the normal dispatch path (read mode) and reports what actually happened, surfacing the CLI's own auth/quota error text on failure. Its status ladder:

| Status | Meaning |
|---|---|
| `ok` | Binary present **and** the live probe completed — the harness ran and is authenticated. The reliable signal. |
| `failed` | Binary present but the probe failed; `detail` carries the CLI's own error text (typically an auth / subscription / quota message, tailed from the job log where stderr lands). |
| `timeout` | Probe still running at the timeout — inconclusive (slow model, network, or a hang); the probe job is cancelled. Retry with a larger `timeoutMs`. |
| `present_unverified` | Binary present but the adapter opts out of automatic probing (`probeable: false`). Only `agy-image` — a probe would bill a real image generation. Dispatch a real job to confirm auth. |
| `missing` | Binary not on `PATH` — not installed. |

`check_adapter(adapter, timeoutMs?, cwd?)` defaults to a 60s probe timeout (clamped to the JobStore wait cap). Before you rely on a harness you have **not** already exercised this session, check it.

## Output contracts — what "done" means per harness

A job's terminal state is decided by exit code **and** the adapter's `parseResult` marker check: a missing contract marker is `failed` even on a clean exit 0. What each harness must emit:

| Harness(es) | Required output contract |
|---|---|
| `codex`, `codex-high`, `codex-low`, `grok`, `kimi`, `qwen`, `mistral` | A `VERDICT:` line **plus** a `## Findings` section. Missing either → `failed`. |
| `agy` | Last line of output exactly `AGY_RESULT: DONE` or `AGY_RESULT: FAILED`. Parsed by **last** match (the harness may echo the injected instruction first). |
| `agy-image` | `AGY_IMAGE_SAVED: <absolute path>` **and** the file must exist on disk. A marker with no file on disk → `failed`. |
