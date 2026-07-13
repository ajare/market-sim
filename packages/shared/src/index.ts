/**
 * @market-sim/shared -- logic genuinely shared between the simulation engine
 * (root `src/sim/`) and the World editor (`editor/`). A plain source-only npm
 * workspace package (no build step): both consumers resolve these .ts files
 * directly via Vite's bundler-mode module resolution and type-check them as
 * part of their own `tsc -b` run.
 */
export * from "./names";
export * from "./shipNames";
export * from "./companyNames";
export * from "./locationNames";
export * from "./nationality";
export * from "./distance";
export * from "./terminal";
export * from "./routePlanning";
export * from "./commodity";
export * from "./politicalEntity";
export * from "./world";
export * from "./bezier";
