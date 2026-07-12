/**
 * Unified text diff between the original and tuned World JSON -- generated
 * in JS via the `diff` package (no external `diff`/`patch` binary required),
 * directly usable with `patch -p0`/`git apply`.
 */
import { createTwoFilesPatch } from "diff";
import type { WorldJson } from "./worldJson";

export function worldJsonDiff(originalPath: string, tunedPath: string, original: WorldJson, tuned: WorldJson): string {
  const originalText = `${JSON.stringify(original, null, 2)}\n`;
  const tunedText = `${JSON.stringify(tuned, null, 2)}\n`;
  return createTwoFilesPatch(originalPath, tunedPath, originalText, tunedText);
}
