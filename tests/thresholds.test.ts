import { describe, expect, test } from "bun:test";
import { type ContextStatus, getStatusLabel, THRESHOLDS } from "../src/context/thresholds";

describe("thresholds", () => {
  test("THRESHOLDS constants", () => {
    expect(THRESHOLDS.yellow).toBe(70);
    expect(THRESHOLDS.red).toBe(85);
    expect(THRESHOLDS.critical).toBe(92);
  });

  test("getStatusLabel returns correct status", () => {
    expect(getStatusLabel(0)).toBe("green");
    expect(getStatusLabel(50)).toBe("green");
    expect(getStatusLabel(69)).toBe("green");
    expect(getStatusLabel(70)).toBe("yellow");
    expect(getStatusLabel(75)).toBe("yellow");
    expect(getStatusLabel(84)).toBe("yellow");
    expect(getStatusLabel(85)).toBe("red");
    expect(getStatusLabel(90)).toBe("red");
    expect(getStatusLabel(91)).toBe("red");
    expect(getStatusLabel(92)).toBe("critical");
    expect(getStatusLabel(99)).toBe("critical");
    expect(getStatusLabel(100)).toBe("critical");
  });

  test("ContextStatus type accepts all valid values", () => {
    const statuses: ContextStatus[] = ["green", "yellow", "red", "critical"];
    for (const s of statuses) {
      expect(typeof s).toBe("string");
    }
  });
});
