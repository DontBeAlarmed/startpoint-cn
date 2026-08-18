import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import {
    getPlayerCharacterGrowthFactsByIdsSync,
    getPlayerCharacterManaNodesByIdsSync,
    type PlayerCharacterGrowthFact,
} from "../../data/domains/character"
import type { FinishContext } from "../quest/finish/types"
import type { ActiveMissionPlan } from "./active-plan"

const CONDITIONAL_BATTLE_PATTERNS = new Set([71, 72, 73])

export interface ActiveBattleFactContext {
    readonly plan: ActiveMissionPlan
    readonly repository?: ReadonlyContentRepository
    readonly partyCharacterIds: readonly number[]
    readonly unisonCharacterIds: readonly number[]
    readonly allPartyCharacterIds: readonly number[]
    readonly targetCharacterIds: readonly number[]
    readonly characterGrowthFacts: Readonly<Record<string, PlayerCharacterGrowthFact>>
    readonly characterManaNodes: Readonly<Record<string, readonly number[]>>
}

function collectCharacterIds(
    characters: readonly ({ readonly id?: number | null } | null)[],
): number[] {
    return characters.flatMap(character => {
        const characterId = character?.id
        return Number.isSafeInteger(characterId) && (characterId as number) > 0
            ? [characterId as number]
            : []
    })
}

export function createActiveBattleFactContext(
    context: FinishContext,
    plan: ActiveMissionPlan,
    repository: ReadonlyContentRepository | undefined,
): ActiveBattleFactContext {
    const partyCharacterIds = collectCharacterIds(context.party.characters)
    const unisonCharacterIds = collectCharacterIds(context.party.unison_characters)
    const allPartyCharacterIds = [...partyCharacterIds, ...unisonCharacterIds]
    const allPartyCharacterIdSet = new Set(allPartyCharacterIds)
    const targetCharacterIds = [...new Set([71, 72, 73].flatMap(pattern => (
        plan.getDefinitionsByPattern(pattern).flatMap(definition => {
            const characterId = Number(definition.row[43])
            return CONDITIONAL_BATTLE_PATTERNS.has(definition.pattern)
                && Number.isSafeInteger(characterId)
                && characterId > 0
                && allPartyCharacterIdSet.has(characterId)
                ? [characterId]
                : []
        })
    )))].sort((left, right) => left - right)
    return {
        plan,
        repository,
        partyCharacterIds,
        unisonCharacterIds,
        allPartyCharacterIds,
        targetCharacterIds,
        characterGrowthFacts: getPlayerCharacterGrowthFactsByIdsSync(
            context.playerId,
            targetCharacterIds,
        ),
        characterManaNodes: getPlayerCharacterManaNodesByIdsSync(
            context.playerId,
            targetCharacterIds,
        ),
    }
}
