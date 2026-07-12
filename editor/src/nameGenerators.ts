/**
 * Nationality-based name generators for the editor: captain names (75% male
 * first names), ship names, company names in the style of the 16th-18th
 * century chartered merchant companies, and colonial-era location names.
 *
 * These mirror the simulation's own generators (src/sim/names.ts,
 * shipNames.ts, companyNames.ts) but live here as a standalone copy: the
 * editor and the sim are separate builds, and the editor only needs to emit
 * plain name strings into the authored World JSON. Draws use Math.random --
 * the editor has no seeded-RNG reproducibility requirement.
 */

export type Nationality = "English" | "French" | "Spanish" | "Dutch" | "Portuguese";

export const NATIONALITIES: Nationality[] = ["English", "French", "Spanish", "Dutch", "Portuguese"];

export const DEFAULT_NATIONALITY: Nationality = "English";

/** Fraction of generated captain first names that are male. */
export const MALE_FIRST_NAME_FRACTION = 0.75;

interface NamePool {
  maleFirstNames: string[];
  femaleFirstNames: string[];
  lastNames: string[];
}

interface CompanyNamePool {
  forms: string[];
  subjects: string[];
}

interface NationalityData {
  personNames: NamePool;
  shipNames: string[];
  companyNames: CompanyNamePool;
  locationNames: string[];
}

