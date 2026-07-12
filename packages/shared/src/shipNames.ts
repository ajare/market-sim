/**
 * Per-nationality ship-name pools and a generator for naming Transports,
 * parallel to names.ts's Captain-name generators. Five nationalities are
 * provided (English, French, Spanish, Dutch, Portuguese); which one a given
 * ship draws from is the caller's choice (see buildWorld / world.ts), and the
 * pools are stocked with period-appropriate (Age of Sail) vessel names.
 *
 * Names are drawn with replacement, so a large fleet can reuse a name -- ship
 * names are display-only (never used as identifiers/keys), same as Captain
 * names.
 */
import type { NameRng } from "./names";

export const ENGLISH_SHIP_NAMES: string[] = [
  "Victory", "Sovereign", "Endeavour", "Resolution", "Triumph", "Defiance",
  "Vanguard", "Dreadnought", "Repulse", "Bellerophon", "Agamemnon", "Ajax",
  "Centurion", "Swiftsure", "Royal Oak", "Warspite", "Formidable",
  "Conqueror", "Revenge", "Temeraire",
];

export const FRENCH_SHIP_NAMES: string[] = [
  "Redoutable", "Bucentaure", "Intrépide", "Indomptable", "Achille", "Héros",
  "Fougueux", "Aigle", "Scipion", "Argonaute", "Pluton", "Algésiras",
  "Neptune", "Soleil Royal", "Couronne", "Triomphant", "Glorieux", "Superbe",
  "Magnifique", "Terrible",
];

export const SPANISH_SHIP_NAMES: string[] = [
  "Santísima Trinidad", "Santa Ana", "Príncipe de Asturias", "Rayo",
  "Neptuno", "Argonauta", "Bahama", "Monarca", "San Juan Nepomuceno",
  "San Agustín", "Montañés", "San Ildefonso", "San Justo", "San Leandro",
  "Glorioso", "Purísima Concepción", "Fénix", "Real Carlos", "San Telmo",
  "Nuestra Señora",
];

export const DUTCH_SHIP_NAMES: string[] = [
  "Zeven Provinciën", "Brederode", "Eendracht", "Gouden Leeuw", "Hollandia",
  "Amsterdam", "Batavia", "Vrijheid", "Prins Willem", "Delft", "Rotterdam",
  "Gelderland", "Groningen", "Zeelandia", "Vergulde Draeck", "Witte Leeuw",
  "Halve Maen", "Duyfken", "Mauritius", "Wapen van Utrecht",
];

export const PORTUGUESE_SHIP_NAMES: string[] = [
  "São Gabriel", "São Rafael", "Bérrio", "Flor de la Mar", "Madre de Deus",
  "São Martinho", "Santa Catarina", "Nossa Senhora da Conceição",
  "Cinco Chagas", "São Filipe", "Bom Jesus", "São Pedro",
  "Nossa Senhora do Cabo", "São Lourenço", "Santo António", "São Bento",
  "São João Baptista", "São Francisco", "Nossa Senhora da Luz", "Chagas",
];

/** A random ship name drawn from `pool` using `rng`. */
export function randomShipName(rng: NameRng, pool: string[]): string {
  return rng.choice(pool);
}
