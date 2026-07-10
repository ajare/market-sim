import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/sim/distanceScaleVariablesSweep.harness.ts"],
    testTimeout: 60 * 60 * 1000,
    reporters: ["verbose"],
    disableConsoleIntercept: true,
  },
});
