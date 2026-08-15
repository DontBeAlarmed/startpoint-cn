import bundledCharacters from "../../../assets/character.json"
import bundledManaBoard from "../../../assets/mana_board.json"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import {
    getPlayerCharactersManaNodesSync,
    getPlayerCharactersSync,
} from "../../data/domains/character"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerCollectedItemTotalSync } from "../../data/domains/item"
import type { PlayerCharacter, PlayerEquipment } from "../../data/types"
import { getConfigSync } from "../assets"
import { characterExpCaps } from "../character"

type RawCharacterTable = Record<string, { readonly rarity?: unknown }>
type RawManaBoard = Record<string, Record<string, Record<string, readonly unknown[][]>>>

export interface RegularStateFacts {
    characterCount: number
    level80CharacterCount: number
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
    let secondManaBoardOpenCount = 0
    let secondManaBoardCompleteCount = 0
    for (const [characterId, character] of Object.entries(characters)) {
        const rarity = Number(characterTable[characterId]?.rarity)
        if (Number.isSafeInteger(rarity) && reachesCharacterLevel80(rarity, character.exp)) {
            level80CharacterCount++
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
    const craftPointItemId = getConfigSync().craft_point_item_id || 100000
    return deriveRegularStateFacts({
        characters: getPlayerCharactersSync(playerId),
        characterManaNodes: getPlayerCharactersManaNodesSync(playerId),
        equipment: getPlayerEquipmentListSync(playerId),
        collectedItemTotals: {
            [String(craftPointItemId)]: getPlayerCollectedItemTotalSync(
                playerId,
                craftPointItemId,
            ),
        },
        characterTable: getRuntimeContentTableSync<RawCharacterTable>(
            "character.json",
            bundledCharacters as RawCharacterTable,
        ),
        manaBoardTable: getRuntimeContentTableSync<RawManaBoard>(
            "mana_board.json",
            bundledManaBoard as RawManaBoard,
        ),
        craftPointItemId,
    })
}
