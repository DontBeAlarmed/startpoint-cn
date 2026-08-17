import { getPlayerCharacterSync } from "../data/domains/character"
import { getPlayerSync, updatePlayerSync } from "../data/domains/player"
import { givePlayerItemSync } from "../data/domains/item"
import { givePlayerCharacterSync } from "./character";
import { givePlayerEquipmentSync } from "./equipment";
import { CharacterReward, CurrencyReward, EquipmentItemReward, GivePlayerScoreRewardsResult, PlayerRewardResult, Reward, RewardType, ScoreReward } from "./types";
import { Player } from "../data/types";
import {
    selectScoreRewardGrantPlan,
    type ScoreRewardSelectionOptions,
    type ScoreRewardSource,
} from "./quest/score-reward-selection"
import {
    projectScoreRewardSettlementResult,
    recordScoreRewardSettlement,
} from "./quest/score-reward-settlement"

/**
 * Grants a player score rewards.
 * 
 * @param playerId The ID of the player.
 * @param groupId The ID of the score reward group.
 * @param scoreRewards The score rewards inside of the group.
 * @returns A result detailing what was added/changed.
 */
export function givePlayerScoreRewardsSync(
    playerId: number,
    groupId?: number,
    scoreRewards?: ScoreReward[],
    boostPointUsed: boolean = false,
    questElement?: number,
    lottery?: ScoreRewardSelectionOptions,
): GivePlayerScoreRewardsResult {
    const selection = selectScoreRewardGrantPlan(
        groupId,
        scoreRewards,
        boostPointUsed,
        questElement,
        lottery,
    )
    let mana = 0
    let vmoney = 0
    let expPool = 0
    let joinedCharacterIdList: number[] = []
    let characterList: Object[] = []
    let equipmentList: Object[] = []
    let items: Record<string, number> = {}
    const settledEntries: Array<{
        readonly source: ScoreRewardSource
        readonly reward: typeof selection.plan.entries[number]["reward"]
    }> = []

    for (const entry of selection.plan.entries) {
        const reward = entry.reward
        if (entry.source.kind === "score_common") {
            switch (reward.type) {
                case RewardType.ITEM:
                case RewardType.ELEMENT:
                case RewardType.AETHER:
                    items[String(reward.id)] = givePlayerItemSync(
                        playerId,
                        reward.id,
                        reward.count,
                    )
                    break
                case RewardType.MANA: {
                    const player = getPlayerSync(playerId)
                    mana += reward.count
                    updatePlayerSync({
                        id: playerId,
                        freeMana: (player?.freeMana || 0) + reward.count,
                        totalManaObtained: (player?.totalManaObtained || 0) + reward.count,
                    })
                    break
                }
                case RewardType.EXP: {
                    const player = getPlayerSync(playerId)
                    expPool += reward.count
                    updatePlayerSync({
                        id: playerId,
                        expPool: (player?.expPool || 0) + reward.count,
                    })
                    break
                }
                default:
                    throw new RangeError(`unsupported common score reward type ${reward.type}`)
            }
            settledEntries.push(entry)
            continue
        }

        const result = givePlayerRewardSync(playerId, reward)
        if (!result) continue
        settledEntries.push(entry)
        mana += result.user_info.free_mana
        vmoney += result.user_info.free_vmoney
        joinedCharacterIdList = [...joinedCharacterIdList, ...result.joined_character_id_list]
        characterList = [...characterList, ...result.character_list]
        equipmentList = [...equipmentList, ...result.equipment_list]
        for (const [itemId, count] of Object.entries(result.items)) {
            items[itemId] = count
        }
    }

    const result = projectScoreRewardSettlementResult(selection, {
        user_info: {
            free_mana: mana,
            free_vmoney: vmoney,
            exp_pool: expPool
        },
        character_list: characterList,
        joined_character_id_list: joinedCharacterIdList,
        equipment_list: equipmentList,
        items,
    }, settledEntries)
    recordScoreRewardSettlement(playerId, selection, result)
    return result
}

