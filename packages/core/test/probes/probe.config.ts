// Runs the freeze probes in their own process, so a pattern that never finishes can be killed by the
// parent test's timeout instead of hanging the whole test run.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/probes/**/*.probe.ts"], testTimeout: 60_000 } });
