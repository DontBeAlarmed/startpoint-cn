import carnivalRewardData from "../../assets/carnival_event_total_score_reward.json"
import { getRuntimeContentTableSync } from "../content/runtime/table-access"
import {
    createRewardGrantExecutionPlan,
    snapshotRewardGrantExecutionResultForPlan,
} from "./reward-grant"
import { RewardType } from "./types/rewards"
import type {
    RewardGrantCommand,
    RewardGrantExecutionPlan,
    RewardGrantExecutionResult,
    RewardGrantKnownPlayerState,
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

type StandardRewardGrant = (
    playerId: number,
    plan: RewardGrantExecutionPlan,
    knownPlayerBefore: RewardGrantKnownPlayerState,
) => RewardGrantExecutionResult

interface CarnivalRewardDependencies {
    getPlayer: (playerId: number) => {
        id: number
        freeVmoney: number
        freeMana: number
        expPool: number
        totalManaObtained?: number
    } | null
    giveDegree: (playerId: number, degreeId: number) => boolean
    standardRewardGrant: StandardRewardGrant
}

function toRewardGrantCommand(
    kind: number,
    id: number | undefined,
    amount: number,
): RewardGrantCommand | null {
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
    if (typeof dependencies.standardRewardGrant !== "function") {
        throw new Error("Carnival rewards require a typed RewardGrant owner")
    }
    const player = dependencies.getPlayer(playerId)
    if (player === null) throw new Error(`Player ${playerId} does not exist`)
    if (player.id !== playerId) {
        throw new Error(`Carnival reward Player ${player.id} does not match owner ${playerId}`)
    }

    const result: CarnivalRewardGrantResult = {
        user_info: { free_vmoney: 0, free_mana: 0, exp_pool: 0 },
        item_list: {},
        equipment_list: [],
        new_degree_ids: [],
    }
    const pendingDegreeIds: number[] = []
    const standardEntries: RewardGrantCommand[] = []

    for (const definition of definitions) {
        for (const reward of definition.rewards) {
            const standardReward = toRewardGrantCommand(reward.kind, reward.id, reward.amount)
            if (standardReward !== null) {
                standardEntries.push(standardReward)
                continue
            }
            if (reward.kind === 7 && reward.id !== undefined) {
                pendingDegreeIds.push(reward.id)
            }
        }
    }

    if (standardEntries.length > 0) {
        const plan = createRewardGrantExecutionPlan(standardEntries)
        const standardGrant = snapshotRewardGrantExecutionResultForPlan(
            playerId,
            plan,
            dependencies.standardRewardGrant(
                playerId,
                plan,
                {
                    playerId: player.id,
                    freeMana: player.freeMana,
                    freeVmoney: player.freeVmoney,
                    expPool: player.expPool,
                },
            ),
        )
        result.user_info = {
            free_vmoney: standardGrant.assets.currencies
                .filter(entry => entry.currency === "freeVmoney")
                .reduce((sum, entry) => sum + entry.requestedAmount, 0),
            free_mana: standardGrant.assets.currencies
                .filter(entry => entry.currency === "freeMana")
                .reduce((sum, entry) => sum + entry.requestedAmount, 0),
            exp_pool: standardGrant.assets.currencies
                .filter(entry => entry.currency === "expPool")
                .reduce((sum, entry) => sum + entry.requestedAmount, 0),
        }
        result.item_list = Object.fromEntries(standardGrant.assets.items.map(entry => [
            String(entry.itemId),
            entry.afterAmount,
        ]))
        result.equipment_list = standardGrant.assets.equipment.map(entry => entry.after)
    }

    for (const degreeId of pendingDegreeIds) {
        if (!result.new_degree_ids.includes(degreeId)
            && dependencies.giveDegree(playerId, degreeId)) {
            result.new_degree_ids.push(degreeId)
        }
    }

    return result
}
