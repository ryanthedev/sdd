# Recipes: running sdd at full strength

Four recipes that combine the eight tools into bigger moves. Each one says what was measured and what is still a bet, because the skill's rule holds here too: don't oversell. Numbers marked *tellme* come from the Jev experiments in `~/repos/tellme` (Oct 2026, `experiments/RESULTS.md` there).

## Contents

| Recipe | Use it when | Core move |
|---|---|---|
| [1. Quota-first routing](#1-quota-first-routing) | Before any fan-out of three or more jobs | Spend prepaid quota before metered keys |
| [2. Parallel writers in worktrees](#2-parallel-writers-in-worktrees) | Two or more implementation jobs, or a bake-off | One `git worktree` per writer, Claude merges |
| [3. Ensemble review, ranked](#3-ensemble-review-ranked) | A diff that matters enough for more than one reviewer | Five vendors, findings clustered and ranked by agreement |
| [4. Repo-scale targeting with Jev](#4-repo-scale-targeting-with-jev) | Auditing more code than anyone can read | Jev ranks every routine; reviewers read the top slice |

## 1. Quota-first routing

codex and agy run on accounts you already pay for, and their quota windows reset whether you used them or not. grok, kimi, qwen, mistral and jev bill per token. So the cheapest job is the one that spends surplus you have already bought.

1. **Read the meter once:** `usage(adapter:"codex")` before a fan-out. It costs no tokens and is cached about 60 s, so one call covers the whole batch.
2. **Route by what it says:**

| `usage` shows | Do |
|---|---|
| Headroom, and the window resets soon | Put codex on everything it can do (review, implement, image). That quota is gone at reset anyway |
| Window nearly used up | Keep codex for the job that most needs it (the hard implementation, the `effort:"high"` review) and send breadth to the metered roster |
| `limitReached` set | Don't dispatch codex. Route to agy or the metered roster |

3. **Only codex reports quota.** agy is account-backed too but exports no limits reading, so `usage` can't see it; confirm it with `check_adapter("agy")` instead. Never read a missing agy reading as "plenty left".
4. **Metered harnesses are cheap, not free.** A review costs cents. Fan them out on purpose, for the vendor diversity, not as a default.

## 2. Parallel writers in worktrees

The base rule (SKILL.md §1) is that two writers must never share a `cwd`. A worktree removes the collision instead of the parallelism: each writer gets its own checkout, so they run at the same time and Claude merges the results.

```bash
# one per writer, outside the repo so tools in the main tree never index it
git -C <repo> worktree add -b sdd/<task>-codex <repo>/../<repo>-sdd-<task>-codex HEAD
git -C <repo> worktree add -b sdd/<task>-agy   <repo>/../<repo>-sdd-<task>-agy   HEAD
```

Then dispatch each writer with `cwd: <its worktree>` in the same turn, and `wait` on the pair.

- **Bake-off:** give the SAME task to two harnesses (say codex `effort:"high"` and agy), run the tests in each worktree, and keep the better diff. Two vendors attempting one hard change is the cheapest way to get a second design for free.
- **Split work:** give DIFFERENT, independent tasks to different worktrees. Independent means disjoint files; if two tasks touch one file, expect a merge conflict, and resolving it is Claude's job.

Gotchas that bite every time:

- **The worktree starts at HEAD.** Uncommitted edits in the main tree are not in it. Commit or stash first, or the harness works on stale code.
- **Dependencies are not installed.** A fresh worktree has no `node_modules`/`.venv`. Run the install (`bun install`, `npm ci`, …) in each worktree before a job that runs tests.
- **Review before merging:** `git -C <worktree> diff HEAD` shows exactly what the harness did. Read it; the harness's own summary is not the diff.
- **Merge, then clean up:** commit in the worktree, `git merge sdd/<task>-codex` (or cherry-pick) from the main tree, then `git worktree remove <path>` and `git branch -d sdd/<task>-codex`. A forgotten worktree keeps its branch checked out and blocks deleting it.
- **Reviews and images don't need worktrees.** Readers can share the tree; only writers need isolating.

## 3. Ensemble review, ranked

`codex`, `grok`, `kimi`, `qwen` and `mistral` share one output contract (`VERDICT:` + `## Findings`) and come from five vendors with different blind spots. Five reviews are only useful if the result is one ranked list, not five piles. This recipe makes that list.

**Step 1: fan out.** Run recipe 1 first. `check_adapter` any roster member you haven't used this session (a missing env key fails instantly). Then dispatch every available reviewer in ONE turn with the same prompt, and ask for a fixed finding format so the outputs can be merged:

```
Review <diff range or files> for correctness and security defects. Do not edit any file.
Under ## Findings, one finding per line, exactly:
- [critical|high|medium|low] path:line: <one-sentence claim>
```

**Step 2: cluster.** Read every result. Two findings are one cluster when they name the same file, lines within about 5 of each other, and the same defect. For each cluster record: the claim, `k` (how many reviewers raised it), `n` (how many reviewed), and the reviewers' severities.

**Step 3: rank.** Order the clusters by:

1. **Agreement `k`, high to low.** Independent vendors converging on one line is the strongest signal this recipe has.
2. **Reviewer severity, high to low** (the highest severity any reviewer gave). This is the signal that measured best in tellme: the reviewer's own severity ranked real findings at AUC 0.74 (AUC 0.5 is a coin flip).
3. **Jev, as a tie-breaker only** (step 4, optional).

**Step 4 (optional): ask Jev, as an experiment.** Write one request with an item per cluster and dispatch `jev`:

```json
{
  "questions": {
    "real": {"type": "boolean",
      "instructions": "Considering the finding and the code, is it a genuine defect rather than a false alarm?",
      "criteria": {"true": "A reviewer who traced the code would agree this is a real defect.",
                   "false": "On inspection the code is fine; the finding is a false alarm."}},
    "severity": {"type": "score",
      "instructions": "How severe would this be in production if it is real?",
      "criteria": ["Low: unlikely to matter.", "Medium: wrong results in an edge case.",
                   "High: likely data loss, outage, or security impact.",
                   "Critical: exploitable or certain to corrupt data."]}
  },
  "items": [
    {"id": "c1", "state": "Raised independently by 3 of 5 reviewers (codex, grok, qwen).\nClaims:\n- [high] codex: ...\n- [high] grok: ...\n- [medium] qwen: ...\n\nCode (path:40-80):\n<the hunk>"}
  ]
}
```

`dispatch(adapter:"jev", prompt:"<request path>", outputPath:"<results path>")`. Use `real` to order clusters that tie on agreement and severity. Nothing more.

**What's measured and what's a bet:**

- **Measured, and against Jev:** judging whether another model's finding is true scored AUC 0.54–0.64 in tellme, below the reviewer's own severity (0.74). That held with the reader's report attached, with the whole file attached, and with a 9-question panel. So Jev never outranks agreement or severity here.
- **The untested angle:** tellme's Jev never saw several vendors agreeing. Putting `k of n` and every reviewer's wording into the state is new. It might help; nobody has measured it.
- **Raw probabilities are uncalibrated** (tellme ECE 0.16 on the defect question). Order by them; never act on "above 0.9".

**Step 5: verify, and record the label.** Claude reads the code for the top clusters and marks each one confirmed or rejected. That verdict is free ground truth. If you ran step 4, append one line per verified cluster to `~/.local/state/sdd/ensemble-labels.jsonl`:

```json
{"date": "2026-10-29", "repo": "sdd", "cluster": "c1", "k": 3, "n": 5, "reviewerSeverity": "high", "jevReal": 0.91, "jevSeverity": 2.4, "provider": "typesafe-ai", "verdict": "confirmed"}
```

After about 100 labels, compare how well `k`, reviewer severity and `jevReal` each separate confirmed from rejected. That answers whether Jev earns a higher slot in step 3, with your own data instead of tellme's.

## 4. Repo-scale targeting with Jev

When there is more code than any reader can get through (an audit of a whole repo, a vendored dependency, an unfamiliar codebase), let Jev rank every routine and send the reviewers only the top slice.

1. **Make items.** One item per function if you can extract them (ast-grep, a language's own AST tool); otherwise one per file, splitting anything over 120,000 characters. Include the path in each state.
2. **Ask the measured question, verbatim:**

```json
{"questions": {"defect": {"type": "boolean",
  "instructions": "Does this routine contain a security defect a careful reviewer would flag?",
  "criteria": {"true": "A careful reviewer would flag a security defect here.",
               "false": "A careful reviewer would find no security defect here."}}},
 "items": [{"id": "pkg/auth.go:Verify", "state": "// pkg/auth.go\nfunc Verify(...) {...}"}],
 "maxItems": 5000}
```

3. **Rank by `defect` probability and take the top 20–30%.** Hand those files to the review roster (recipe 3) or read them yourself.
4. **Cost:** about $0.042 per million input tokens. Two thousand routines of about 500 tokens each cost about $0.04.

**What's measured:**

- **Per routine:** AUC 0.84 on 125 held-out advisories from 125 repos, Go and Python. 66% of the vulnerable routines landed in the top 20%, and 80% in the top 30% (tellme). claude-haiku-5-5 asked the same question scored 0.87, so Jev is the cheaper and faster ranker here, not the smarter one.
- **Per file is an extrapolation.** It was measured on routines. A file-level rank is plausible but unmeasured.

**Where it must not be used:**

- **Never prune inside a file for a PR review.** Sending a reader only Jev's top routines per file cut recall from 71% to 47% in tellme and saved no wall time. For a PR, read the whole diff. Jev ranks which files to read across a repository; it doesn't decide what to skip in one.
- **Never threshold.** Rank only (see recipe 3).
- **Every state leaves the machine** (TypeSafe through Vercel). Don't rank code you can't send out.
