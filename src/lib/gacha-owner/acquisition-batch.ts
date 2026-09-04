import { getDb } from "../../data/db"
import { getPlayerEquipmentsByIdsSync } from "../../data/domains/equipment"
import {
    persistCharacterAcquisitionBatchSync,
    persistEquipmentAcquisitionBatchSync,
    getCharacterAcquisitionStatesSync,
} from "../../data/domains/reward-acquisition"
import type { PlayerCharacter, PlayerEquipment } from "../../data/types"
import { getRealNow } from "../../runtime/time/game-time"
import { getCharacterDataSync } from "../assets"
import { clientSerializeEquipment } from "../equipment"
import {
    getCharacterStackCompensationItemId,
} from "../character-growth/commands/grant-character-stack"
import {
    STACK_CHARACTER_GROWTH_FIELDS,
    characterGrowthProjectionStateFromPlayerCharacter,
    projectCharacterGrowthEntry,
} from "../character-growth/response-projector"
import { addSafeInteger } from "../character-growth/mutation-support"
import { recordHundredCharactersMilestoneSync } from "../player-history-milestones"
import type {
    RewardGrantAssetAcquisition,
    RewardGrantExecutionPlan,
    RewardGrantObjectSnapshot,
} from "../reward-grant"
import { RewardType } from "../types/rewards"
import type { Element } from "../types"

interface CharacterWorkingState {
    character: PlayerCharacter
    readonly wasOwned: boolean
}

interface EquipmentWorkingState {
    equipment: PlayerEquipment
}

export interface PreparedGachaAcquisitionBatch {
    readonly assetAcquisition: RewardGrantAssetAcquisition
    readonly compensationItemIds: readonly number[]
}

function newCharacter(characterId: number, evaluationTime: Date): PlayerCharacter | null {
    const asset = getCharacterDataSync(characterId)
    if (asset === null) return null
    return {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 0,
        protection: false,
        joinTime: evaluationTime,
        updateTime: evaluationTime,
        exp: 0,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: asset.skill_count > 3
            ? [
                { manaBoardIndex: 1, status: 0 },
                { manaBoardIndex: 2, status: 0 },
            ]
            : [{ manaBoardIndex: 1, status: 0 }],
    }
}

function newCharacterProjection(characterId: number, character: PlayerCharacter) {
    return projectCharacterGrowthEntry({
        characterId,
        character,
        state: characterGrowthProjectionStateFromPlayerCharacter(characterId, character),
        viewerId: 0,
        fields: [
            "entry_count",
            "exp",
            "exp_total",
            "bond_token_list",
            "mana_board_index",
            "create_time",
            "update_time",
            "join_time",
        ],
    }) as RewardGrantObjectSnapshot
}

function stackProjection(characterId: number, character: PlayerCharacter) {
    return projectCharacterGrowthEntry({
        characterId,
        character,
        state: characterGrowthProjectionStateFromPlayerCharacter(characterId, character),
        fields: STACK_CHARACTER_GROWTH_FIELDS,
    }) as RewardGrantObjectSnapshot
}

export function prepareGachaAcquisitionBatchSync(
    playerId: number,
    plan: RewardGrantExecutionPlan,
): PreparedGachaAcquisitionBatch {
    if (!getDb().inTransaction) throw new Error("Gacha acquisition batch requires a transaction")
    if (plan.entries.length < 1 || plan.entries.length > 10) {
        throw new TypeError("Gacha acquisition batch must contain 1 through 10 prizes")
    }
    const characterIds = plan.entries.flatMap(entry => (
        entry.type === RewardType.CHARACTER ? [entry.id] : []
    ))
    const equipmentIds = plan.entries.flatMap(entry => (
        entry.type === RewardType.EQUIPMENT ? [entry.id] : []
    ))
    const existingCharacters = getCharacterAcquisitionStatesSync(
        playerId,
        characterIds,
    )
    const existingEquipment = getPlayerEquipmentsByIdsSync(playerId, equipmentIds)
    const characterState = new Map<string, CharacterWorkingState>(
        Object.entries(existingCharacters).map(([id, character]) => [id, {
            character,
            wasOwned: true,
        }]),
    )
    const equipmentState = new Map<string, EquipmentWorkingState>(
        Object.entries(existingEquipment).map(([id, equipment]) => [id, { equipment }]),
    )
    const initiallyAvailableCharacters = new Set(Object.keys(existingCharacters))
    const compensationItemIds = new Set<number>()
    for (const characterId of characterIds) {
        const key = String(characterId)
        if (initiallyAvailableCharacters.has(key)) {
            const asset = getCharacterDataSync(characterId)
            if (asset !== null) {
                const itemId = getCharacterStackCompensationItemId(
                    asset.rarity,
                    asset.element as Element,
                )
                if (itemId !== undefined) compensationItemIds.add(itemId)
            }
        }
        initiallyAvailableCharacters.add(key)
    }
    const evaluationTime = getRealNow()
    let persisted = false
    const assetAcquisition: RewardGrantAssetAcquisition = {
        grantCharacter(characterId, grantCompensation) {
            const key = String(characterId)
            const current = characterState.get(key)
            if (current === undefined) {
                const character = newCharacter(characterId, evaluationTime)
                if (character === null) return null
                characterState.set(key, { character, wasOwned: false })
                return {
                    isNew: true,
                    character: newCharacterProjection(characterId, character),
                }
            }
            const asset = getCharacterDataSync(characterId)
            if (asset === null) return null
            const itemId = getCharacterStackCompensationItemId(
                asset.rarity,
                asset.element as Element,
            )
            if (itemId !== undefined) grantCompensation(itemId, 1)
            const character = {
                ...current.character,
                stack: addSafeInteger(current.character.stack, 1, "character.stack"),
                updateTime: evaluationTime,
            }
            current.character = character
            return {
                isNew: false,
                character: stackProjection(characterId, character),
                ...(itemId === undefined ? {} : { item: { id: itemId, count: 1 } }),
            }
        },
        grantEquipment(equipmentId, amount) {
            const key = String(equipmentId)
            const current = equipmentState.get(key)
            const equipment: PlayerEquipment = current === undefined
                ? {
                    enhancementLevel: 0,
                    level: 1,
                    protection: false,
                    stack: amount - 1,
                }
                : {
                    ...current.equipment,
                    stack: addSafeInteger(current.equipment.stack, amount, "equipment.stack"),
                }
            equipmentState.set(key, { equipment })
            return clientSerializeEquipment(equipmentId, equipment) as RewardGrantObjectSnapshot
        },
        persistFinalStates() {
            if (persisted) throw new Error("Gacha acquisition batch already persisted")
            persistCharacterAcquisitionBatchSync(
                playerId,
                [...characterState.entries()].map(([id, state]) => ({
                    characterId: Number(id),
                    character: state.character,
                    wasOwned: state.wasOwned,
                })),
            )
            persistEquipmentAcquisitionBatchSync(
                playerId,
                [...equipmentState.entries()].map(([id, state]) => ({
                    equipmentId: Number(id),
                    equipment: state.equipment,
                })),
            )
            if ([...characterState.values()].some(state => !state.wasOwned)) {
                recordHundredCharactersMilestoneSync(playerId, evaluationTime)
            }
            persisted = true
        },
    }
    return {
        assetAcquisition,
        compensationItemIds: [...compensationItemIds].sort((left, right) => left - right),
    }
}
