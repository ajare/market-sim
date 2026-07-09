/**
 * Name pools for randomly naming Captains, distinct by the kind of Faction
 * they crew for: Spanish for PirateBrigade, Dutch for Company/SoloTrader,
 * English for PoliceFleet. Ported from sim/names.py.
 */
import type { Rng } from "./rng";

export const SPANISH_FIRST_NAMES: string[] = [
  "Carlos", "Miguel", "Jose", "Javier", "Diego", "Rafael", "Alejandro",
  "Fernando", "Manuel", "Francisco", "Isabel", "Sofia", "Carmen", "Elena",
  "Lucia", "Marta", "Rosa", "Teresa", "Ana", "Beatriz",
];
export const SPANISH_LAST_NAMES: string[] = [
  "Garcia", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
  "Perez", "Sanchez", "Ramirez", "Torres", "Flores", "Rivera", "Gomez",
  "Diaz", "Cruz", "Morales", "Ortiz", "Gutierrez", "Chavez", "Ramos",
];

export const DUTCH_FIRST_NAMES: string[] = [
  "Jan", "Willem", "Pieter", "Hendrik", "Cornelis", "Dirk", "Klaas",
  "Gerrit", "Bram", "Sander", "Anna", "Maria", "Johanna", "Wilhelmina",
  "Cornelia", "Femke", "Sanne", "Lotte", "Anke", "Marieke",
];
export const DUTCH_LAST_NAMES: string[] = [
  "de Vries", "Jansen", "de Jong", "Bakker", "Visser", "Smit", "Meijer",
  "de Boer", "Mulder", "de Groot", "Bos", "Vos", "Peters", "Hendriks",
  "van Dijk", "Dekker", "Brouwer", "van der Berg", "Willems", "Kok",
];

export const ENGLISH_FIRST_NAMES: string[] = [
  "James", "William", "John", "Robert", "Michael", "Charles", "Thomas",
  "George", "Edward", "Henry", "Mary", "Elizabeth", "Margaret", "Catherine",
  "Alice", "Grace", "Emily", "Charlotte", "Victoria", "Eleanor",
];
export const ENGLISH_LAST_NAMES: string[] = [
  "Smith", "Johnson", "Williams", "Brown", "Taylor", "Wilson", "Davies",
  "Evans", "Thomas", "Roberts", "Walker", "Wright", "Green", "Hall",
  "Wood", "Clarke", "Baker", "Turner", "Hughes", "Edwards",
];

/** A random "First Last" name drawn from the given pools using `rng`. */
export function randomName(rng: Rng, firstNames: string[], lastNames: string[]): string {
  return `${rng.choice(firstNames)} ${rng.choice(lastNames)}`;
}
