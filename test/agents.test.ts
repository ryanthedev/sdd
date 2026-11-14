import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function frontmatter(file: string): { fm: Record<string, string>; body: string } {
  const text = readFileSync(join(root, "agents", file), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: no frontmatter`);
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: m[2]! };
}

for (const [file, name] of [
  ["codex-builder.md", "codex-builder"],
  ["codex-reviewer.md", "codex-reviewer"],
] as const) {
  test(`agent ${name} has valid frontmatter and the sdd procedure`, () => {
    const { fm, body } = frontmatter(file);
    expect(fm.name).toBe(name);
    expect(fm.description!.length).toBeGreaterThan(40);
    expect(fm.model).toBe("sonnet");
    expect(fm.tools).toBeUndefined(); // inherit all, incl. mcp__plugin_sdd_sdd__*
    for (const tool of ["usage", "dispatch", "wait", "result"]) {
      expect(body).toContain(`mcp__plugin_sdd_sdd__${tool}`);
    }
    expect(body).toContain("git rev-parse HEAD");
    expect(body).toContain("git status --porcelain");
  });
}

test("plugin.json version is 0.8.0", () => {
  const v = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8")).version;
  expect(v).toBe("0.8.0");
});
