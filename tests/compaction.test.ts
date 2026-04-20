import { describe, expect, test } from "bun:test";
import { getCompactionPrompt } from "../src/compaction/prompt";

describe("compaction prompt", () => {
  test("returns non-empty string", () => {
    const prompt = getCompactionPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("emphasizes self-continuity, not another agent", () => {
    const prompt = getCompactionPrompt();
    expect(prompt).toContain("yourself");
    expect(prompt).toContain("not another agent");
  });

  test("includes key sections", () => {
    const prompt = getCompactionPrompt();
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Instructions");
    expect(prompt).toContain("## Discoveries");
    expect(prompt).toContain("## Accomplished");
    expect(prompt).toContain("## Relevant files");
    expect(prompt).toContain("## Notes");
  });
});
