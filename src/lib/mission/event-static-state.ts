import type {
    PlayerCharacter,
    PlayerEquipment,
    PlayerPartyGroup,
} from "../../data/types"
import type { EventCurrentStateRule } from "./event-current-state-rules"
import type { CategoryContext } from "./types"

export interface EventCharacterStaticFact {
    readonly rarity: number
    readonly maxOverLimitStep: number
    readonly experienceThresholds: readonly number[]
}

export interface EventCurrentStateStaticIndex {
    readonly characters: ReadonlyMap<string, EventCharacterStaticFact> | null
    readonly characterStoryQuestIds: ReadonlyMap<string, readonly number[]> | null
    readonly equipmentMaxLevels: ReadonlyMap<string, number> | null
    readonly abilitySoulItemIds: ReadonlySet<number> | null
    readonly mainQuestIdsByChapter: ReadonlyMap<number, readonly number[]> | null
    readonly manaNodeIdsByCharacter: ReadonlyMap<string, ReadonlySet<number>> | null
}

export interface EventCurrentStateLoadedFacts {
    readonly characters?: Record<string, PlayerCharacter>
    readonly characterManaNodes?: Record<string, number[]>
    readonly questProgress?: CategoryContext["questProgress"]
    readonly equipment?: Record<string, PlayerEquipment>
    readonly items?: Record<string, number>
    readonly partyGroups?: Record<string, PlayerPartyGroup>
}

type ResolveCurrentStateRule = (missionId: number) => EventCurrentStateRule | undefined

function getProvenCharacterLevel(
    fact: EventCharacterStaticFact,
    experience: number,
): number | null {
    if (!Number.isSafeInteger(experience) || experience < 0) return null
    const baseLevel = 40 + (fact.rarity - 1) * 10
    let provenLevel = 0
    for (let index = 0; index < fact.experienceThresholds.length; index++) {
        const threshold = fact.experienceThresholds[index]
        if (experience >= threshold) provenLevel = baseLevel + index * 5
    }
    return provenLevel
}

