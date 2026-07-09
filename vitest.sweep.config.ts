import { defineConfig } from "vitest/config";

// Config for the on-demand stockpile tuning sweep (`npm run sweep`). Kept
// separate from the default test run so the long-running harness is never
// picked up by `npm test` (whose default discovery only matches *.test.ts).
export default defineConfig({
  test: {
    include: ["src/sim/analysis.harness.ts"],
    testTimeout: 30 * 60 * 1000,
    // The harness communicates results via console.log; the verbose reporter
    // surfaces them and disableConsoleIntercept lets them stream straight to
    // the terminal (unbuffered, no `stdout |` prefix) as the sweep runs.
    reporters: ["verbose"],
    disableConsoleIntercept: true,
  },
});
