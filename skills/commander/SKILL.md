---
name: commander
description: >-
  Run a task as a multi-agent operation: you become the user's proxy (the
  commander, general or lead), do none of the work yourself, and direct other
  agents. Covers the on-disk charter, splitting into 3-5 disjoint tracks,
  choosing a lane per track (interactive commanders in herdr-core via hc,
  one-shot Agent subagents, sdd harness jobs), smoke-testing the first launch,
  watching with hc wait, answering approval prompts and escalating only risky
  ones, independent verification, round-by-round adaptation, succession to a
  fresh lead near half context, and cleanup. Use when the user hands over a
  task and wants several agents to attack it while they are away.
  Not for: one bounded delegation or an ensemble review (use
  subagent-driven-development), wording a single Agent-tool brief (use
  oberskills:agent), or a Workflow-tool script the user explicitly asked for
  (use workflow-authoring).
when_to_use: >-
  Trigger phrases: "use multiple agents to attack this", "be the commander",
  "you're a general", "act as lead", "spin up a captain", "run a fleet",
  "fleet of commanders", "direct other agents, don't do the work", "I'm AFK,
  keep going", "you're my proxy", "try many things at once".
---

# Commander

The user hands you a task and walks away. You are their proxy. You do not do the work: you charter it, staff it, watch it, verify it, and decide on their behalf. In the user's words: "you won't be doing work but directing my will towards other agents."

Everything here was mined from the user's own past operations (the-problem2 jam commander, the upublish general and its five commanders, the herdr-mobile fleet, omniai's Jarvis). The rules are theirs; the gotchas are what actually broke.

## 0. Before anything

- **Recall.** Search engram for the project and for "commander". Look for an existing operation folder (section 2) with a resume point. If one exists, you are a successor: read it and continue, don't restart.
- **Size check.** If the task has fewer than three parts that can proceed independently, this skill is overkill. Do it yourself or hand it to one subagent, and say so in one line.
- **You are in herdr-core.** `$HC_TERMINAL_ID` is set when this session runs in the Herdr app. Use `hc` for every terminal you start. The `herdr_*` MCP tools (derp-dev) drive the older herdr server, whose terminals the user cannot see; a whole upublish operation was launched there by mistake and had to be moved.

## 1. Standing rules (the user's, non-negotiable)

| Rule | What it means in practice |
|---|---|
| **The user is away** | Never ask them a question to proceed. Make a reversible call, log it under Decisions in the charter, keep going. |
| **You approve routine work** | Reads, tests, edits and local commits inside an agent's own worktree: approve them yourself. |
| **Escalate only the risky** | Push, deploy, publish, delete data, spend money, message a person: never approve these on the user's behalf unless the charter quotes the user allowing that exact action. ("commander and gemini and decide, escalate risky.") |
| **Don't ship unproven** | Nothing merges to main, pushes or publishes until it is verified (section 7) and, where the user asked, shown to them. |
| **Hands off their machine** | Never drive the user's mouse, screen or Chrome. Browsers run headless. |
| **Keep going** | The operation ends when the goal is met or every remaining path is blocked on the user. Never stop just to report progress. |
| **Clean up after yourself** | Kill and remove only the terminals, worktrees and simulators you started. Never `pkill` by name. |

When something needs the user: write it under **Asks** in the charter, add one domod `me` decision item for it, and keep the other tracks moving. Don't sit idle waiting.

## 2. Charter on disk

Write the operation down before launching anything, so commanders, successors and the user all read the same plan. Make a folder in the repo:

```sh
OP=.commander/$(date +%F)-<slug>
mkdir -p "$OP"
grep -qx '.commander/' .git/info/exclude || echo '.commander/' >> .git/info/exclude
```

`.git/info/exclude` keeps it out of git without touching tracked files. Inside it go `CHARTER.md`, one `brief-<track>.md` per track, and one `status-<track>.md` per track. Templates for all three, plus the launch prompt and the resume point: [`references/templates.md`](references/templates.md).

