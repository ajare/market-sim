/**
 * Per-nationality company-name generators, in the style of the great chartered
 * merchant companies of the 16th-18th centuries (the English East India
 * Company, the Dutch Vereenigde Oost-Indische Compagnie, the French Compagnie
 * des Indes orientales, the Spanish Real Compañía Guipuzcoana de Caracas, the
 * Portuguese Companhia Geral do Grão-Pará e Maranhão, and their peers).
 *
 * Rather than a fixed list of real firms, each nationality supplies a set of
 * naming `forms` (a "{subject}" slot in an authentic chartered-company
 * phrasing) and a set of `subjects` (the regions, seas, and trades those
 * companies were chartered for). randomCompanyName fills one into the other,
 * yielding forms x subjects distinct names -- plenty of variety for a world of
 * many companies while every result still reads like a period trading house.
 *
 * The connective article (English "of the", French "des"/"du"/"de la",
 * Portuguese "do"/"da"/"de") is baked into each subject so the grammar comes
 * out right without the generator having to reason about gender/elision.
 */
import type { NameRng } from "./names";

export interface CompanyNamePool {
  /** Chartered-company phrasings, each containing a single "{subject}" slot. */
  forms: string[];
  /** Regions, seas, and trades a company of this nationality was chartered for. */
  subjects: string[];
}

export const ENGLISH_COMPANY_NAMES: CompanyNamePool = {
  forms: [
    "{subject} Company",
    "Royal {subject} Company",
    "Company of {subject} Merchants",
    "{subject} Trading Company",
    "Merchant Adventurers of {subject}",
  ],
  subjects: [
    "East India", "West India", "Levant", "Muscovy", "Guinea", "Hudson's Bay",
    "Virginia", "Turkey", "Eastland", "South Sea", "Africa", "Barbary",
    "Greenland", "Bengal", "Canton", "Newfoundland", "Massachusetts Bay", "Bermuda",
  ],
};

export const FRENCH_COMPANY_NAMES: CompanyNamePool = {
  forms: [
    "Compagnie {subject}",
    "Compagnie royale {subject}",
    "Compagnie française {subject}",
    "Compagnie générale {subject}",
  ],
  subjects: [
    "des Indes orientales", "des Indes occidentales", "du Sénégal", "du Levant",
    "du Mississippi", "de Chine", "de Guinée", "de la Nouvelle-France",
    "des Îles de l'Amérique", "du Nord", "de Saint-Domingue", "de Perse",
    "de la Louisiane", "du Cap-Vert", "de Cayenne", "de Madagascar", "du Canada",
  ],
};

export const SPANISH_COMPANY_NAMES: CompanyNamePool = {
  forms: [
    "Compañía de {subject}",
    "Real Compañía de {subject}",
    "Real Compañía de Comercio de {subject}",
    "Compañía de Comercio de {subject}",
  ],
  subjects: [
    "Caracas", "La Habana", "Filipinas", "Barcelona", "Sevilla", "Cádiz",
    "Honduras", "La Coruña", "Indias", "Buenos Aires", "Cartagena",
    "San Fernando", "Nueva España", "Veracruz", "Manila", "Portobelo",
    "Guipúzcoa", "Santo Domingo",
  ],
};

export const DUTCH_COMPANY_NAMES: CompanyNamePool = {
  forms: [
    "{subject} Compagnie",
    "Verenigde {subject} Compagnie",
    "Geoctrooieerde {subject} Compagnie",
    "Nieuwe {subject} Compagnie",
  ],
  subjects: [
    "Oost-Indische", "West-Indische", "Noordsche", "Levantse", "Australische",
    "Guineese", "Straatvaart", "Groenlandse", "Surinaamse", "Middelburgse",
    "Zeeuwse", "Amsterdamse", "Bataviase", "Molukse", "Perzische", "Afrikaanse",
  ],
};

export const PORTUGUESE_COMPANY_NAMES: CompanyNamePool = {
  forms: [
    "Companhia {subject}",
    "Companhia Geral {subject}",
    "Companhia Real {subject}",
  ],
  subjects: [
    "do Comércio da Índia", "do Grão-Pará e Maranhão", "de Pernambuco e Paraíba",
    "de Cacheu", "da Costa da Guiné", "do Comércio do Brasil", "das Índias Orientais",
    "de Cabo Verde", "do Maranhão", "de Angola", "de São Tomé", "do Oriente",
    "da Mina", "de Malaca", "de Ormuz", "do Estado da Índia", "de Moçambique", "do Brasil",
  ],
};

/** A random company name: one naming form with a random subject filled into its "{subject}" slot. */
export function randomCompanyName(rng: NameRng, pool: CompanyNamePool): string {
  return rng.choice(pool.forms).replace("{subject}", rng.choice(pool.subjects));
}
