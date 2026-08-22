import { getPlayerMailCountSync } from "../../data/domains/mail"
import { mergeMissionSettlementResponse } from "../../lib/mission"
import { buildFinishFollowInfo } from "../../lib/quest/finish/follow-info"
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils"
import { expPoolRealDateToClientTimestamp } from "../../lib/exp-pool-time"
import type { ActiveQuest } from "../../lib/quest/active-quest-service"
import type { MultiFinishBody } from "../types"
import type { MultiplayerSettlementResult } from "./orchestrator"

export interface MultiplayerFinishResponseInput {
    readonly activeQuest: ActiveQuest
    readonly body: MultiFinishBody
    readonly playerId: number
    readonly settlement: MultiplayerSettlementResult
    readonly viewerId: number
}

export async function projectMultiplayerFinishResponse(input: MultiplayerFinishResponseInput) {
    const { activeQuest, body, playerId, settlement, viewerId } = input
    const {
        characterList,
        clearReward,
        playerData,
        rewardCharacterExpResult,
        scoreRewardsResult,
        additionalRewardSettlement,
        periodicRewardSettlement,
        sPlusClearReward,
        missionSettlement,
        awakeMissionSettlement,
        fieldMana,
        fixedManaReward,
        fixedPoolExpReward,
        newMana,
        beforeRankPoint,
        newRankPoint,
        newBoostPoint,
        newBossBoostPoint,
        hostFinished,
        oldHighScore,
        clearRank,
        questCategory,
    } = settlement
    const dataHeaders = generateDataHeaders({ viewer_id: viewerId })
    const matePlayerResult = ((body as any).mate_player_result || []) as Array<{ viewer_id?: number }>
    const followInfo = await buildFinishFollowInfo(
        viewerId,
        matePlayerResult,
        activeQuest.matePlayerIds || [],
    )
    const responseData: Record<string, any> = {
        "user_info": {
            "free_mana": newMana
                + (clearReward?.user_info.free_mana || 0)
                + (sPlusClearReward?.user_info.free_mana || 0)
                + scoreRewardsResult.user_info.free_mana,
            "exp_pool": rewardCharacterExpResult.exp_pool
                + (clearReward?.user_info.exp_pool || 0)
                + scoreRewardsResult.user_info.exp_pool,
            "exp_pooled_time": expPoolRealDateToClientTimestamp(playerData.expPooledTime),
            "free_vmoney": playerData.freeVmoney
                + (clearReward?.user_info.free_vmoney || 0)
                + (sPlusClearReward?.user_info.free_vmoney || 0)
                + scoreRewardsResult.user_info.free_vmoney,
            "rank_point": newRankPoint,
            "degree_id": 1,
            "stamina": playerData.stamina,
            "stamina_heal_time": realToVirtual(playerData.staminaHealTime),
            "boost_point": newBoostPoint,
            "boss_boost_point": newBossBoostPoint,
        },
        "add_exp_list": rewardCharacterExpResult.add_exp_list,
        "character_list": characterList,
        "bond_token_status_list": rewardCharacterExpResult.bond_token_status_list,
        "rewards": {
            "overflow_pool_exp": 0,
            "converted_pool_exp": 0,
            "reward_pool_exp": fixedPoolExpReward,
            "reward_mana": fixedManaReward,
            "field_mana": fieldMana,
        },
        "old_high_score": oldHighScore,
        "joined_character_id_list": [
            ...(clearReward?.joined_character_id_list || []),
            ...(sPlusClearReward?.joined_character_id_list || []),
            ...scoreRewardsResult.joined_character_id_list,
        ],
        "before_rank_point": beforeRankPoint,
        "clear_rank": clearRank ?? 5,
        "drop_score_reward_ids": scoreRewardsResult.drop_score_reward_ids,
        "drop_rare_reward_ids": scoreRewardsResult.drop_rare_reward_ids,
        "drop_additional_reward_ids": additionalRewardSettlement.dropAdditionalRewardIds,
        "drop_periodic_reward_ids": periodicRewardSettlement.dropPeriodicRewardIds,
        "equipment_list": [
            ...scoreRewardsResult.equipment_list,
            ...(clearReward?.equipment_list || []),
            ...(sPlusClearReward?.equipment_list || []),
        ],
        "category_id": questCategory,
        "start_time": dataHeaders.servertime,
        "is_multi": "multi",
        "quest_name": "",
        "item_list": {
            ...scoreRewardsResult.items,
            ...(additionalRewardSettlement.rewardResult?.items ?? {}),
            ...periodicRewardSettlement.items,
        },
        "user_periodic_reward_point_list": periodicRewardSettlement.periodicRewardPointList,
        "presigned_quest_category": [],
        "mate_player_result": matePlayerResult,
        "follow_info": followInfo,
        "contribution_score": (body as any).contribution_score ?? 0,
        "host_finished": hostFinished,
        "aborted_play_id": null,
    }
    mergeMissionSettlementResponse(responseData, missionSettlement, viewerId)
    mergeMissionSettlementResponse(responseData, awakeMissionSettlement, viewerId)
    responseData.mail_arrived = getPlayerMailCountSync(playerId, true) > 0
    return { data_headers: dataHeaders, data: responseData }
}
