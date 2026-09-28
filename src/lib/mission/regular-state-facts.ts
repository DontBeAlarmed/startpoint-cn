import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import { getCharacterFacts } from "../character-content"
import {
    getPlayerCharactersManaNodesSync,
    getPlayerCharactersSync,
} from "../../data/domains/character"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerCollectedItemTotalSync } from "../../data/domains/item"
import type { PlayerCharacter, PlayerEquipment } from "../../data/types"
import { getEquipmentCurrencyPolicySync } from "../config-content"
import { characterExpCaps } from "../character"

type RawCharacterTable = Record<string, { readonly rarity?: unknown }>
type RawManaBoard = Record<string, Record<string, Record<string, readonly unknown[][]>>>

export interface RegularStateFacts {
    characterCount: number
    level80CharacterCount: number
    maxCharacterLevel: number
    manaBoardNodeCount: number
    overLimitCount: number
    bondTokenCount: number
    equipmentKindCount: number
    equipmentAwakeningCount: number
    maxLevelEquipmentCount: number
    secondManaBoardOpenCount: number
    secondManaBoardCompleteCount: number
    craftPointObtainedCount: number
}

export interface RegularStateFactSources {
    readonly characters?: Readonly<Record<string, PlayerCharacter>>
    readonly characterManaNodes?: Readonly<Record<string, readonly number[]>>
    readonly equipment?: Readonly<Record<string, PlayerEquipment>>
    readonly collectedItemTotals?: Readonly<Record<string, number>>
    readonly characterTable?: RawCharacterTable
    readonly manaBoardTable?: RawManaBoard
    readonly craftPointItemId: number
}

function reachesCharacterLevel80(rarity: number, experience: number): boolean {
    const thresholds = characterExpCaps[rarity]
    if (!thresholds || !Number.isSafeInteger(experience) || experience < 0) return false
    const baseLevel = 40 + (rarity - 1) * 10
    const thresholdIndex = (80 - baseLevel) / 5
    return Number.isInteger(thresholdIndex)
        && thresholdIndex >= 0
        && thresholdIndex < thresholds.length
        && experience >= thresholds[thresholdIndex]
}

function provenCharacterLevel(rarity: number, experience: number): number {
    const thresholds = characterExpCaps[rarity]
    if (!thresholds || !Number.isSafeInteger(experience) || experience < 0) return 0
    const baseLevel = 40 + (rarity - 1) * 10
    let level = 0
    for (let index = 0; index < thresholds.length; index++) {
        if (experience >= thresholds[index]) level = baseLevel + index * 5
    }
    return level
}

function characterFactsTable(characterIds: readonly string[]): RawCharacterTable {
    const facts = getCharacterFacts()
    const table: Record<string, { rarity: number }> = {}
    for (const id of characterIds) {
        const entry = facts.get(id)
        if (entry !== null) table[id] = { rarity: entry.rarity }
    }
    return table
}

function getSecondBoardNodeIds(
    boardTable: RawManaBoard,
    characterId: string,
): ReadonlySet<number> | null {
    const board = boardTable[characterId]?.["2"]
    if (!board || Object.keys(board).length === 0) return null
    const nodeIds = new Set<number>()
    for (const rows of Object.values(board)) {
        const nodeId = Number(rows[0]?.[0])
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return null
        nodeIds.add(nodeId)
    }
    return nodeIds.size > 0 ? nodeIds : null
}

export function deriveRegularStateFacts(sources: RegularStateFactSources): RegularStateFacts {
    const characters = sources.characters ?? {}
    const manaNodes = sources.characterManaNodes ?? {}
    const equipment = sources.equipment ?? {}
    const characterTable = sources.characterTable ?? {}
    const manaBoardTable = sources.manaBoardTable ?? {}

    let level80CharacterCount = 0
    let maxCharacterLevel = 0
    let secondManaBoardOpenCount = 0
    let secondManaBoardCompleteCount = 0
    for (const [characterId, character] of Object.entries(characters)) {
        const rarity = Number(characterTable[characterId]?.rarity)
        if (Number.isSafeInteger(rarity)) {
            if (reachesCharacterLevel80(rarity, character.exp)) {
                level80CharacterCount++
            }
            maxCharacterLevel = Math.max(maxCharacterLevel, provenCharacterLevel(rarity, character.exp))
        }
        const secondBoardNodeIds = getSecondBoardNodeIds(manaBoardTable, characterId)
        if (secondBoardNodeIds === null) continue
        if (character.manaBoardIndex >= 2) secondManaBoardOpenCount++
        const learned = new Set(manaNodes[characterId] ?? [])
        if ([...secondBoardNodeIds].every(nodeId => learned.has(nodeId))) {
            secondManaBoardCompleteCount++
        }
    }

    let equipmentAwakeningCount = 0
    let maxLevelEquipmentCount = 0
    for (const item of Object.values(equipment)) {
        equipmentAwakeningCount += Math.max(0, item.level - 1)
        if (item.level >= 5) maxLevelEquipmentCount++
    }

    return {
        characterCount: Object.keys(characters).length,
        level80CharacterCount,
        maxCharacterLevel,
        manaBoardNodeCount: Object.values(manaNodes)
            .reduce((total, nodes) => total + nodes.length, 0),
        overLimitCount: Object.values(characters)
            .reduce((total, character) => total + character.overLimitStep, 0),
        bondTokenCount: Object.values(characters)
            .reduce((total, character) => total
                + character.bondTokenList.filter(token => token.status >= 1).length, 0),
        equipmentKindCount: Object.keys(equipment).length,
        equipmentAwakeningCount,
        maxLevelEquipmentCount,
        secondManaBoardOpenCount,
        secondManaBoardCompleteCount,
        craftPointObtainedCount: sources.collectedItemTotals?.[String(sources.craftPointItemId)] ?? 0,
    }
}

export function getRegularStateFactsSync(playerId: number): RegularStateFacts {
    const craftPointItemId = getEquipmentCurrencyPolicySync().craftPointItemId
    const characters = getPlayerCharactersSync(playerId)
    return deriveRegularStateFacts({
        characters,
        characterManaNodes: getPlayerCharactersManaNodesSync(playerId),
        equipment: getPlayerEquipmentListSync(playerId),
        collectedItemTotals: {
            [String(craftPointItemId)]: getPlayerCollectedItemTotalSync(
                playerId,
                craftPointItemId,
            ),
        },
        characterTable: characterFactsTable(Object.keys(characters)),
        manaBoardTable: getContentSnapshot().repository.table<RawManaBoard>("mana_board.json"),
        craftPointItemId,
    })
}
