import { randomInt } from "crypto";
import { getPlayerCharacterSync, getPlayerSync, givePlayerItemSync, updatePlayerSync } from "../data/wdfpData";
import { getRareScoreRewardGroup } from "./assets";
import { givePlayerCharacterSync } from "./character";
import { givePlayerEquipmentSync } from "./equipment";
import { CharacterReward, CommonScoreReward, CurrencyReward, CurrencyScoreReward, DropScoreRewardId, EquipmentItemReward, GivePlayerScoreRewardsResult, ItemScoreReward, PlayerRewardResult, RareScoreRewardGroup, Reward, RewardType, ScoreReward, ScoreRewardType } from "./types";
import { Player } from "../data/types";
import rewardElementMap from "../../assets/reward_element_map.json";

const ELEMENT_TO_ENEMY_MAP: Record<number, number> = {
    0: 3, 1: 0, 2: 1, 3: 2, 4: 5, 5: 4,
};

function resolveElementItemId(rarity: number, questElement?: number): number {
    const enemyElement = ELEMENT_TO_ENEMY_MAP[questElement ?? 0] ?? 3;
    const map = rewardElementMap as Record<string, Record<string, Record<string, string[][]>>>;
    return Number(map["1"][String(rarity)][String(enemyElement)][0][0]);
}

