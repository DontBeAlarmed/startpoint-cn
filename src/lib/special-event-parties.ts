import { PartyCategory, PlayerParty, PlayerPartyGroup } from "../data/types"

interface SpecialEventPartyDependencies {
    getGroups: (playerId: number, category: PartyCategory) => Record<string, PlayerPartyGroup>
    getDefaults: (category: PartyCategory) => Record<string, PlayerPartyGroup>
    ensureGroups: (playerId: number, groups: Record<string, PlayerPartyGroup>) => void
}

export function isPartyCategory(value: number): value is PartyCategory {
    return Number.isInteger(value)
        && value >= PartyCategory.NORMAL
        && value <= PartyCategory.RUSH
}

export function hasValidPartyCategory(
    value: unknown,
): value is { party_category: PartyCategory } {
    if (value === null || typeof value !== "object" || !("party_category" in value)) {
        return false
    }
    const category = (value as { party_category: unknown }).party_category
    return typeof category === "number" && isPartyCategory(category)
}

export function resolvePartyGroupColorId(
    group: Pick<PlayerPartyGroup, "colorId"> | undefined,
): number {
    return group?.colorId ?? 15
}

function copyParty(party: PlayerParty, category: PartyCategory): PlayerParty {
    return {
        ...party,
        characterIds: [...party.characterIds],
        unisonCharacterIds: [...party.unisonCharacterIds],
        equipmentIds: [...party.equipmentIds],
        abilitySoulIds: [...party.abilitySoulIds],
        options: { ...party.options },
        category,
    }
}

export function mergePartyGroupsForCategory(
    existing: Record<string, PlayerPartyGroup>,
    legacyFallback: Record<string, PlayerPartyGroup>,
    defaults: Record<string, PlayerPartyGroup>,
    category: PartyCategory,
): Record<string, PlayerPartyGroup> {
    const result: Record<string, PlayerPartyGroup> = {}
    const sources = [defaults, legacyFallback, existing]

    for (const source of sources) {
        for (const [groupId, group] of Object.entries(source)) {
            const target = result[groupId] ?? {
                list: {},
                colorId: group.colorId,
                category,
            }
            target.colorId = group.colorId
            target.category = category

            for (const [slot, party] of Object.entries(group.list)) {
                target.list[slot] = copyParty(party, category)
            }
            result[groupId] = target
        }
    }

    return result
}

export function ensureSpecialEventPartyGroupsSync(
    playerId: number,
    category: PartyCategory,
    legacyFallbackCategory: PartyCategory | undefined,
    dependencies: SpecialEventPartyDependencies,
): Record<string, PlayerPartyGroup> {
    const existing = dependencies.getGroups(playerId, category)
    const legacyFallback = legacyFallbackCategory === undefined
        ? {}
        : dependencies.getGroups(playerId, legacyFallbackCategory)
    const defaults = dependencies.getDefaults(category)
    const completeGroups = mergePartyGroupsForCategory(
        existing,
        legacyFallback,
        defaults,
        category,
    )

    dependencies.ensureGroups(playerId, completeGroups)
    return dependencies.getGroups(playerId, category)
}
