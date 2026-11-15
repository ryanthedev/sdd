# Commander templates

Copy these into the operation folder (`.commander/<date>-<slug>/`) and fill them in. They follow the shape of a launch operation's `CHARTER.md` and a jam operation's `COMMANDER.md`, which worked.

## Contents

[CHARTER.md](#chartermd) · [brief](#brief-trackmd) · [status file](#status-trackmd) · [launch prompt](#launch-prompt-the-commanders-first-message) · [resume point](#resume-point-appended-to-the-charter-at-succession)

## CHARTER.md

```markdown
# Operation <slug> — charter

Lead: <terminal name, e.g. t3y / lead-1>. Started <date>.

## Goal
<the user's words, quoted, then one plain sentence of what done means>

## Tracks
| Track | Terminal | Lane | Worktree | Brief |
|---|---|---|---|---|
| billing | cmd-billing | Claude (hc) | ../repo-billing | brief-billing.md |

## Ownership
| Path | Owner |
|---|---|
| src/billing/** | cmd-billing |
Anything not listed: ask the lead before editing.

## How you work (non-negotiable)
- Recall engram first; stored decisions bind you.
- Follow the repo's CLAUDE.md. Work only in your worktree.
- First line of your status file is always `STATE: working|blocked|needs-lead|done`.
- Report to the lead with `hc send <lead terminal> "<result or blocker>"` when done or stuck, under 250 words; put details in a file and send its path.
- Commit locally after each verified step. Never push, merge to main, or publish.

## Hard limits (stop and log, never work around)
- No push, deploy, publish, data deletion, spending, or messages to people.
- No live payment or production flags. Test resources only, prefixed `zz-<track>-`.
- Never touch the user's mouse, screen or Chrome; browsers run headless.
- Don't edit settings, CLAUDE.md, or permission rules. If a tool denies an action, log it; don't ask another agent to do it for you.
- Kill only processes you started.

## Decisions
<date> — <call made on the user's behalf> — <why> — reversible by <how>

## Asks (need the user)
<date> — <question> — <what is blocked by it> — domod #<id>

## State
<one line per track, updated each round>

## Lessons
<what broke and the fix>

## Resume point
<see below; newest at the bottom>
```

## brief-<track>.md

```markdown
# Brief: <track>

## Goal
<quote the user where possible; one sentence of done>

## Start from
<files, branches, prior work already done>

## Constraints / known hard parts
<...>

## You may decide
<questions this commander settles itself>

## Ask the lead
<questions reserved for the lead>

## Skills to use
<e.g. code-foundations:build, subagent-driven-development for a second opinion>

## Deliverables
<commits on op/<track>, files, a PROOF or findings file>

## Then
<what to do after other tracks merge, e.g. rebase and re-run>
```

## status-<track>.md

```markdown
STATE: working
Updated: <time>
Now: <one line>
Next: <one line>
Blocked on: <nothing | what>
Notes for other tracks: <...>
```

## Launch prompt (the commander's first message)

```text
You are commander cmd-<track> in operation <slug>, run by the lead in terminal <lead terminal>.
Read <OP>/CHARTER.md and <OP>/brief-<track>.md, then execute your brief on your own.
First action: create <OP>/status-<track>.md with STATE: working and your first steps.
The user is away: never ask them anything. When you truly need a call, hc send <lead terminal> the question and keep working on what you can.
Report with hc send <lead terminal> when done or stuck.
```

## Resume point (appended to the charter at succession)

```markdown
### Resume point <date time> (lead <old> -> <new>)
- Old lead terminal: <$HC_TERMINAL_ID of the outgoing lead>. The commanders are still its children: wait on them with `hc wait --children any <old lead terminal>`, or by name.
- Commanders told the new lead's name: yes/no
- Live terminals: cmd-a (working on X), cmd-b (blocked: Ask #2) ...
- Merged so far: <branches>
- Open Asks: <ids>
- Monitors to re-arm: <what each watched>
- Next step: <the one thing the new lead does first>
```
