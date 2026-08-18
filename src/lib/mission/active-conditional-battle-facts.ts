import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { getPlayerCharacterSync, getPlayerCharacterManaNodesSync } from "../../data/domains/character"
import { incrementActiveMissionConditionalBattleFactSync } from "../../data/domains/active_mission_battle_condition_facts"
import { getCharacterDataSync, getCharacterManaNodesSync } from "../assets"
import type { FinishContext } from "../quest/finish/types"
import { getActiveMissionMasterDefinitions, type ActiveMissionMasterDefinition } from "./active-master-data"
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
            const pattern = Number(definition.row[29])
            if (!CONDITIONAL_PATTERNS.has(pattern)) continue
            const battleKind = Number(definition.row[32])
            const characterId = Number(definition.row[43])
            if (!Number.isSafeInteger(battleKind)
                || !Number.isSafeInteger(characterId)
                || !matchesBattleKind(battleKind, context.isMulti)
                || !partyCharacterIds.has(characterId)
                || !matchesActiveMissionQuestRange(
                    definition.row,
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

function resolveRepository(): ReadonlyContentRepository | undefined {
    try {
        return getContentSnapshot().repository
    } catch {
        return undefined
    }
}

function resolveDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionMasterDefinition[] {
    if (!repository) return getActiveMissionMasterDefinitions()
    try {
        return getActiveMissionMasterDefinitions(repository)
    } catch {
        return getActiveMissionMasterDefinitions()
    }
}

function buildCharacterState(
    playerId: number,
    characterId: number,
    repository?: ReadonlyContentRepository,
): ConditionalBattleCharacterState | null {
    const character = getPlayerCharacterSync(playerId, characterId)
    if (!character) return null
    let rarity = getCharacterDataSync(characterId)?.rarity
    if (repository) {
        try {
            rarity = repository.table<Record<string, { readonly rarity?: number }>>("character.json")
                [String(characterId)]?.rarity ?? rarity
        } catch {
            // Bundled character data remains the compatibility fallback.
        }
    }
    const secondBoard = getCharacterManaNodesSync(characterId, 2) ?? {}
    return {
        level: estimateActiveMissionCharacterLevel({ ...character, rarity }),
        secondBoardAbilitiesComplete: hasCompletedSecondManaBoardAbilities(
            secondBoard,
            getPlayerCharacterManaNodesSync(playerId, characterId),
        ),
    }
}

export function recordActiveMissionConditionalBattleFactsSync(context: FinishContext): void {
    if (!context.questAccomplished) return
    const repository = resolveRepository()
    const definitions = resolveDefinitions(repository)
    const partyCharacterIds = [...context.party.characters, ...context.party.unison_characters]
        .flatMap(character => character?.id ? [character.id] : [])
    const partyCharacterIdSet = new Set(partyCharacterIds)
    const targetCharacterIds = new Set(definitions.flatMap(definition => {
        const pattern = Number(definition.row[29])
        const characterId = Number(definition.row[43])
        return CONDITIONAL_PATTERNS.has(pattern)
            && Number.isSafeInteger(characterId)
            && partyCharacterIdSet.has(characterId)
            ? [characterId]
            : []
    }))
    const characters = Object.fromEntries([...targetCharacterIds].flatMap(characterId => {
        const state = buildCharacterState(context.playerId, characterId, repository)
        return state ? [[String(characterId), state]] : []
    }))
    const facts = collectActiveMissionConditionalBattleFacts(definitions, {
        questAccomplished: context.questAccomplished,
        isMulti: context.isMulti === true,
        questCategory: context.questCategory,
        questId: context.questId,
        partyCharacterIds,
    }, characters)
    for (const fact of facts) {
        incrementActiveMissionConditionalBattleFactSync(
            context.playerId,
            fact.pattern,
            fact.characterId,
        )
    }
}
