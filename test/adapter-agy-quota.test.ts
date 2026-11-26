/**
 * agy quota wall: fixtures are verbatim lines from real sdd job logs
 * (2026-11-26, agy 1.5.x, exit 3). Before this, the wall was misreported as a
 * missing AGY_RESULT marker / flag-order misparse.
 */
import { expect, test } from "bun:test";
import { agyQuotaError, agyQuotaSummary } from "../src/adapters/_agy-shared.ts";
import * as agy from "../src/adapters/agy.ts";
import * as agyImage from "../src/adapters/_agy-image.ts";
import * as agyVision from "../src/adapters/_agy-vision.ts";

const THIRD_PARTY =
  "error: Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 3h8m40s.\n" +
  'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 3h8m40s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"526b32f0-f097-4aae-a9be-88f3dab9fd77-1"}\n';
const INDIVIDUAL =
  "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h24m41s.\n" +
  'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h24m41s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"32b2d895-b7a4-4413-a7ca-9387daac34cd-1"}\n';

test("third-party quota: scope and reset parsed (stderr)", () => {
  expect(agyQuotaError("", THIRD_PARTY, 3)).toEqual({
    scope: "third-party",
    resetsIn: "3h8m40s",
    message: expect.stringContaining("Third-party quota reached") as unknown as string,
  });
});

test("individual quota: scope and reset parsed (stdout)", () => {
  const q = agyQuotaError(INDIVIDUAL, "", 3);
  expect(q?.scope).toBe("individual");
  expect(q?.resetsIn).toBe("1h24m41s");
});

test("exit 0 is never a quota wall", () => {
  expect(agyQuotaError(THIRD_PARTY, THIRD_PARTY, 0)).toBeUndefined();
});

test("a quoted AGY_ERROR mid-line does not count", () => {
  const quoted = 'The log said AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}\n';
  expect(agyQuotaError(quoted, "", 1)).toBeUndefined();
});

test("a non-quota AGY_ERROR does not count", () => {
  const other = 'AGY_ERROR: {"short_error":"INTERNAL (code 500): boom","status":"INTERNAL","error_code":500}\n';
  expect(agyQuotaError("", other, 1)).toBeUndefined();
});

test("summary leads with the stable token and names the fallback", () => {
  const s = agyQuotaSummary("agy", { scope: "third-party", resetsIn: "3h8m40s", message: "" });
  expect(s.startsWith("agy: QUOTA_EXHAUSTED scope=third-party resets_in=3h8m40s.")).toBe(true);
  expect(s).toContain("claude adapter");
  expect(s.length).toBeLessThanOrEqual(300);
});

test("default kind reports QUOTA_EXHAUSTED instead of a missing marker", () => {
  const r = agy.parseResult("", THIRD_PARTY, 3);
  expect(r.status).toBe("failed");
  expect(r.summary).toStartWith("agy: QUOTA_EXHAUSTED scope=third-party");
  expect(r.summary).not.toContain("missing AGY_RESULT");
});

test("default kind: a real result marker wins over a stray quota line", () => {
  const r = agy.parseResult(THIRD_PARTY + "AGY_RESULT: DONE\n", "", 0);
  expect(r.status).toBe("done");
});

test("vision and image kinds report the quota wall too", () => {
  expect(agyVision.parseResult("", INDIVIDUAL, 3).summary).toStartWith("agy-vision: QUOTA_EXHAUSTED scope=individual");
  expect(agyImage.parseResult("", INDIVIDUAL, 3).summary).toStartWith("agy-image: QUOTA_EXHAUSTED scope=individual");
});
