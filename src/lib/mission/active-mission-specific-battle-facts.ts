import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { incrementActiveMissionBattleFactSync } from "../../data/domains/active_mission_battle_facts"
import type { FinishContext } from "../quest/finish/types"
import { getActiveMissionMasterDefinitions, type ActiveMissionMasterDefinition } from "./active-master-data"
import { matchesActiveMissionQuestRange } from "./active-reconciliation"

const LOADOUT_PATTERN = 89
const SKILL_EFFECT_PATTERN = 90
const FULL_SKILL_START_PATTERN = 91

export interface ActiveMissionBattleCharacterState {
    readonly element: number
}

export interface ActiveMissionSkillEffectState {
    readonly stringId: string
    readonly unisonable: boolean
    readonly effects: readonly string[]
}

export interface ActiveMissionBattleContext {
    readonly questAccomplished: boolean
    readonly isMulti: boolean
    readonly questCategory: number
    readonly questId: number
    readonly partyCharacterIds: readonly number[]
    readonly unisonCharacterIds?: readonly number[]
    readonly equipmentElements?: readonly number[]
    readonly zones?: readonly {
        readonly skill_point_over_on_start?: number
    }[]
    readonly skillEffects?: Readonly<Record<string, ActiveMissionSkillEffectState>>
}

export interface ActiveMissionBattleFact {
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
    characters: Readonly<Record<string, ActiveMissionBattleCharacterState>>,
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

function hasThreeFullSkillGaugesOnStart(
    zones: ActiveMissionBattleContext["zones"],
): boolean {
    if (!Array.isArray(zones) || zones.length === 0) return false
    let total = 0
    for (const zone of zones) {
        const count = zone?.skill_point_over_on_start
        if (!Number.isSafeInteger(count) || count < 0 || count > 3) return false
        total += count
        if (total > 3) return false
    }
    return total === 3
}

function parseEffectList(value: unknown): string[] | null {
    if (typeof value !== "string") return null
    const effects = value.split(",").map(item => item.trim()).filter(Boolean)
    if (effects.length === 0 || effects.some(effect => !/^[A-Za-z][A-Za-z0-9_]*$/.test(effect))) return null
    return [...new Set(effects)]
}

function matchesSkillEffects(
    targetEffects: readonly string[] | null,
    ignoredCharacter: unknown,
    partyCharacterIds: ReadonlySet<number>,
    unisonCharacterIds: ReadonlySet<number>,
    skillEffects: Readonly<Record<string, ActiveMissionSkillEffectState>> | undefined,
): boolean {
    if (targetEffects === null || !skillEffects) return false
    const ignored = ignoredCharacter === undefined || ignoredCharacter === null || ignoredCharacter === "(None)"
        ? new Set<string>()
        : new Set(String(ignoredCharacter).split(",").map(item => item.trim()).filter(Boolean))
    for (const characterId of partyCharacterIds) {
        const candidate = skillEffects[String(characterId)]
        if (!candidate || ignored.has(candidate.stringId)) continue
        if (targetEffects.some(effect => candidate.effects.includes(effect))) return true
    }
    for (const characterId of unisonCharacterIds) {
        const candidate = skillEffects[String(characterId)]
        if (!candidate || !candidate.unisonable || ignored.has(candidate.stringId)) continue
        if (targetEffects.some(effect => candidate.effects.includes(effect))) return true
    }
    return false
}

export function collectActiveMissionSpecificBattleFacts(
    definitions: readonly ActiveMissionMasterDefinition[],
    context: ActiveMissionBattleContext,
    characters: Readonly<Record<string, ActiveMissionBattleCharacterState>>,
): ActiveMissionBattleFact[] {
    if (!context.questAccomplished) return []
    const partyCharacterIds = new Set(context.partyCharacterIds)
    const unisonCharacterIds = new Set(context.unisonCharacterIds ?? [])
    // Loadout missions without a leader/slot selector apply to every character in the party.
    const allCharacterIds = new Set([...partyCharacterIds, ...unisonCharacterIds])
    const matched: ActiveMissionBattleFact[] = []
    for (const definition of definitions) {
        try {
            const pattern = Number(definition.row[29])
            const battleKind = Number(definition.row[32])
            if (!Number.isSafeInteger(battleKind)
                || !matchesBattleKind(battleKind, context.isMulti)
                || !matchesActiveMissionQuestRange(definition.row, context.questCategory, context.questId)) continue
            if (pattern === LOADOUT_PATTERN
                && matchesCharacterElement(
                    parseTargetElement(definition.row[69]),
                    allCharacterIds,
                    characters,
                )
                && matchesEquipmentElement(definition.row[70], context.equipmentElements)) {
                matched.push({ missionId: definition.missionId })
            } else if (pattern === FULL_SKILL_START_PATTERN
                && hasThreeFullSkillGaugesOnStart(context.zones)) {
                matched.push({ missionId: definition.missionId })
            } else if (pattern === SKILL_EFFECT_PATTERN
                && matchesSkillEffects(
                    parseEffectList(definition.row[69]),
                    definition.row[70],
                    partyCharacterIds,
                    unisonCharacterIds,
                    context.skillEffects,
                )) {
                matched.push({ missionId: definition.missionId })
            }
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

export function recordActiveMissionSpecificBattleFactsSync(context: FinishContext): void {
    if (!context.questAccomplished) return
    const repository = resolveRepository()
    const definitions = resolveDefinitions(repository)
    const partyCharacterIds = context.party.characters
        .flatMap(character => character?.id ? [character.id] : [])
    const unisonCharacterIds = context.party.unison_characters
        .flatMap(character => character?.id ? [character.id] : [])
    const allCharacterIds = [...partyCharacterIds, ...unisonCharacterIds]
    const targetCharacterIds = new Set(definitions.flatMap(definition => {
        const pattern = Number(definition.row[29])
        const targetElement = parseTargetElement(definition.row[69])
        return pattern === LOADOUT_PATTERN && targetElement !== null
            ? allCharacterIds
            : []
    }))
    let characterTable: Record<string, { readonly element?: number }> = {}
    if (repository) {
        try {
            characterTable = repository.table<Record<string, { readonly element?: number }>>("character.json")
        } catch {
            characterTable = {}
        }
    }
    const characters: Record<string, ActiveMissionBattleCharacterState> = {}
    for (const characterId of targetCharacterIds) {
        const element = characterTable?.[String(characterId)]?.element
        if (Number.isSafeInteger(element)) characters[String(characterId)] = { element: element as number }
    }
    let skillEffects: Readonly<Record<string, ActiveMissionSkillEffectState>> | undefined
    if (definitions.some(definition => Number(definition.row[29]) === SKILL_EFFECT_PATTERN)) {
        try {
            skillEffects = getContentSnapshot().repository.table<{
                readonly schemaVersion?: number
                readonly characters?: Readonly<Record<string, ActiveMissionSkillEffectState>>
            }>("cdndata/active_mission_skill_effects.json").characters
        } catch {
            skillEffects = undefined
        }
    }
    const facts = collectActiveMissionSpecificBattleFacts(definitions, {
        questAccomplished: context.questAccomplished,
        isMulti: context.isMulti === true,
        questCategory: context.questCategory,
        questId: context.questId,
        partyCharacterIds,
        unisonCharacterIds,
        equipmentElements: context.equipmentElements,
        zones: context.statistics.zones,
        skillEffects,
    }, characters)
    for (const fact of facts) {
        incrementActiveMissionBattleFactSync(context.playerId, fact.missionId)
    }
}