const DATA: Record<Nationality, NationalityData> = {
  English: {
    personNames: {
      maleFirstNames: [
        "James", "William", "John", "Robert", "Michael", "Charles", "Thomas",
        "George", "Edward", "Henry", "Richard", "Francis", "Walter", "Samuel",
        "Nathaniel", "Benjamin",
      ],
      femaleFirstNames: ["Mary", "Elizabeth", "Margaret", "Catherine", "Alice", "Grace", "Emily", "Charlotte"],
      lastNames: [
        "Smith", "Johnson", "Williams", "Brown", "Taylor", "Wilson", "Davies",
        "Evans", "Thomas", "Roberts", "Walker", "Wright", "Green", "Hall",
        "Wood", "Clarke", "Baker", "Turner", "Hughes", "Edwards",
      ],
    },
    shipNames: [
      "Victory", "Sovereign", "Endeavour", "Resolution", "Triumph", "Defiance",
      "Vanguard", "Dreadnought", "Repulse", "Bellerophon", "Agamemnon", "Ajax",
      "Centurion", "Swiftsure", "Royal Oak", "Warspite", "Formidable",
      "Conqueror", "Revenge", "Temeraire",
    ],
    companyNames: {
      forms: [
        "{subject} Company", "Royal {subject} Company", "Company of {subject} Merchants",
        "{subject} Trading Company", "Merchant Adventurers of {subject}",
      ],
      subjects: [
        "East India", "West India", "Levant", "Muscovy", "Guinea", "Hudson's Bay",
        "Virginia", "Turkey", "Eastland", "South Sea", "Africa", "Barbary",
        "Greenland", "Bengal", "Canton", "Newfoundland", "Massachusetts Bay", "Bermuda",
      ],
    },
    locationNames: [
      "Jamestown", "Charlestown", "New Providence", "Port Royal", "Kingston",
      "Bridgetown", "Georgetown", "New Plymouth", "Salem", "Newport", "Falmouth",
      "Portsmouth", "Nassau", "Annapolis", "Williamsburg", "New London",
      "Elizabeth City", "Providence", "New Bristol", "Fort James",
    ],
  },
  French: {
    personNames: {
      maleFirstNames: [
        "Jean", "Pierre", "Jacques", "Louis", "François", "Henri", "Nicolas",
        "Charles", "Antoine", "Michel", "Guillaume", "Étienne", "Bernard",
        "Gaspard", "Philippe", "Olivier",
      ],
      femaleFirstNames: ["Marie", "Jeanne", "Catherine", "Louise", "Madeleine", "Anne", "Marguerite", "Hélène"],
      lastNames: [
        "Martin", "Bernard", "Dubois", "Thomas", "Robert", "Richard", "Petit",
        "Durand", "Leroy", "Moreau", "Simon", "Laurent", "Lefebvre", "Roux",
        "Fournier", "Girard", "Bonnet", "Dupont", "Lambert", "Rousseau",
      ],
    },
    shipNames: [
      "Redoutable", "Bucentaure", "Intrépide", "Indomptable", "Achille", "Héros",
      "Fougueux", "Aigle", "Scipion", "Argonaute", "Pluton", "Algésiras",
      "Neptune", "Soleil Royal", "Couronne", "Triomphant", "Glorieux", "Superbe",
      "Magnifique", "Terrible",
    ],
    companyNames: {
      forms: [
        "Compagnie {subject}", "Compagnie royale {subject}",
        "Compagnie française {subject}", "Compagnie générale {subject}",
      ],
      subjects: [
        "des Indes orientales", "des Indes occidentales", "du Sénégal", "du Levant",
        "du Mississippi", "de Chine", "de Guinée", "de la Nouvelle-France",
        "des Îles de l'Amérique", "du Nord", "de Saint-Domingue", "de Perse",
        "de la Louisiane", "du Cap-Vert", "de Cayenne", "de Madagascar", "du Canada",
      ],
    },
    locationNames: [
      "Nouvelle-Orléans", "Québec", "Montréal", "Port-au-Prince", "Cap-Français",
      "Louisbourg", "Fort-Royal", "Saint-Pierre", "Trois-Rivières", "Léogâne",
      "Basse-Terre", "Pointe-à-Pitre", "Cayenne", "Baton Rouge", "Biloxi",
      "Fort-Dauphin", "Port-de-Paix", "Les Cayes", "Fort-de-France", "Mobile",
    ],
  },
  Spanish: {
    personNames: {
      maleFirstNames: [
        "Carlos", "Miguel", "José", "Javier", "Diego", "Rafael", "Alejandro",
        "Fernando", "Manuel", "Francisco", "Juan", "Pedro", "Antonio", "Andrés",
        "Rodrigo", "Gonzalo",
      ],
      femaleFirstNames: ["Isabel", "Sofía", "Carmen", "Elena", "Lucía", "Marta", "Ana", "Beatriz"],
      lastNames: [
        "García", "Rodríguez", "Martínez", "Hernández", "López", "González",
        "Pérez", "Sánchez", "Ramírez", "Torres", "Flores", "Rivera", "Gómez",
        "Díaz", "Cruz", "Morales", "Ortiz", "Gutiérrez", "Chávez", "Ramos",
      ],
    },
    shipNames: [
      "Santísima Trinidad", "Santa Ana", "Príncipe de Asturias", "Rayo",
      "Neptuno", "Argonauta", "Bahama", "Monarca", "San Juan Nepomuceno",
      "San Agustín", "Montañés", "San Ildefonso", "San Justo", "San Leandro",
      "Glorioso", "Purísima Concepción", "Fénix", "Real Carlos", "San Telmo",
      "Nuestra Señora",
    ],
    companyNames: {
      forms: [
        "Compañía de {subject}", "Real Compañía de {subject}",
        "Real Compañía de Comercio de {subject}", "Compañía de Comercio de {subject}",
      ],
      subjects: [
        "Caracas", "La Habana", "Filipinas", "Barcelona", "Sevilla", "Cádiz",
        "Honduras", "La Coruña", "Indias", "Buenos Aires", "Cartagena",
        "San Fernando", "Nueva España", "Veracruz", "Manila", "Portobelo",
        "Guipúzcoa", "Santo Domingo",
      ],
    },
    locationNames: [
      "Cartagena", "Veracruz", "Portobelo", "La Habana", "Santo Domingo",
      "San Juan", "Panamá", "Maracaibo", "Campeche", "Nombre de Dios",
      "Santiago de Cuba", "San Agustín", "Cumaná", "Santa Marta", "Puerto Cabello",
      "Trinidad", "San Germán", "Riohacha", "Coro", "Valdivia",
    ],
  },
  Dutch: {
    personNames: {
      maleFirstNames: [
        "Jan", "Willem", "Pieter", "Hendrik", "Cornelis", "Dirk", "Klaas",
        "Gerrit", "Bram", "Sander", "Joris", "Maarten", "Roelof", "Adriaan",
        "Jacob", "Frederik",
      ],
      femaleFirstNames: ["Anna", "Maria", "Johanna", "Wilhelmina", "Cornelia", "Femke", "Lotte", "Marieke"],
      lastNames: [
        "de Vries", "Jansen", "de Jong", "Bakker", "Visser", "Smit", "Meijer",
        "de Boer", "Mulder", "de Groot", "Bos", "Vos", "Peters", "Hendriks",
        "van Dijk", "Dekker", "Brouwer", "van der Berg", "Willems", "Kok",
      ],
    },
    shipNames: [
      "Zeven Provinciën", "Brederode", "Eendracht", "Gouden Leeuw", "Hollandia",
      "Amsterdam", "Batavia", "Vrijheid", "Prins Willem", "Delft", "Rotterdam",
      "Gelderland", "Groningen", "Zeelandia", "Vergulde Draeck", "Witte Leeuw",
      "Halve Maen", "Duyfken", "Mauritius", "Wapen van Utrecht",
    ],
    companyNames: {
      forms: [
        "{subject} Compagnie", "Verenigde {subject} Compagnie",
        "Geoctrooieerde {subject} Compagnie", "Nieuwe {subject} Compagnie",
      ],
      subjects: [
        "Oost-Indische", "West-Indische", "Noordsche", "Levantse", "Australische",
        "Guineese", "Straatvaart", "Groenlandse", "Surinaamse", "Middelburgse",
        "Zeeuwse", "Amsterdamse", "Bataviase", "Molukse", "Perzische", "Afrikaanse",
      ],
    },
    locationNames: [
      "Nieuw Amsterdam", "Willemstad", "Paramaribo", "Fort Oranje", "Oranjestad",
      "Stabroek", "Nieuw Middelburg", "Fort Nassau", "Nieuw Walcheren", "Berbice",
      "Kaapstad", "Nieuw Zeeland", "Fort Zeelandia", "Nieuw Vlissingen",
      "Fort Amsterdam", "Sint Eustatius", "Essequibo", "Fort Kijkoveral",
      "Nieuw Oranje", "Kralendijk",
    ],
  },
  Portuguese: {
    personNames: {
      maleFirstNames: [
        "João", "Manuel", "José", "António", "Francisco", "Pedro", "Miguel",
        "Duarte", "Diogo", "Henrique", "Vasco", "Afonso", "Luís", "Fernão",
        "Rodrigo", "Gaspar",
      ],
      femaleFirstNames: ["Maria", "Ana", "Isabel", "Catarina", "Beatriz", "Inês", "Leonor", "Margarida"],
      lastNames: [
        "Silva", "Santos", "Ferreira", "Pereira", "Oliveira", "Costa", "Rodrigues",
        "Martins", "Sousa", "Fernandes", "Gonçalves", "Gomes", "Lopes", "Marques",
        "Almeida", "Ribeiro", "Pinto", "Carvalho", "Teixeira", "Correia",
      ],
    },
    shipNames: [
      "São Gabriel", "São Rafael", "Bérrio", "Flor de la Mar", "Madre de Deus",
      "São Martinho", "Santa Catarina", "Nossa Senhora da Conceição",
      "Cinco Chagas", "São Filipe", "Bom Jesus", "São Pedro",
      "Nossa Senhora do Cabo", "São Lourenço", "Santo António", "São Bento",
      "São João Baptista", "São Francisco", "Nossa Senhora da Luz", "Chagas",
    ],
    companyNames: {
      forms: ["Companhia {subject}", "Companhia Geral {subject}", "Companhia Real {subject}"],
      subjects: [
        "do Comércio da Índia", "do Grão-Pará e Maranhão", "de Pernambuco e Paraíba",
        "de Cacheu", "da Costa da Guiné", "do Comércio do Brasil", "das Índias Orientais",
        "de Cabo Verde", "do Maranhão", "de Angola", "de São Tomé", "do Oriente",
        "da Mina", "de Malaca", "de Ormuz", "do Estado da Índia", "de Moçambique", "do Brasil",
      ],
    },
    locationNames: [
      "Salvador", "Recife", "Olinda", "Rio de Janeiro", "São Luís", "Belém",
      "São Vicente", "Cabo Frio", "Ilhéus", "Porto Seguro", "Luanda", "Cacheu",
      "São Jorge da Mina", "Espírito Santo", "Nazaré", "Vila Rica", "São Salvador",
      "Nova Lisboa", "Porto Calvo", "São Filipe",
    ],
  },
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** A "First Last" captain name for `nationality`; the first name is male MALE_FIRST_NAME_FRACTION (75%) of the time. */
export function generateCaptainName(nationality: Nationality): string {
  const pool = DATA[nationality].personNames;
  const firstNames = Math.random() < MALE_FIRST_NAME_FRACTION ? pool.maleFirstNames : pool.femaleFirstNames;
  return `${pick(firstNames)} ${pick(pool.lastNames)}`;
}

/** A ship name for `nationality`. */
export function generateShipName(nationality: Nationality): string {
  return pick(DATA[nationality].shipNames);
}

/** A chartered-merchant-company name for `nationality`. */
export function generateCompanyName(nationality: Nationality): string {
  const pool = DATA[nationality].companyNames;
  return pick(pool.forms).replace("{subject}", pick(pool.subjects));
}

/** A colonial-era settlement/port name for `nationality`. */
export function generateLocationName(nationality: Nationality): string {
  return pick(DATA[nationality].locationNames);
}
