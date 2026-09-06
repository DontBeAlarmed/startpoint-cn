import { getCharacterFacts } from "../../character-content"

/** Returns the races for a character by ID (numeric or string) */
export function getCharacterRaces(charId: number | string): string[] {
    return getCharacterFacts().races(charId)
}

/** Build a sorted unique race key (e.g., "Dragon+Human") */
export function getRaceKey(races: string[]): string[] {
    return [...new Set(races.filter((r) => r !== ""))].sort()
}

/** Build a race key string from races */
export function getRaceKeyString(races: string[]): string {
    return getRaceKey(races).join("+")
}
