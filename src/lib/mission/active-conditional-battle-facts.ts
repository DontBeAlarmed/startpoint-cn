import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { incrementActiveMissionConditionalBattleFactSync } from "../../data/domains/active_mission_battle_condition_facts"
import { getCharacterDataSync, getCharacterManaNodesSync } from "../assets"
import type { FinishContext } from "../quest/finish/types"
import {
    createActiveBattleFactContext,
    type ActiveBattleFactContext,
} from "./active-battle-fact-context"
import type { ActiveMissionMasterDefinition } from "./active-master-data"
import {
    getActiveMissionPlan,
    type PlannedActiveMissionDefinition,
} from "./active-plan"
import { matchesPlannedActiveMissionQuestRange } from "./active-quest-range"
import {
    estimateActiveMissionCharacterLevel,
    matchesActiveMissionQuestRange,
} from "./active-reconciliation"

const CONDITIONAL_PATTERNS = new Set([71, 72, 73])
const SECOND_MANA_BOARD_ABILITY_SLOTS = new Set(["4", "5", "6"])

export interface ConditionalBattleCharacterState {
    readonly level: number
    readonly secondBoardAbilitiesComplete: boolean
}

export interface ConditionalBattleContext {
    readonly questAccomplished: boolean
    readonly isMulti: boolean
    readonly questCategory: number
    readonly questId: number
    readonly partyCharacterIds: readonly number[]
}

export interface ConditionalBattleFact {
    readonly pattern: number
    readonly characterId: number
}

export function hasCompletedSecondManaBoardAbilities(
    secondBoard: Readonly<Record<string, { readonly field6?: string }>>,
    unlockedNodeIds: readonly number[],
): boolean {
    const abilityNodeIds = Object.entries(secondBoard)
        .filter(([, node]) => SECOND_MANA_BOARD_ABILITY_SLOTS.has(node.field6 ?? ""))
        .map(([nodeId]) => Number(nodeId))
        .filter(nodeId => Number.isSafeInteger(nodeId) && nodeId > 0)
    if (abilityNodeIds.length === 0) return false
    const unlockedNodes = new Set(unlockedNodeIds)
    return abilityNodeIds.every(nodeId => unlockedNodes.has(nodeId))
}

function matchesBattleKind(battleKind: number, isMulti: boolean): boolean {
    return battleKind === 3 || battleKind === 2 && isMulti || battleKind === 1 && !isMulti
}

function isPlannedDefinition(
    definition: ActiveMissionMasterDefinition,
): definition is PlannedActiveMissionDefinition {
    return "questRange" in definition && "pattern" in definition
}

function getDefinitionPattern(definition: ActiveMissionMasterDefinition): number {
    return isPlannedDefinition(definition) ? definition.pattern : Number(definition.row[29])
}

function matchesDefinitionQuestRange(
    definition: ActiveMissionMasterDefinition,
    category: number,
    questId: number,
): boolean {
    return isPlannedDefinition(definition)
        ? matchesPlannedActiveMissionQuestRange(definition.questRange, category, questId)
        : matchesActiveMissionQuestRange(definition.row, category, questId)
}

export function collectActiveMissionConditionalBattleFacts(
    definitions: readonly ActiveMissionMasterDefinition[],
    context: ConditionalBattleContext,
    characters: Readonly<Record<string, ConditionalBattleCharacterState>>,
): ConditionalBattleFact[] {
    if (!context.questAccomplished) return []
    const partyCharacterIds = new Set(context.partyCharacterIds)
    const matched = new Map<string, ConditionalBattleFact>()
    for (const definition of definitions) {
        try {
            const pattern = getDefinitionPattern(definition)
            if (!CONDITIONAL_PATTERNS.has(pattern)) continue
            const battleKind = Number(definition.row[32])
            const characterId = Number(definition.row[43])
            if (!Number.isSafeInteger(battleKind)
                || !Number.isSafeInteger(characterId)
                || !matchesBattleKind(battleKind, context.isMulti)
                || !partyCharacterIds.has(characterId)
                || !matchesDefinitionQuestRange(
                    definition,
                    context.questCategory,
                    context.questId,
                )) continue
            const character = characters[String(characterId)]
            if (!character) continue
            if (pattern === 71 && !character.secondBoardAbilitiesComplete) continue
            if (pattern === 72 && character.level < 80) continue
            if (pattern === 73 && character.level < 100) continue
            matched.set(`${pattern}:${characterId}`, { pattern, characterId })
        } catch {
            continue
        }
    }
    return [...matched.values()].sort((left, right) => (
        left.pattern - right.pattern || left.characterId - right.characterId
    ))
}

function resolveDefinitions(
    context: ActiveBattleFactContext,
): readonly ActiveMissionMasterDefinition[] {
    return [...CONDITIONAL_PATTERNS].flatMap(pattern => context.plan.getDefinitionsByPattern(pattern))
}

function buildCharacterState(
    characterId: number,
    context: ActiveBattleFactContext,
): ConditionalBattleCharacterState | null {
    const growth = context.characterGrowthFacts[String(characterId)]
    if (!growth) return null
    let rarity = getCharacterDataSync(characterId)?.rarity
    if (context.repository) {
        try {
            rarity = context.repository.table<Record<string, { readonly rarity?: number }>>("character.json")
                [String(characterId)]?.rarity ?? rarity
        } catch {
            // Bundled character data remains the compatibility fallback.
        }
    }
    const secondBoard = getCharacterManaNodesSync(characterId, 2) ?? {}
    return {
        level: estimateActiveMissionCharacterLevel({
            ...growth,
            rarity,
            evolutionLevel: 0,
            overLimitStep: 0,
            bondTokenList: [],
        }),
        secondBoardAbilitiesComplete: hasCompletedSecondManaBoardAbilities(
            secondBoard,
            context.characterManaNodes[String(characterId)] ?? [],
        ),
    }
}

function createRecorderContext(context: FinishContext): ActiveBattleFactContext {
    let repository
    try {
        repository = getContentSnapshot().repository
    } catch {
        repository = undefined
    }
    return createActiveBattleFactContext(
        context,
        getActiveMissionPlan(repository),
        repository,
    )
}

export function recordActiveMissionConditionalBattleFactsSync(
    context: FinishContext,
    providedActiveContext?: ActiveBattleFactContext,
): void {
    if (!context.questAccomplished) return
    const activeContext = providedActiveContext ?? createRecorderContext(context)
    const definitions = resolveDefinitions(activeContext)
    const characters = Object.fromEntries(activeContext.targetCharacterIds.flatMap(characterId => {
        const state = buildCharacterState(characterId, activeContext)
        return state ? [[String(characterId), state]] : []
    }))
    const facts = collectActiveMissionConditionalBattleFacts(definitions, {
        questAccomplished: context.questAccomplished,
        isMulti: context.isMulti === true,
        questCategory: context.questCategory,
        questId: context.questId,
        partyCharacterIds: activeContext.allPartyCharacterIds,
    }, characters)
    for (const fact of facts) {
        incrementActiveMissionConditionalBattleFactSync(
            context.playerId,
            fact.pattern,
            fact.characterId,
        )
    }
}
