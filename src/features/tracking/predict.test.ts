import { describe, it, expect } from "vitest";
import { suggest } from "./predict";

describe("word prediction", () => {
  it("returns frequency-ordered prefix completions", () => {
    const s = suggest("th");
    expect(s.length).toBeGreaterThan(0);
    expect(s.length).toBeLessThanOrEqual(3);
    for (const w of s) expect(w.startsWith("th")).toBe(true);
    // "the" is the most common English word — it must come first for "th".
    expect(s[0]).toBe("the");
  });

  it("is case-insensitive", () => {
    expect(suggest("Th")).toEqual(suggest("th"));
  });

  it("returns nothing for an empty prefix", () => {
    expect(suggest("")).toEqual([]);
  });

  it("returns nothing for an unknown prefix", () => {
    expect(suggest("zzq")).toEqual([]);
  });

  it("caps the number of suggestions", () => {
    expect(suggest("a", 2).length).toBeLessThanOrEqual(2);
  });
});
