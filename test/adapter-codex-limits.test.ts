/**
 * codex account-limits capability — pure-function unit tests for `parseLimits`
 * plus the stderr-echo strip in `parseResult`. No spawn, no real `codex`.
 *
 * REAL_PAYLOAD below is a verbatim capture of a live
 * `account/rateLimits/read` response from codex-cli 0.144.1 (numbers only —
 * nothing account-identifying). It is the regression anchor: if codex changes
 * its payload shape, this is the test that notices.
 */
import { expect, test } from "bun:test";
import * as codex from "../src/adapters/codex.ts";

const bucket = (over: Record<string, unknown> = {}) => ({
  limitId: "codex",
  limitName: null,
  primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1785081793 },
  secondary: null,
  credits: { hasCredits: false, unlimited: false, balance: "0" },
  individualLimit: null,
  planType: "plus",
  rateLimitReachedType: null,
  ...over,
});

const REAL_PAYLOAD = {
  rateLimits: bucket(),
  rateLimitsByLimitId: {
    codex: bucket(),
    codex_bengalfox: bucket({
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1785210557 },
      credits: null,
    }),
  },
  rateLimitResetCredits: { availableCount: 3, credits: [] },
};

const parse = codex.parseLimits;

test("readLimits declares the verified app-server probe", () => {
  expect(codex.readLimits).toEqual({
    transport: "app-server-jsonrpc",
    binary: "codex",
    args: ["app-server"],
    method: "account/rateLimits/read",
  });
});

test("parseLimits maps the real multi-bucket payload", () => {
  const s = parse(REAL_PAYLOAD);
  expect(s.plan).toBe("plus");
  expect(s.limitReached).toBeNull();
  expect(s.credits).toEqual({ hasCredits: false, unlimited: false, balance: "0" });
  expect(s.windows).toEqual([
    { name: "codex", usedPercent: 1, windowMinutes: 10080, resetsAt: 1785081793 },
    { name: "GPT-5.3-Codex-Spark", usedPercent: 0, windowMinutes: 10080, resetsAt: 1785210557 },
  ]);
});

test("parseLimits prefers the per-model map but falls back to the single bucket", () => {
  const s = parse({ rateLimits: bucket() });
  expect(s.windows).toHaveLength(1);
  expect(s.windows[0]?.name).toBe("codex");
  expect(s.plan).toBe("plus");
});

test("parseLimits emits a secondary window when the harness reports one", () => {
  const s = parse({
    rateLimits: bucket({ secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 123 } }),
  });
  expect(s.windows.map((w) => w.name)).toEqual(["codex", "codex (secondary)"]);
  expect(s.windows[1]?.usedPercent).toBe(40);
});

test("parseLimits surfaces a currently-exceeded limit", () => {
  const s = parse({ rateLimits: bucket({ rateLimitReachedType: "rate_limit_reached" }) });
  expect(s.limitReached).toBe("rate_limit_reached");
});

test("parseLimits finds a reached limit on ANY bucket, not just the first", () => {
  const s = parse({
    rateLimits: bucket(),
    rateLimitsByLimitId: {
      codex: bucket(),
      other: bucket({ limitId: "other", rateLimitReachedType: "workspace_member_usage_limit_reached" }),
    },
  });
  expect(s.limitReached).toBe("workspace_member_usage_limit_reached");
});

test("parseLimits surfaces redeemable reset credits from the real payload", () => {
  // REGRESSION: this field sat in REAL_PAYLOAD from the day the fixture was
  // captured, and parseLimits walked straight past it — so `usage` never
  // reported what codex's own TUI prints as "You have 3 usage limit resets
  // available. Run /usage to use one."
  const s = parse(REAL_PAYLOAD);
  expect(s.resetCredits).toEqual({ availableCount: 3, entries: [] });
});

test("an empty credits array does NOT mean zero resets available", () => {
  // The live payload really does send availableCount:3 with credits:[]. Reading
  // "none available" off the empty array would under-report the account.
  const s = parse({ ...REAL_PAYLOAD, rateLimitResetCredits: { availableCount: 3, credits: [] } });
  expect(s.resetCredits?.availableCount).toBe(3);
});

test("parseLimits keeps per-grant reset-credit detail when the harness sends it", () => {
  const s = parse({
    rateLimits: bucket(),
    rateLimitResetCredits: {
      availableCount: 1,
      credits: [{ id: "rc_1", status: "available", title: "Full reset", expiresAt: "2026-08-01" }],
    },
  });
  expect(s.resetCredits?.entries).toEqual([
    { id: "rc_1", status: "available", title: "Full reset", expiresAt: "2026-08-01" },
  ]);
});

test("parseLimits reports no reset credits as null, not a zero count", () => {
  expect(parse({ rateLimits: bucket() }).resetCredits).toBeNull();
});

test("parseLimits surfaces a spend-control limit from whichever bucket carries it", () => {
  const s = parse({
    rateLimitsByLimitId: {
      codex: bucket(),
      other: bucket({
        individualLimit: { limit: "100", remainingPercent: 42, resetsAt: 1785081793, used: "58" },
      }),
    },
  });
  expect(s.individualLimit).toEqual({
    limit: "100",
    remainingPercent: 42,
    resetsAt: 1785081793,
    used: "58",
  });
});

