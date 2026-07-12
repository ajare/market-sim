import { describe, it, expect } from "vitest";
import {
  randomCompanyName, type CompanyNamePool,
  ENGLISH_COMPANY_NAMES, FRENCH_COMPANY_NAMES, SPANISH_COMPANY_NAMES,
  DUTCH_COMPANY_NAMES, PORTUGUESE_COMPANY_NAMES,
} from "../companyNames";
import { Rng } from "../rng";

const POOLS: [string, CompanyNamePool][] = [
  ["English", ENGLISH_COMPANY_NAMES],
  ["French", FRENCH_COMPANY_NAMES],
  ["Spanish", SPANISH_COMPANY_NAMES],
  ["Dutch", DUTCH_COMPANY_NAMES],
  ["Portuguese", PORTUGUESE_COMPANY_NAMES],
];

describe("company name generators", () => {
  it("provides exactly the five requested nationalities, each with forms + subjects", () => {
    expect(POOLS.map(([n]) => n)).toEqual(["English", "French", "Spanish", "Dutch", "Portuguese"]);
    for (const [, pool] of POOLS) {
      expect(pool.forms.length).toBeGreaterThan(0);
      expect(pool.subjects.length).toBeGreaterThan(0);
      // Every form has exactly one {subject} slot.
      for (const form of pool.forms) {
        expect(form.split("{subject}").length - 1).toBe(1);
      }
    }
  });

  it("generates a name from a form and a subject, with no leftover slot", () => {
    const rng = new Rng(11);
    for (const [, pool] of POOLS) {
      for (let i = 0; i < 50; i++) {
        const name = randomCompanyName(rng, pool);
        expect(name).not.toContain("{subject}");
        // The name must be one of the pool's forms with a real subject filled in.
        const matches = pool.forms.some((form) =>
          pool.subjects.some((s) => form.replace("{subject}", s) === name),
        );
        expect(matches).toBe(true);
      }
    }
  });

  it("produces recognisably period names for each nationality", () => {
    // Spot-check that a well-known real charter is reachable per nationality.
    const reachable = (pool: CompanyNamePool, target: string) =>
      pool.forms.some((f) => pool.subjects.some((s) => f.replace("{subject}", s) === target));
    expect(reachable(ENGLISH_COMPANY_NAMES, "East India Company")).toBe(true);
    expect(reachable(DUTCH_COMPANY_NAMES, "Verenigde Oost-Indische Compagnie")).toBe(true);
    expect(reachable(FRENCH_COMPANY_NAMES, "Compagnie des Indes orientales")).toBe(true);
    expect(reachable(SPANISH_COMPANY_NAMES, "Real Compañía de Filipinas")).toBe(true);
    expect(reachable(PORTUGUESE_COMPANY_NAMES, "Companhia Geral do Grão-Pará e Maranhão")).toBe(true);
  });

  it("yields good variety (forms x subjects distinct names)", () => {
    const rng = new Rng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) seen.add(randomCompanyName(rng, ENGLISH_COMPANY_NAMES));
    expect(seen.size).toBe(ENGLISH_COMPANY_NAMES.forms.length * ENGLISH_COMPANY_NAMES.subjects.length);
  });
});
