import carnivalRewardData from "../../assets/carnival_event_total_score_reward.json"
import { getRuntimeContentTableSync } from "../content/runtime/table-access"
import { createRewardGrantPlan } from "./reward-grant"
import { RewardType } from "./types/rewards"
import type {
    RewardGrantPlan,
    RewardGrantPlayerAfter,
    RewardGrantResult,
    RewardGrantReward,
} from "./reward-grant"
import type { CarnivalRewardDefinition } from "./carnival-reward-parser"

export { parseCarnivalRewardRow } from "./carnival-reward-parser"
export type { CarnivalRewardDefinition, CarnivalRewardSlot } from "./carnival-reward-parser"

export interface CarnivalRewardGrantResult {
    user_info: {
        free_vmoney: number
        free_mana: number
        exp_pool: number
    }
    item_list: Record<string, number>
    equipment_list: Object[]
    new_degree_ids: number[]
}

export interface CarnivalRewardSource {
    readonly kind: "carnival"
    readonly definitionId: number
    readonly rewardIndex: number
}

type StandardRewardGrant = (
    playerId: number,
    plan: RewardGrantPlan<CarnivalRewardSource>,
    knownPlayerBefore: RewardGrantPlayerAfter,
) => RewardGrantResult<CarnivalRewardSource>

interface CarnivalRewardDependencies {
    getPlayer: (playerId: number) => {
        freeVmoney: number
        freeMana: number
        expPool: number
        totalManaObtained?: number
    } | null
    giveItem: (playerId: number, itemId: number, amount: number) => number
    giveEquipment: (playerId: number, equipmentId: number, amount: number) => Object
    giveDegree: (playerId: number, degreeId: number) => boolean
    updatePlayer: (player: {
        id: number
        freeVmoney: number
        freeMana: number
        expPool: number
        totalManaObtained: number
    }) => void
    standardRewardGrant?: StandardRewardGrant
}

function toRewardGrantReward(
    kind: number,
    id: number | undefined,
    amount: number,
): RewardGrantReward | null {
    switch (kind) {
        case 0:
            return id === undefined ? null : { type: RewardType.ITEM, id, count: amount }
        case 1:
            return id === undefined ? null : { type: RewardType.EQUIPMENT, id, count: amount }
        case 2:
            return { type: RewardType.BEADS, count: amount }
        case 3:
            return { type: RewardType.MANA, count: amount }
        case 4:
            return { type: RewardType.EXP, count: amount }
        default:
            return null
    }
}

export function getCarnivalRewardDefinitions(eventId?: number): CarnivalRewardDefinition[] {
    const carnivalRewardDefinitions = Object.values(getRuntimeContentTableSync(
        "carnival_event_total_score_reward.json",
        carnivalRewardData as Record<string, CarnivalRewardDefinition>,
    ))
    return eventId === undefined
        ? carnivalRewardDefinitions
        : carnivalRewardDefinitions.filter(definition => definition.eventId === eventId)
}

export function getEligibleCarnivalRewards(
    definitions: CarnivalRewardDefinition[],
    eventId: number,
    totalBestScore: number,
    claimedRewardIds: Set<number>,
): CarnivalRewardDefinition[] {
    return definitions.filter(definition => definition.eventId === eventId
        && definition.score <= totalBestScore
        && !claimedRewardIds.has(definition.id))
}

export function grantCarnivalRewards(
    playerId: number,
    definitions: CarnivalRewardDefinition[],
    dependencies: CarnivalRewardDependencies,
): CarnivalRewardGrantResult {
    const player = dependencies.getPlayer(playerId)
    if (player === null) throw new Error(`Player ${playerId} does not exist`)

    const result: CarnivalRewardGrantResult = {
        user_info: { free_vmoney: 0, free_mana: 0, exp_pool: 0 },
        item_list: {},
        equipment_list: [],
        new_degree_ids: [],
    }
    const equipmentMap = new Map<number, Object>()
    const pendingDegreeIds: number[] = []
    const standardEntries: {
        source: CarnivalRewardSource
        reward: RewardGrantReward
    }[] = []

    for (const definition of definitions) {
        for (const [rewardIndex, reward] of definition.rewards.entries()) {
            const standardReward = dependencies.standardRewardGrant === undefined
                ? null
                : toRewardGrantReward(reward.kind, reward.id, reward.amount)
            if (standardReward !== null) {
                standardEntries.push({
                    source: {
                        kind: "carnival",
                        definitionId: definition.id,
                        rewardIndex,
                    },
                    reward: standardReward,
                })
                continue
            }
            switch (reward.kind) {
                case 0:
                    if (reward.id !== undefined) {
                        result.item_list[String(reward.id)] = dependencies.giveItem(
                            playerId,
                            reward.id,
                            reward.amount,
                        )
                    }
                    break
                case 1:
                    if (reward.id !== undefined) {
                        equipmentMap.set(reward.id, dependencies.giveEquipment(
                            playerId,
                            reward.id,
                            reward.amount,
                        ))
                    }
                    break
                case 2:
                    result.user_info.free_vmoney += reward.amount
                    break
                case 3:
                    result.user_info.free_mana += reward.amount
                    break
                case 4:
                    result.user_info.exp_pool += reward.amount
                    break
                case 7:
                    if (reward.id === undefined) break
                    if (dependencies.standardRewardGrant !== undefined) {
                        pendingDegreeIds.push(reward.id)
                    } else if (!result.new_degree_ids.includes(reward.id)
                        && dependencies.giveDegree(playerId, reward.id)) {
                        result.new_degree_ids.push(reward.id)
                    }
                    break
            }
        }
    }

    if (standardEntries.length > 0 && dependencies.standardRewardGrant !== undefined) {
        const standardGrant = dependencies.standardRewardGrant(
            playerId,
            createRewardGrantPlan(standardEntries),
            {
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            },
        )
        result.user_info = {
            free_vmoney: standardGrant.aggregate.user_info.free_vmoney,
            free_mana: standardGrant.aggregate.user_info.free_mana,
            exp_pool: standardGrant.aggregate.user_info.exp_pool,
        }
        result.item_list = { ...standardGrant.aggregate.items }
        result.equipment_list = [...standardGrant.aggregate.equipment_list]
    }

    for (const degreeId of pendingDegreeIds) {
        if (!result.new_degree_ids.includes(degreeId)
            && dependencies.giveDegree(playerId, degreeId)) {
            result.new_degree_ids.push(degreeId)
        }
    }

    if (result.equipment_list.length === 0) {
        result.equipment_list = [...equipmentMap.values()]
    }

    if (dependencies.standardRewardGrant === undefined
        && (result.user_info.free_vmoney !== 0
        || result.user_info.free_mana !== 0
        || result.user_info.exp_pool !== 0)) {
        dependencies.updatePlayer({
            id: playerId,
            freeVmoney: player.freeVmoney + result.user_info.free_vmoney,
            freeMana: player.freeMana + result.user_info.free_mana,
            expPool: player.expPool + result.user_info.exp_pool,
            totalManaObtained: (player.totalManaObtained ?? 0) + result.user_info.free_mana,
        })
    }

    return result
}