test("an unreported spendControlReached stays null and never collapses to false", () => {
  // null ("the payload never said") must not read as false ("said, and fine").
  expect(parse(REAL_PAYLOAD).spendControlReached).toBeNull();
  expect(parse({ rateLimits: bucket({ spendControlReached: false }) }).spendControlReached).toBe(false);
  expect(parse({ rateLimits: bucket({ spendControlReached: true }) }).spendControlReached).toBe(true);
});

test("parseLimits degrades on a malformed reset-credits block instead of throwing", () => {
  expect(parse({ rateLimits: bucket(), rateLimitResetCredits: "nonsense" }).resetCredits).toBeNull();
  expect(parse({ rateLimits: bucket(), rateLimitResetCredits: { credits: "nope" } }).resetCredits).toBeNull();
  const partial = parse({ rateLimits: bucket(), rateLimitResetCredits: { availableCount: 2, credits: [null, 7] } });
  expect(partial.resetCredits).toEqual({ availableCount: 2, entries: [] });
});

test("parseLimits drops a window with no usedPercent rather than reporting 0%", () => {
  // Reporting an unquantifiable window as 0% would read as "plenty left".
  const s = parse({ rateLimits: bucket({ primary: { windowDurationMins: 10080 } }) });
  expect(s.windows).toEqual([]);
});

test("parseLimits keeps a window whose length/reset are unreported", () => {
  const s = parse({ rateLimits: bucket({ primary: { usedPercent: 55 } }) });
  expect(s.windows).toEqual([{ name: "codex", usedPercent: 55, windowMinutes: null, resetsAt: null }]);
});

// A plain loop, not test.each: each() SPREADS an array case as arguments, so a
// `[]` case would call the callback with zero args and bun would mistake the
// declared parameter for a done-callback.
const JUNK: unknown[] = [null, undefined, 42, "nope", [], {}, { rateLimits: null }, { rateLimits: { primary: "x" } }];
for (const payload of JUNK) {
  test(`parseLimits degrades instead of throwing on junk payload ${JSON.stringify(payload) ?? "undefined"}`, () => {
    const s = parse(payload);
    expect(s.windows).toEqual([]);
    expect(s.plan).toBeNull();
    expect(s.credits).toBeNull();
    expect(s.limitReached).toBeNull();
  });
}

/**
 * codex echoes the prompt it was handed — including our injected contract
 * suffix — onto stderr before running. The bounded failure tail must skip that
 * echo, or the summary opens mid-sentence with our own instruction text and
 * spends its budget before reaching the real error.
 */
test("failure summary skips codex's echo of the injected contract", () => {
  const echoed = codex.injectContract("review this diff");
  const stderr = `${echoed}\nERROR: {"status":400,"message":"model not supported"}`;
  const r = codex.parseResult("", stderr, 1);

  expect(r.status).toBe("failed");
  expect(r.summary).toContain("model not supported");
  expect(r.summary).not.toContain("-line verdict");
  expect(r.summary).not.toContain("## Findings");
});

test("failure summary is unchanged when stderr carries no echo", () => {
  const r = codex.parseResult("", "boom: something broke", 1);
  expect(r.summary).toBe("codex exited 1: boom: something broke");
});

test("the line-boundary trim applies when it is cheap", () => {
  // Dropping the partial first line still leaves most of the window, so the
  // summary gets to start cleanly.
  const stderr = "x".repeat(900) + "\n" + "real error detail ".repeat(30);
  const summary = codex.parseResult("", stderr, 1).summary;
  expect(summary).toContain("real error detail");
  expect(summary).not.toContain("xxx");
});

/**
 * Tidiness must never cost content. One very long error line followed by a short
 * one is indistinguishable from noise-then-error, so the tie breaks toward
 * KEEPING text: a summary that starts mid-word but carries the diagnostic beats
 * a clean one that threw it away.
 */
test("a long error line is not discarded to make the summary start cleanly", () => {
  const stderr = "E".repeat(700) + "\nDone.";
  const summary = codex.parseResult("", stderr, 1).summary;
  expect(summary).toContain("EEE");
  expect(summary).toContain("Done.");
});

/**
 * codex normally echoes BEFORE it errors, so the strip is safe — but if the
 * ordering is ever reversed, stripping must not leave an empty summary and lose
 * the only diagnostic there was.
 */
test("an error that precedes the echo is still surfaced, not stripped away", () => {
  const stderr = `ERROR: auth token expired, run 'codex login'\n${codex.injectContract("go")}`;
  const summary = codex.parseResult("", stderr, 1).summary;
  expect(summary).toContain("auth token expired");
});

test("the git-repo refusal still wins over the stderr tail", () => {
  const stderr = `${codex.injectContract("go")}\nNot inside a trusted directory and --skip-git-repo-check was not specified`;
  expect(codex.parseResult("", stderr, 1).summary).toContain("not a git repository");
});
