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

export function getPartyGroupLimit(category: PartyCategory): number {
    return category === PartyCategory.CARNIVAL || category === PartyCategory.RUSH ? 6 : 12
}

export function isPartyGroupAllowedForCategory(
    category: PartyCategory,
    groupId: number,
): boolean {
    return Number.isInteger(groupId) && groupId >= 1 && groupId <= getPartyGroupLimit(category)
}

export function isGlobalPartyIdAllowedForCategory(
    category: PartyCategory,
    partyId: number,
): boolean {
    const parsed = parseGlobalPartyId(partyId)
    return parsed !== null && isPartyGroupAllowedForCategory(category, parsed.groupId)
}

export function resolvePartyGroupColorId(
    group: Pick<PlayerPartyGroup, "colorId"> | undefined,
): number {
    return group?.colorId ?? 15
}

export function getGlobalPartyId(groupId: number, slot: number): number {
    if (!Number.isInteger(groupId) || groupId < 1 || groupId > 12
        || !Number.isInteger(slot) || slot < 1 || slot > 10) {
        throw new RangeError("Party group or slot is outside the CN protocol range")
    }
    return (groupId - 1) * 10 + slot
}

export function parseGlobalPartyId(partyId: number): { groupId: number, slot: number } | null {
    if (!Number.isInteger(partyId) || partyId < 1 || partyId > 120) return null
    return {
        groupId: Math.floor((partyId - 1) / 10) + 1,
        slot: ((partyId - 1) % 10) + 1,
    }
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
            if (!isPartyGroupAllowedForCategory(category, Number(groupId))) continue
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
