/**
 * Per-nationality colonial-era settlement/port-name pools and a generator for
 * naming Locations, parallel to names.ts's Captain-name generators. Used both
 * by the editor's "generate a random name" button on a hand-placed Location,
 * and by the live simulation's own "add a Location" feature (see
 * src/sim/world.ts).
 */
import type { NameRng } from "./names";

export const ENGLISH_LOCATION_NAMES: string[] = [
  "Jamestown", "Charlestown", "New Providence", "Port Royal", "Kingston",
  "Bridgetown", "Georgetown", "New Plymouth", "Salem", "Newport", "Falmouth",
  "Portsmouth", "Nassau", "Annapolis", "Williamsburg", "New London",
  "Elizabeth City", "Providence", "New Bristol", "Fort James",
];

export const FRENCH_LOCATION_NAMES: string[] = [
  "Nouvelle-Orléans", "Québec", "Montréal", "Port-au-Prince", "Cap-Français",
  "Louisbourg", "Fort-Royal", "Saint-Pierre", "Trois-Rivières", "Léogâne",
  "Basse-Terre", "Pointe-à-Pitre", "Cayenne", "Baton Rouge", "Biloxi",
  "Fort-Dauphin", "Port-de-Paix", "Les Cayes", "Fort-de-France", "Mobile",
];

export const SPANISH_LOCATION_NAMES: string[] = [
  "Cartagena", "Veracruz", "Portobelo", "La Habana", "Santo Domingo",
  "San Juan", "Panamá", "Maracaibo", "Campeche", "Nombre de Dios",
  "Santiago de Cuba", "San Agustín", "Cumaná", "Santa Marta", "Puerto Cabello",
  "Trinidad", "San Germán", "Riohacha", "Coro", "Valdivia",
];

export const DUTCH_LOCATION_NAMES: string[] = [
  "Nieuw Amsterdam", "Willemstad", "Paramaribo", "Fort Oranje", "Oranjestad",
  "Stabroek", "Nieuw Middelburg", "Fort Nassau", "Nieuw Walcheren", "Berbice",
  "Kaapstad", "Nieuw Zeeland", "Fort Zeelandia", "Nieuw Vlissingen",
  "Fort Amsterdam", "Sint Eustatius", "Essequibo", "Fort Kijkoveral",
  "Nieuw Oranje", "Kralendijk",
];

export const PORTUGUESE_LOCATION_NAMES: string[] = [
  "Salvador", "Recife", "Olinda", "Rio de Janeiro", "São Luís", "Belém",
  "São Vicente", "Cabo Frio", "Ilhéus", "Porto Seguro", "Luanda", "Cacheu",
  "São Jorge da Mina", "Espírito Santo", "Nazaré", "Vila Rica", "São Salvador",
  "Nova Lisboa", "Porto Calvo", "São Filipe",
];

/**
 * A colonial-era settlement/port name drawn from `pool`, unique against
 * `existingNames` (typically every other Location's current name -- Location
 * names are live engine keys, so a caller with a world-wide roster of
 * existing names must pass all of them, not just one PoliticalEntity's).
 * Prefers an unused name straight from `pool`; once every pool name is
 * already taken, retries with a "New " prefix, then an "Old " prefix, across
 * the whole pool; throws if even those are all taken (2 * pool.length names
 * would all have to be in use).
 */
export function randomLocationName(rng: NameRng, pool: readonly string[], existingNames: Iterable<string> = []): string {
  const used = new Set(existingNames);
  const available = pool.filter((name) => !used.has(name));
  if (available.length > 0) return rng.choice(available);
  for (const prefix of ["New ", "Old "]) {
    const prefixed = pool.filter((name) => !used.has(`${prefix}${name}`));
    if (prefixed.length > 0) return `${prefix}${rng.choice(prefixed)}`;
  }
  throw new Error(
    `randomLocationName: exhausted every location name (including "New "/"Old " prefixes) -- ${used.size} names already in use.`,
  );
}