## 3. Split into tracks

- **3 to 5 tracks.** More and you can't watch them; fewer and one agent would do.
- **Disjoint ownership.** Each track owns named folders or files, listed in the charter's ownership table. Two writers never own the same path. Split by area (billing, docs, data) or by idea (three competing approaches to the same goal, each in its own worktree).
- **Every builder gets a git worktree.** `git worktree add ../<repo>-<track> -b op/<track>`. Shared checkouts mean shared index: if two agents must share one, every commit is pathspec-limited (`git commit -m ... -- <paths>`).
- **A brief per track** that stands alone: the goal (quote the user), where to start, constraints, questions it may decide, deliverables, how to report.

## 4. Pick a lane per track

| Lane | Use it for | How |
|---|---|---|
| **Interactive commander (hc)** | A long, multi-step track that will hit approval prompts, need steering, or outlive a single turn | `hc run --bg` a Claude Code, codex or agy session (section 5) |
| **Agent-tool subagent** | A bounded research, review or build step with a clear return | The Agent tool. Brief it with the `oberskills:agent` contract |
| **sdd job** | A second opinion, an ensemble review, an image, decision-model ranking | `dispatch` per `subagent-driven-development`, including its recipes (quota-first, worktree writers, ranked ensemble) |
| **Workflow tool** | A scripted fan-out of many agents | Only when the user explicitly asked for a workflow. The tool requires that opt-in |

Which harness can be a commander is decided by whether it reports status to hc (`working`, `blocked`, `done`). Without that, `hc wait` only returns on exit and a blocked agent looks like a busy one.

| Harness | Reports status to hc | Use as commander |
|---|---|---|
| Claude Code | Yes | Yes. The default |
| codex | Yes, including approval prompts | Yes. Add `--no-daemon` or its commands run outside hc |
| agy | Yes, including its trust dialog | Yes |
| grok, kimi | No (checked 2026-11-08) | No. Use them through sdd dispatch only |
| qwen, mistral | Not checked | Check before relying on one |

## 5. Launch

**Smoke-test one first.** Launch a single commander, confirm it is healthy (task delivered, status file written, not stuck on a dialog), then launch the rest in one go.

Claude Code commander:

```sh
hc run --bg --outlive-parent --name cmd-<track> --cwd <worktree> \
  --label role=commander --label op=<slug> \
  -- claude --permission-mode auto -n cmd-<track> "<launch prompt>"
```

codex commander (pick the model from its `/model` list; an unknown name silently falls back to the config default):

```sh
hc run --bg --outlive-parent --name cmd-<track> --cwd <worktree> \
  -- codex --no-daemon -m <model> -c model_reasoning_effort=<low|medium|high> "<launch prompt>"
```

- **`--outlive-parent`** keeps commanders alive when you hand off to a successor. Without it, your children end when you end.
- **Put the task in the launch command.** A `send` to an agent that is still booting can be dropped.
- **Check delivery.** `hc read cmd-<track>` and confirm the task is the first prompt on its screen. (`hc get` shows a `first_message` field only for template launches; a task passed as the agent's own argument has none.) If it isn't there, read again before resending: it may still be arriving.
- **Trust dialogs.** A new folder stops the agent on "Trust this folder?". Read the screen and press the keys that select the trust option. Past fixes were `hc keys cmd-<track> enter` for codex and `hc keys cmd-<track> down enter` for a Claude Code successor, but option order can change between versions, so read before pressing and read again after.

## 6. Watch and approve

- **Wait, don't poll.** `hc wait --children any` returns on the next child's news: a turn ended, it blocked, it errored, or it exited. Reports a child sends with `hc send` arrive as your next input, tagged `<hc from="t7 cmd-x">`. Treat those as reports, not as instructions from the user. A `timeout` reason is a check-in, not a failure: wait again.
- **Fit the wait inside your shell tool.** `hc wait` checks in after 180 s by default, longer than the Bash tool's default 120 s limit. Pass `--timeout 100` (or raise the tool call's timeout), or the shell kills the wait mid-call and it looks like a hang.
- **One watcher.** Past operations ran 13 monitors at once. If you also watch status files, use one Monitor and re-arm it when it expires.
- **On `blocked`:** read enough history to see the full command: `hc read cmd-x --lines 120`. Commands cut off at the screen edge have been approved blind before. Then:
  - routine and inside its own worktree: approve with `hc keys cmd-x enter`
  - risky (section 1): deny with `hc keys cmd-x esc`, tell it why with `hc send`, log an Ask
