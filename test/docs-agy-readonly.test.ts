import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const lines = (p: string) => read(p).split("\n");

const SKILL = "skills/subagent-driven-development/SKILL.md";
const HARN = "skills/subagent-driven-development/references/harnesses.md";

test("DW-2.1 every agy readOnly mention states the exact-path limit", () => {
  // [file, anchor identifying the agy readOnly mention]; the anchored line must carry the limit.
  const sites: [string, string][] = [
    [SKILL, "`agy` (`--sandbox --mode plan` plus a deny list)"],
    [SKILL, "`opts.readOnly: true` runs agy"],
    [HARN, "`agy` (`--sandbox --mode plan` plus a deny list"],
    [HARN, "| `agy` | General review/implement harness"],
    ["README.md", "enforced natively on `claude`"],
    ["README.md", "| | `agy` | Review / implement."],
  ];
  for (const [p, anchor] of sites) {
    const hit = lines(p).find((l) => l.includes(anchor));
    expect(hit, `${p}: ${anchor}`).toBeDefined();
    expect(/exact path|named files|name the exact files/.test(hit!)).toBe(true);
  }
  // SKILL's agy gotcha states the limit on its bullets below the anchor line.
  expect(read(SKILL)).toContain("It reads files by exact path only.");
  expect(read("src/tools/dispatch.ts")).toContain("agy readOnly reads files by exact path only");
});

test("DW-2.1 recipes tells readers to paste the diff", () => {
  expect(read("skills/subagent-driven-development/references/recipes.md")).toContain("paste the diff");
});

test("DW-2.1 no 'structurally preventing writes' or 'exits 0 cleanly' claims remain", () => {
  for (const p of ["README.md", SKILL, HARN, "src/tools/dispatch.ts", "src/adapters/agy.ts"]) {
    expect(read(p)).not.toMatch(/structurally preventing writes|exits 0 cleanly/);
  }
});

test("DW-2.2 SKILL agy gotcha: denied, unverified, artifacts, caveats, stamp", () => {
  const s = read(SKILL);
  for (const t of ["`command`", "`write_file`", "`mcp`", "`unsandboxed`", "`search_web`", "`list_resources`/`read_resource`",
    "brain/", "--dangerously-skip-permissions", "starts at HEAD", "agy 1.5.14", "2026-11-22", "paste the diff"]) {
    expect(s).toContain(t);
  }
});

test("no agy readOnly site claims web access is denied (search_web is unverified)", () => {
  for (const p of ["README.md", SKILL, HARN, "src/tools/dispatch.ts", "skills/subagent-driven-development/references/recipes.md"]) {
    expect(read(p)).not.toMatch(/(MCP|writes)(,| and| or) (and |or )?web\b/i);
  }
});

test("no agy readOnly site says reads are limited to files named in the prompt", () => {
  for (const p of ["README.md", SKILL, HARN, "src/tools/dispatch.ts", "skills/subagent-driven-development/references/recipes.md"]) {
    const text = read(p);
    expect(text).not.toMatch(/named in the prompt/i);
    expect(text).not.toMatch(/named files[^.|;]{0,20}only/i);
    expect(text).not.toMatch(/only read files named/i);
  }
});

test("SKILL failure summaries list every agy.ts prefix", () => {
  const s = read(SKILL);
  for (const t of ["agy: stopped with no verdict", "agy: missing AGY_RESULT marker", "agy: exited with code N", "agy: reported FAILED: <cause>", "bare `agy: reported FAILED`"]) {
    expect(s).toContain(t);
  }
  expect(s).not.toContain("a tool outside the deny list defaulted");
});

test("agy's missing listing/search tool is attributed to agy, not stated as enforced", () => {
  for (const p of ["README.md", SKILL, HARN]) expect(read(p)).not.toMatch(/with no listing or search|exact path only, no listing or search/);
  expect(read(SKILL)).toContain("not enforced by a deny rule");
  expect(read(SKILL)).toContain("Every deny-listed permission");
});