export function deriveEventCurrentState(
    facts: EventCurrentStateLoadedFacts,
    staticIndex: EventCurrentStateStaticIndex,
    missionIds: readonly number[],
    resolveRule: ResolveCurrentStateRule,
): NonNullable<CategoryContext["eventCurrentState"]> {
    const rules = missionIds.flatMap(missionId => {
        const rule = resolveRule(missionId)
        return rule ? [rule] : []
    })
    const needs = (fact: EventCurrentStateRule["fact"]): boolean => (
        rules.some(rule => rule.fact === fact)
    )
    const characters = facts.characters ?? {}
    const characterStatic = staticIndex.characters
    let maxCharacterLevel: number | null = !needs("maxCharacterLevel")
        || facts.characters === undefined
        || characterStatic === null ? null : 0
    if (maxCharacterLevel !== null) {
        for (const [characterId, character] of Object.entries(characters)) {
            const fact = characterStatic!.get(characterId)
            if (!fact) continue
            const provenLevel = getProvenCharacterLevel(fact, character.exp)
            if (provenLevel !== null) maxCharacterLevel = Math.max(maxCharacterLevel, provenLevel)
        }
    }

    const manaNodes = facts.characterManaNodes ?? {}
    const manaNodeStatic = staticIndex.manaNodeIdsByCharacter
    let manaBoardNodeCount: number | null = !needs("manaBoardNodeCount")
        || facts.characters === undefined
        || facts.characterManaNodes === undefined
        || manaNodeStatic === null ? null : 0
    if (manaBoardNodeCount !== null) {
        for (const [characterId, nodes] of Object.entries(manaNodes)) {
            if (characters[characterId] === undefined || !Array.isArray(nodes)) continue
            const officialNodeIds = manaNodeStatic!.get(characterId)
            if (!officialNodeIds) continue
            const verifiedNodes = new Set(nodes.filter(nodeId => (
                Number.isSafeInteger(nodeId) && nodeId > 0 && officialNodeIds.has(nodeId)
            )))
            const next: number = manaBoardNodeCount + verifiedNodes.size
            if (Number.isSafeInteger(next)) manaBoardNodeCount = next
        }
    }

    let overLimitCount: number | null = !needs("overLimitCount")
        || facts.characters === undefined
        || characterStatic === null ? null : 0
    if (overLimitCount !== null) {
        for (const [characterId, character] of Object.entries(characters)) {
            const fact = characterStatic!.get(characterId)
            if (!fact
                || !Number.isSafeInteger(character.overLimitStep)
                || character.overLimitStep < 0
                || character.overLimitStep > fact.maxOverLimitStep) continue
            const next: number = overLimitCount + character.overLimitStep
            if (Number.isSafeInteger(next)) overLimitCount = next
        }
    }

    const questProgress = facts.questProgress ?? {}
    const finishedCharacterQuestIds = new Set((questProgress["3"] ?? [])
        .filter(progress => progress.finished)
        .map(progress => progress.questId))
    let characterEpisodeClearCount: number | null = null
    if (needs("characterEpisodeClearCount")
        && facts.characters !== undefined
        && facts.questProgress !== undefined
        && staticIndex.characterStoryQuestIds !== null) {
        const storyQuestIds = new Set(Object.keys(characters).flatMap(characterId => (
            staticIndex.characterStoryQuestIds!.get(characterId) ?? []
        )))
        let count = 0
        for (const questId of storyQuestIds) {
            if (finishedCharacterQuestIds.has(questId)) count++
        }
        characterEpisodeClearCount = count
    }

    const finishedMainQuestIds = new Set((questProgress["1"] ?? [])
        .filter(progress => progress.finished)
        .map(progress => progress.questId))
    const clearedMainChapters: Set<number> | null = !needs("mainChapterClear")
        || facts.questProgress === undefined
        || staticIndex.mainQuestIdsByChapter === null
        ? null
        : new Set<number>()
    if (clearedMainChapters !== null) {
        for (const missionId of missionIds) {
            const rule = resolveRule(missionId)
            if (rule?.mainChapter === undefined) continue
            const questIds = staticIndex.mainQuestIdsByChapter!.get(rule.mainChapter) ?? []
            if (questIds.length > 0 && questIds.every(questId => finishedMainQuestIds.has(questId))) {
                clearedMainChapters.add(rule.mainChapter)
            }
        }
    }

    const equipment = facts.equipment ?? {}
    const equipmentStatic = staticIndex.equipmentMaxLevels
    let equipmentAwakeningCount: number | null = !needs("equipmentAwakeningCount")
        || facts.equipment === undefined
        || equipmentStatic === null ? null : 0
    if (equipmentAwakeningCount !== null) {
        for (const [equipmentId, item] of Object.entries(equipment)) {
            const maxLevel = equipmentStatic!.get(equipmentId)
            if (maxLevel === undefined
                || !Number.isSafeInteger(item.level) || item.level < 1
                || item.level > maxLevel) continue
            const next: number = equipmentAwakeningCount + item.level - 1
            if (Number.isSafeInteger(next)) equipmentAwakeningCount = next
        }
    }

    const ownedItems = facts.items ?? {}
    const abilitySoulItemIds = staticIndex.abilitySoulItemIds
    let hasEquippedAbilitySoul: boolean | null = !needs("hasEquippedAbilitySoul")
        || facts.items === undefined
        || facts.partyGroups === undefined
        || abilitySoulItemIds === null
        ? null
        : false
    if (hasEquippedAbilitySoul !== null) {
        partySearch:
        for (const group of Object.values(facts.partyGroups ?? {})) {
            for (const party of Object.values(group.list ?? {})) {
                if (!Array.isArray(party.abilitySoulIds)) continue
                const useCounts = new Map<number, number>()
                let validParty = false
                for (const abilitySoulId of party.abilitySoulIds) {
                    if (abilitySoulId === null || abilitySoulId === undefined) continue
                    if (!Number.isSafeInteger(abilitySoulId) || abilitySoulId <= 0
                        || !abilitySoulItemIds!.has(abilitySoulId)) {
                        validParty = false
                        useCounts.clear()
                        break
                    }
                    validParty = true
                    useCounts.set(abilitySoulId, (useCounts.get(abilitySoulId) ?? 0) + 1)
                }
                if (!validParty) continue
                for (const [abilitySoulId, useCount] of useCounts) {
                    const ownedCount = ownedItems[String(abilitySoulId)]
                    if (!Number.isSafeInteger(ownedCount) || ownedCount < useCount) {
                        validParty = false
                        break
                    }
                }
                if (validParty) {
                    hasEquippedAbilitySoul = true
                    break partySearch
                }
            }
        }
    }

    return {
        maxCharacterLevel,
        manaBoardNodeCount,
        overLimitCount,
        characterEpisodeClearCount,
        clearedMainChapters,
        equipmentAwakeningCount,
        hasEquippedAbilitySoul,
    }
}