/**
 * Batch gives a specific player data an array of rewards.
 * 
 * @param playerId The ID of the player to reward.
 * @param rewards The array of rewards to give.
 * @returns A PlayerRewardResult.
 */
export function givePlayerRewardsSync(
    playerId: number,
    rewards: Reward[]
): PlayerRewardResult | null {
    let mana = 0
    let vmoney = 0
    let expPool = 0
    let joinedCharacterIdList: number[] = []
    let characters: Map<number, Object> = new Map()
    let equipment: Map<number, Object> = new Map()
    let items: Map<number, number> = new Map()

    for (const reward of rewards) {
        switch (reward.type) {
            case RewardType.ITEM: {
                const convertedReward = (reward as EquipmentItemReward)
                const itemId = convertedReward.id
                const result = givePlayerItemSync(playerId, itemId, convertedReward.count);
                items.set(itemId, (items.get(itemId) ?? 0) + result)
                break;
            }
            case RewardType.EQUIPMENT: {
                const convertedReward = (reward as EquipmentItemReward)
                const equipmentId = convertedReward.id
                const result = givePlayerEquipmentSync(playerId, equipmentId, convertedReward.count)
                equipment.set(equipmentId, result)
                break;
            }
            case RewardType.CHARACTER: {
                const characterId = (reward as CharacterReward).id
                const giveResult = givePlayerCharacterSync(playerId, characterId)

                const giveItem = giveResult?.item
                if (giveItem !== undefined) {
                    const itemId = giveItem.id
                    items.set(itemId, (items.get(itemId) ?? 0) + giveItem.count)
                }
    
                const giveCharacter = giveResult?.character
                if (giveCharacter !== undefined) {
                    characters.set(characterId, giveCharacter)
                }
                break;
            }
            case RewardType.BEADS: {
                vmoney += (reward as CurrencyReward).count
                break;
            }
            case RewardType.MANA: {
                mana += (reward as CurrencyReward).count
                break;
            }
            case RewardType.EXP: {
                expPool += (reward as CurrencyReward).count
                break;
            }
            case RewardType.ELEMENT:
            case RewardType.AETHER: {
                const convertedReward = (reward as EquipmentItemReward)
                const itemId = convertedReward.id
                const result = givePlayerItemSync(playerId, itemId, convertedReward.count);
                items.set(itemId, (items.get(itemId) ?? 0) + result)
                break;
            }
        }
    }

    if (mana > 0 || vmoney > 0 || expPool > 0) {
        // get player
        const player = getPlayerSync(playerId)
        if (player === null) return null;

        updatePlayerSync({
            id: playerId,
            freeVmoney: player.freeVmoney + vmoney,
            freeMana: player.freeMana + mana,
            expPool: player.expPool + expPool,
            totalManaObtained: (player.totalManaObtained || 0) + mana
        })
    }
    
    // build return values
    const characterList: Object[] = []
    const equipmentList: Object[] = []
    const itemsRecord: Record<string, number> = {}
    
    characters.forEach(character => {
        characterList.push(character)
    })

    equipment.forEach(equipment => {
        equipmentList.push(equipment)
    })

    items.forEach((number, id) => {
        itemsRecord[id] = number
    })

    return {   
        user_info: {
            free_mana: mana,
            free_vmoney: vmoney,
            exp_pool: expPool
        },
        character_list: characterList,
        joined_character_id_list: joinedCharacterIdList,
        equipment_list: equipmentList,
        items: itemsRecord
    }
}

/**
 * Gives a player a specific reward.
 * 
 * @param playerId The ID of the player.
 * @param reward The reward to give.
 * @returns A PlayerRewardResult.
 */
export function givePlayerRewardSync(
    playerId: number,
    reward: Reward
): PlayerRewardResult | null {
    return givePlayerRewardsSync(playerId, [reward])
}
