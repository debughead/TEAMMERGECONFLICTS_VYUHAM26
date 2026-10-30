// Probe: does checking an uploaded pattern return at all? Overlapping alternatives under a repeat,
// like (\w|\d)+, backtrack exponentially on the guard's own probe text ("111…x").
// Exit code 0: the guard returned and refused the pattern. Non-zero: it accepted it. Killed: it froze.
import { expect, it } from "vitest";
import { compileSafe } from "../../src/compliance/safeRegex.ts";

it("probe", () => {
  expect(compileSafe(process.env.PROBE_PATTERN ?? "(\\w|\\d)+!").ok).toBe(false);
});