function resolveAetherItemId(rarity: number, questElement?: number): number {
    const enemyElement = ELEMENT_TO_ENEMY_MAP[questElement ?? 0] ?? 3;
    const map = rewardElementMap as Record<string, Record<string, Record<string, string[][]>>>;
    return Number(map["2"][String(rarity)][String(enemyElement)][0][0]);
}

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
): GivePlayerScoreRewardsResult {

    const dropScoreRewardIds: DropScoreRewardId[] = []
    const dropRareRewardIds: DropScoreRewardId[] = []

    let mana = 0
    let vmoney = 0
    let expPool = 0
    let joinedCharacterIdList: number[] = []
    let characterList: Object[] = []
    let equipmentList: Object[] = []
    let items: Record<string, number> = {}

    if (scoreRewards != null && groupId != null) {
        const dropMultiplier = parseFloat(process.env.DROP_MULTIPLIER || '1')
        console.log(`[QUEST] givePlayerScoreRewards group=${groupId} items=${scoreRewards.length} pid=${playerId}`)
        let seqIndex = 0
        for (const scoreReward of scoreRewards) {
            seqIndex += 1;
            const rewardIndex = scoreReward.position ?? seqIndex;
            switch (scoreReward.type) {
                case ScoreRewardType.ITEM: {
                    const reward = scoreReward as CommonScoreReward

                    let rewardAmount = 0

                    switch (reward.reward_type) {
                        case RewardType.ITEM: {
                            const itemReward = reward as ItemScoreReward
                            const itemId = itemReward.id
                            rewardAmount = itemReward.count * dropMultiplier * (boostPointUsed ? 2 : 1)
                            items[String(itemId)] = givePlayerItemSync(playerId, itemId, rewardAmount);
                            console.log(`[QUEST-ITEM] id=${itemId} cdnCount=${itemReward.count} ×drop=${dropMultiplier} ×boost=${boostPointUsed ? 2 : 1} → ${rewardAmount}`)
                            break;
                        }
                        case RewardType.MANA: {
                            const player = getPlayerSync(playerId)
                            const currencyReward = reward as CurrencyScoreReward
                            rewardAmount = currencyReward.count * dropMultiplier * (boostPointUsed ? 2 : 1)
                            mana += rewardAmount
                            updatePlayerSync({
                                id: playerId,
                                freeMana: (player?.freeMana || 0) + rewardAmount,
                                totalManaObtained: (player?.totalManaObtained || 0) + rewardAmount
                            })
                            break;
                        }
                        case RewardType.EXP: {
                            const player = getPlayerSync(playerId)
                            const currencyReward = reward as CurrencyScoreReward
                            rewardAmount = currencyReward.count * dropMultiplier * (boostPointUsed ? 2 : 1)
                            expPool += rewardAmount
                            updatePlayerSync({
                                id: playerId,
                                expPool: (player?.expPool || 0) + rewardAmount
                            })
                            break;
                        }
                        case RewardType.ELEMENT: {
                            const itemReward = reward as ItemScoreReward
                            const itemId = resolveElementItemId(itemReward.id, questElement)
                            rewardAmount = itemReward.count * dropMultiplier * (boostPointUsed ? 2 : 1)
                            items[String(itemId)] = givePlayerItemSync(playerId, itemId, rewardAmount);
                            console.log(`[QUEST-ELEMENT] rarity=${itemReward.id} →id=${itemId} cdnCount=${itemReward.count} ×drop=${dropMultiplier} ×boost=${boostPointUsed ? 2 : 1} → ${rewardAmount}`)
                            break;
                        }
                        case RewardType.AETHER: {
                            const itemReward = reward as ItemScoreReward
                            const itemId = resolveAetherItemId(itemReward.id, questElement)
                            rewardAmount = itemReward.count * dropMultiplier * (boostPointUsed ? 2 : 1)
                            items[String(itemId)] = givePlayerItemSync(playerId, itemId, rewardAmount);
                            console.log(`[QUEST-AETHER] rarity=${itemReward.id} →id=${itemId} cdnCount=${itemReward.count} ×drop=${dropMultiplier} ×boost=${boostPointUsed ? 2 : 1} → ${rewardAmount}`)
                            break;
                        }
                    }

                    dropScoreRewardIds.push({
                        group_id: groupId,
                        index: rewardIndex,
                        number: rewardAmount
                    })
                    break;
                }
                case ScoreRewardType.RARE_POOL: {
                    const reward = scoreReward as RareScoreRewardGroup
                    const roll = randomInt(0, 100) / 100

                    if (reward.rarity >= roll) {
                        // give reward from group
                        // TODO: implement RareScoreReward rarity using .rarity field instead of having an even chance between all items in pool
                        const rareGroupId = reward.id
                        const group = getRareScoreRewardGroup(rareGroupId)
                        console.log(`[QUEST] RARE_POOL rareGroup=${rareGroupId} found=${group !== null} items=${group?.length ?? 0}`)
                        if (group !== null) {
                            const random_index = 1 >= group.length ? 0 : randomInt(group.length)
                            const reward = group[random_index]
                            const result = givePlayerRewardSync(playerId, reward)

                            if (result) {
                                // merge arrays
                                mana += result.user_info.free_mana
                                vmoney += result.user_info.free_vmoney
                                joinedCharacterIdList = [...joinedCharacterIdList, ...result.joined_character_id_list]
                                characterList = [...characterList, ...result.character_list]
                                equipmentList = [...equipmentList, ...result.equipment_list]

                                // merge items: RARE_POOL result.items already contains DB totals
                                // (includes any earlier ITEM path writes), so just use latest value
                                for (const [itemId, count] of Object.entries(result.items)) {
                                    items[itemId] = count
                                }

                                // calculate number
                                let number = 0
                                switch (reward.type) {
                                    case RewardType.ITEM:
                                    case RewardType.EQUIPMENT:
                                    case RewardType.ELEMENT:
                                    case RewardType.AETHER:
                                        number = (reward as Reward as EquipmentItemReward).count
                                        break;
                                    case RewardType.CHARACTER:
                                        number = 1;
                                        break;
                                    case RewardType.BEADS:
                                    case RewardType.EXP:
                                    case RewardType.MANA:
                                        number = (reward as Reward as CurrencyReward).count
                                        break;
                                }

                                // add reward id to table
                                dropRareRewardIds.push({
                                    group_id: rareGroupId,
                                    index: random_index + 1,
                                    number: number
                                })
                            }  
                        }
                    }
                    break;
                }
            }
        }
    }

    if (Object.keys(items).length > 0) {
        console.log(`[QUEST-BAG] total items bagged: ${JSON.stringify(items)}`)
    }

    return {
        drop_score_reward_ids: dropScoreRewardIds,
        drop_rare_reward_ids: dropRareRewardIds,
        user_info: {
            free_mana: mana,
            free_vmoney: vmoney,
            exp_pool: expPool
        },
        character_list: characterList,
        joined_character_id_list: joinedCharacterIdList,
        equipment_list: equipmentList,
        items: items
    }
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