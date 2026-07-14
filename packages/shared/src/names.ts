/**
 * Per-nationality name pools and a name generator for randomly naming
 * Captains. Each nationality carries separate male/female first-name pools
 * and a shared last-name pool; `randomName` draws a male first name
 * MALE_FIRST_NAME_FRACTION (75%) of the time and a female one otherwise.
 *
 * Shared between the simulation engine (src/sim/) and the World editor
 * (editor/) -- both call every generator here with an explicit NameRng: the
 * sim passes its seeded Rng/simRandom adapter (for reproducibility), the
 * editor passes a small Math.random()-backed adapter (no reproducibility
 * requirement there).
 *
 * Ported/expanded from sim/names.py. Five nationalities are provided
 * (English, French, Spanish, Dutch, Portuguese); which one a given Faction
 * draws from is the caller's choice (see buildWorld / world.ts).
 */

/** Fraction of generated first names that are male -- see randomName. */
export const MALE_FIRST_NAME_FRACTION = 0.75;

/** A nationality's name pools: male/female first names (kept separate so the male:female ratio is controllable) plus a shared last-name pool. */
export interface NamePool {
  maleFirstNames: string[];
  femaleFirstNames: string[];
  lastNames: string[];
}

/**
 * The minimal random surface every generator in this package needs --
 * satisfied by both the sim's seeded `Rng` class (see src/sim/rng.ts) and its
 * global sim RNG (see src/sim/simRandom.ts, via a `{ random, choice }`
 * adapter), and by the editor's `Math.random()`-backed adapter, so the same
 * generator serves reproducible world-gen, the live simulation, and the
 * editor's non-reproducible authoring alike.
 */
export interface NameRng {
  random(): number;
  choice<T>(arr: readonly T[]): T;
}

export const ENGLISH_NAMES: NamePool = {
  maleFirstNames: [
    "James", "William", "John", "Robert", "Michael", "Charles", "Thomas",
    "George", "Edward", "Henry", "Richard", "Francis", "Walter", "Samuel",
    "Nathaniel", "Benjamin",
  ],
  femaleFirstNames: [
    "Mary", "Elizabeth", "Margaret", "Catherine", "Alice", "Grace", "Emily", "Charlotte",
  ],
  lastNames: [
    "Smith", "Johnson", "Williams", "Brown", "Taylor", "Wilson", "Davies",
    "Evans", "Thomas", "Roberts", "Walker", "Wright", "Green", "Hall",
    "Wood", "Clarke", "Baker", "Turner", "Hughes", "Edwards",
  ],
};

export const FRENCH_NAMES: NamePool = {
  maleFirstNames: [
    "Jean", "Pierre", "Jacques", "Louis", "François", "Henri", "Nicolas",
    "Charles", "Antoine", "Michel", "Guillaume", "Étienne", "Bernard",
    "Gaspard", "Philippe", "Olivier",
  ],
  femaleFirstNames: [
    "Marie", "Jeanne", "Catherine", "Louise", "Madeleine", "Anne", "Marguerite", "Hélène",
  ],
  lastNames: [
    "Martin", "Bernard", "Dubois", "Thomas", "Robert", "Richard", "Petit",
    "Durand", "Leroy", "Moreau", "Simon", "Laurent", "Lefebvre", "Roux",
    "Fournier", "Girard", "Bonnet", "Dupont", "Lambert", "Rousseau",
  ],
};

export const SPANISH_NAMES: NamePool = {
  maleFirstNames: [
    "Carlos", "Miguel", "José", "Javier", "Diego", "Rafael", "Alejandro",
    "Fernando", "Manuel", "Francisco", "Juan", "Pedro", "Antonio", "Andrés",
    "Rodrigo", "Gonzalo",
  ],
  femaleFirstNames: [
    "Isabel", "Sofía", "Carmen", "Elena", "Lucía", "Marta", "Ana", "Beatriz",
  ],
  lastNames: [
    "García", "Rodríguez", "Martínez", "Hernández", "López", "González",
    "Pérez", "Sánchez", "Ramírez", "Torres", "Flores", "Rivera", "Gómez",
    "Díaz", "Cruz", "Morales", "Ortiz", "Gutiérrez", "Chávez", "Ramos",
  ],
};

export const DUTCH_NAMES: NamePool = {
  maleFirstNames: [
    "Jan", "Willem", "Pieter", "Hendrik", "Cornelis", "Dirk", "Klaas",
    "Gerrit", "Bram", "Sander", "Joris", "Maarten", "Roelof", "Adriaan",
    "Jacob", "Frederik",
  ],
  femaleFirstNames: [
    "Anna", "Maria", "Johanna", "Wilhelmina", "Cornelia", "Femke", "Lotte", "Marieke",
  ],
  lastNames: [
    "de Vries", "Jansen", "de Jong", "Bakker", "Visser", "Smit", "Meijer",
    "de Boer", "Mulder", "de Groot", "Bos", "Vos", "Peters", "Hendriks",
    "van Dijk", "Dekker", "Brouwer", "van der Berg", "Willems", "Kok",
  ],
};

export const PORTUGUESE_NAMES: NamePool = {
  maleFirstNames: [
    "João", "Manuel", "José", "António", "Francisco", "Pedro", "Miguel",
    "Duarte", "Diogo", "Henrique", "Vasco", "Afonso", "Luís", "Fernão",
    "Rodrigo", "Gaspar",
  ],
  femaleFirstNames: [
    "Maria", "Ana", "Isabel", "Catarina", "Beatriz", "Inês", "Leonor", "Margarida",
  ],
  lastNames: [
    "Silva", "Santos", "Ferreira", "Pereira", "Oliveira", "Costa", "Rodrigues",
    "Martins", "Sousa", "Fernandes", "Gonçalves", "Gomes", "Lopes", "Marques",
    "Almeida", "Ribeiro", "Pinto", "Carvalho", "Teixeira", "Correia",
  ],
};

/**
 * A random "First Last" name drawn from `pool` using `rng`. The first name is
 * male with probability MALE_FIRST_NAME_FRACTION (75%) and female otherwise.
 */
export function randomName(rng: NameRng, pool: NamePool): string {
  const firstNames = rng.random() < MALE_FIRST_NAME_FRACTION ? pool.maleFirstNames : pool.femaleFirstNames;
  return `${rng.choice(firstNames)} ${rng.choice(pool.lastNames)}`;
}

/** A Person's gender, as rolled by randomGender/randomPersonName -- the only two values name-pool generation distinguishes (see MALE_FIRST_NAME_FRACTION). */
export type Gender = "Male" | "Female";

/** The same roll randomName makes internally, exposed on its own for callers (e.g. sim/person.ts) that need to know which way it went, not just the resulting first-name pool. */
export function randomGender(rng: NameRng): Gender {
  return rng.random() < MALE_FIRST_NAME_FRACTION ? "Male" : "Female";
}

/** Like randomName, but also returns which gender was rolled -- for callers building a Person that needs both (see sim/person.ts's Gender field). */
export function randomPersonName(rng: NameRng, pool: NamePool): { name: string; gender: Gender } {
  const gender = randomGender(rng);
  const firstNames = gender === "Male" ? pool.maleFirstNames : pool.femaleFirstNames;
  return { name: `${rng.choice(firstNames)} ${rng.choice(pool.lastNames)}`, gender };
}
