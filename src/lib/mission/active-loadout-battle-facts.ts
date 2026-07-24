import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { incrementActiveMissionBattleFactSync } from "../../data/domains/active_mission_battle_facts"
import type { FinishContext } from "../quest/finish/types"
import { getActiveMissionMasterDefinitions, type ActiveMissionMasterDefinition } from "./active-master-data"
import { matchesActiveMissionQuestRange } from "./active-reconciliation"

const LOADOUT_PATTERNS = new Set([89])

export interface LoadoutBattleCharacterState {
    readonly element: number
}

export interface LoadoutBattleContext {
    readonly questAccomplished: boolean
    readonly isMulti: boolean
    readonly questCategory: number
    readonly questId: number
    readonly partyCharacterIds: readonly number[]
    readonly equipmentElements?: readonly number[]
}

export interface LoadoutBattleFact {
    readonly missionId: number
}

function matchesBattleKind(battleKind: number, isMulti: boolean): boolean {
    return battleKind === 3 || battleKind === 2 && isMulti || battleKind === 1 && !isMulti
}

function parseTargetElement(value: unknown): number | null {
    const target = Number(value)
    return Number.isSafeInteger(target) && target >= 1 && target <= 6 ? target : null
}

function matchesCharacterElement(
    targetElement: number | null,
    partyCharacterIds: ReadonlySet<number>,
    characters: Readonly<Record<string, LoadoutBattleCharacterState>>,
): boolean {
    if (targetElement === null) return false
    for (const characterId of partyCharacterIds) {
        const character = characters[String(characterId)]
        if (character && character.element + 1 === targetElement) return true
    }
    return false
}

function matchesEquipmentElement(
    rawTargetElement: unknown,
    equipmentElements: readonly number[] | undefined,
): boolean {
    if (rawTargetElement === undefined || rawTargetElement === null || rawTargetElement === "(None)") return true
    const targetElement = parseTargetElement(rawTargetElement)
    if (targetElement === null || equipmentElements === undefined) return false
    // The finish request contains ElementKind (0-based); the mission master uses ElementTargetKind (1-based).
    return equipmentElements.some(element => Number(element) + 1 === targetElement)
}

export function collectActiveMissionLoadoutBattleFacts(
    definitions: readonly ActiveMissionMasterDefinition[],
    context: LoadoutBattleContext,
    characters: Readonly<Record<string, LoadoutBattleCharacterState>>,
): LoadoutBattleFact[] {
    if (!context.questAccomplished) return []
    const partyCharacterIds = new Set(context.partyCharacterIds)
    const matched: LoadoutBattleFact[] = []
    for (const definition of definitions) {
        try {
            const pattern = Number(definition.row[29])
            const battleKind = Number(definition.row[32])
            if (!LOADOUT_PATTERNS.has(pattern)
                || !Number.isSafeInteger(battleKind)
                || !matchesBattleKind(battleKind, context.isMulti)
                || !matchesActiveMissionQuestRange(definition.row, context.questCategory, context.questId)
                || !matchesCharacterElement(
                    parseTargetElement(definition.row[69]),
                    partyCharacterIds,
                    characters,
                )
                || !matchesEquipmentElement(definition.row[70], context.equipmentElements)) continue
            matched.push({ missionId: definition.missionId })
        } catch {
            continue
        }
    }
    return matched.sort((left, right) => left.missionId - right.missionId)
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

export function recordActiveMissionLoadoutBattleFactsSync(context: FinishContext): void {
    if (!context.questAccomplished) return
    const repository = resolveRepository()
    const definitions = resolveDefinitions(repository)
    const partyCharacterIds = [...context.party.characters, ...context.party.unison_characters]
        .flatMap(character => character?.id ? [character.id] : [])
    const targetCharacterIds = new Set(definitions.flatMap(definition => {
        const pattern = Number(definition.row[29])
        const targetElement = parseTargetElement(definition.row[69])
        return LOADOUT_PATTERNS.has(pattern) && targetElement !== null
            ? partyCharacterIds
            : []
    }))
    let characterTable: Record<string, { readonly element?: number }> = {}
    if (repository) {
        try {
            characterTable = repository.table<Record<string, { readonly element?: number }>>("character.json")
        } catch {
            return
        }
    }
    const characters: Record<string, LoadoutBattleCharacterState> = {}
    for (const characterId of targetCharacterIds) {
        const element = characterTable?.[String(characterId)]?.element
        if (Number.isSafeInteger(element)) characters[String(characterId)] = { element: element as number }
    }
    const facts = collectActiveMissionLoadoutBattleFacts(definitions, {
        questAccomplished: context.questAccomplished,
        isMulti: context.isMulti === true,
        questCategory: context.questCategory,
        questId: context.questId,
        partyCharacterIds,
        equipmentElements: context.equipmentElements,
    }, characters)
    for (const fact of facts) {
        incrementActiveMissionBattleFactSync(context.playerId, fact.missionId)
    }
}