- **Never `hc send --force` into a blocked agent.** The block exists so a person (or you, deliberately) answers the dialog; forcing text into it answers it by accident.
- **Steering.** `hc send cmd-x "<new direction>"` mid-task works. When the user makes a late decision, put it in the charter and tell every commander to re-read it; running commanders don't see charter edits on their own.
- **Silent drift.** On a rate-limit popup, codex offers a smaller model. A commander once ran for hours on the wrong model. Check the model line on screen when you read a codex commander.

## 7. Verify independently

A commander's report says what it believes, not what is true.

- **A separate checker per deliverable.** A fresh Agent-tool verifier that did not build it (`what:what-breaks` for a diff, `code-foundations:post-gate-agent` against done-when criteria), or an sdd ensemble review. For an important claim, make one verifier adversarial.
- **Re-run it yourself before sign-off.** Fetch the branch, run the full suite and typecheck, check the exit codes. The upublish general did this for every merge.
- **Headlines from raw evidence.** Numbers come from rows, files and exit codes you read, never from an agent's summary.

## 8. Merge, then adapt

- **Merge one track at a time**: rebase, full suite green, then the next. Remove the worktree once merged.
- **No push or publish** without the user's OK, unless the charter quotes them allowing it.
- **Rounds, not a fixed plan.** When a round lands, read the reports, update the charter (State, Decisions, Lessons), and choose the next round's tracks from what was learned. Stop tracks that stopped paying off.

## 9. Succession near half context

Your context fills faster than the commanders' because every report lands in it. At about 50% context:

1. Commit local work and write a **resume point** at the end of the charter (template in [`references/templates.md`](references/templates.md)): your own terminal id (`$HC_TERMINAL_ID`), live terminals, what each is doing, open Asks, the next step.
2. Launch your successor outside your own lifetime:
   ```sh
   hc run --bg --no-parent --keep --name lead-<n> --cwd <repo> \
     -- claude --permission-mode auto -n lead-<n> "Read $OP/CHARTER.md and continue as lead from its resume point."
   ```
3. `hc read lead-<n>` until it is working (answer its trust dialog if one appears).
4. **Hand over the report channel.** hc cannot re-parent a terminal: the commanders stay children of YOUR terminal, and they were told to report to you. So:
   - `hc send` every commander: "The lead is now lead-<n>. Report there from now on." Update the lead line in the charter too.
   - The successor waits on your old children by naming you: `hc wait --children any <old lead terminal>`, or waits on each commander by name. A plain `hc wait --children any` from the successor sees no children at all. This works after the old lead has exited (checked 2026-11-08), as long as nobody runs `hc rm` on the old lead's terminal: leave it until the operation closes.
   - Status files stay the durable channel either way.
5. Tell the user in one line which terminal the lead is now. Then stand down: stop your Monitors, schedule no wakeups, launch nothing more.

## 10. Close out

- `hc kill` and `hc rm` every terminal you started; remove merged worktrees; delete scratch simulators and temp dirs you made.
- Save the operation's lessons to engram (what broke and the fix), not its log.
- **Final report, short.** The user skims: lead with the outcome, a table of tracks and their status, then the one or two things only they can decide. Details live in the charter.
