/**
 * The scale a PoliticalEntity groups Locations at, from broadest to
 * narrowest. Shared by the simulation engine (src/sim/politicalEntity.ts,
 * where a PoliticalEntity is a class with locations/cash) and the editor
 * (types.ts, where it's a plain JSON-serializable interface) -- only this
 * type/constants trio is identical between the two; the rest of the shape
 * genuinely diverges and stays local to each side.
 */
export type PoliticalEntityType = "Universal" | "Planet" | "Country" | "State" | "Tribe";

export const POLITICAL_ENTITY_TYPES: PoliticalEntityType[] = ["Universal", "Planet", "Country", "State", "Tribe"];

export const DEFAULT_POLITICAL_ENTITY_TYPE: PoliticalEntityType = "Universal";
