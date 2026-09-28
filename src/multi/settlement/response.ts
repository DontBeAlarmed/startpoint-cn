import {
    composeMissionSettlementResponse,
    projectMissionSettlementFragment,
} from "../../lib/mission/response-fragment"
import {
    projectCharacterPatch,
    projectEquipmentEntity,
} from "../../lib/common-response/entities"
import { mergeCommonResponseFragments } from "../../lib/common-response/merge"
import type { CommonResponseFragment } from "../../lib/common-response/model"
import { generateDataHeaders, getServerTime, realToVirtual } from "../../utils"
import { expPoolRealDateToClientTimestamp } from "../../lib/exp-pool-time"
import type { ActiveQuest } from "../../lib/quest/active-quest-service"
import type { MultiFinishBody } from "../types"
import type { MultiplayerSettlementResult } from "./orchestrator"
import { projectItemOverflowCommonResponse } from "../../lib/item-overflow/common-response"

export interface MultiplayerFinishResponseInput {
    readonly activeQuest: ActiveQuest
    readonly body: MultiFinishBody
    readonly playerId: number
    readonly settlement: MultiplayerSettlementResult
    readonly viewerId: number
    readonly mailArrived: boolean
    readonly followInfo: readonly Record<string, unknown>[]
}

export async function projectMultiplayerFinishResponse(input: MultiplayerFinishResponseInput) {
    const { body, settlement, viewerId, mailArrived, followInfo } = input
    const {
        characterList,
        activeMissionList,
        clearReward,
        playerData,
        rewardCharacterExpResult,
        scoreRewardsResult,
        additionalRewardSettlement,
        rescueFragmentSettlement,
        periodicRewardSettlement,
        sPlusClearReward,
        missionSettlement,
        awakeMissionSettlement,
        fieldMana,
        fixedManaReward,
        fixedPoolExpReward,
        degreeId,
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
    const overMax = projectItemOverflowCommonResponse([
        ...(clearReward?.itemOverflowDispositions ?? []),
        ...(sPlusClearReward?.itemOverflowDispositions ?? []),
        ...(scoreRewardsResult.itemOverflowDispositions ?? []),
        ...(additionalRewardSettlement.rewardResult?.itemOverflowDispositions ?? []),
        ...(rescueFragmentSettlement?.itemOverflowDispositions ?? []),
        ...(periodicRewardSettlement.itemOverflowDispositions ?? []),
    ])

    const commonFragment: CommonResponseFragment = {
        "user_info": {
            "free_mana": playerData.freeMana,
            "exp_pool": playerData.expPool,
            "exp_pooled_time": expPoolRealDateToClientTimestamp(playerData.expPooledTime),
            "free_vmoney": playerData.freeVmoney,
            "rank_point": newRankPoint,
            "degree_id": degreeId,
            "stamina": playerData.stamina,
            "stamina_heal_time": realToVirtual(playerData.staminaHealTime),
            "boost_point": newBoostPoint,
            "boss_boost_point": newBossBoostPoint,
        },
        "character_list": characterList.map(
            character => projectCharacterPatch(character),
        ),
        "equipment_list": [
            ...scoreRewardsResult.equipment_list,
            ...(clearReward?.equipment_list || []),
            ...(sPlusClearReward?.equipment_list || []),
        ].map(equipment => projectEquipmentEntity(equipment)),
        "item_list": {
            ...(clearReward?.items ?? {}),
            ...(sPlusClearReward?.items ?? {}),
            ...scoreRewardsResult.items,
            ...(additionalRewardSettlement.rewardResult?.items ?? {}),
            ...(rescueFragmentSettlement?.items ?? {}) as Record<string, number>,
            ...periodicRewardSettlement.items,
        },
        "mission_info": [],
        "active_mission_list": activeMissionList,
        "mail_arrived": mailArrived,
        ...(overMax.length > 0 ? { "over_max": overMax } : {}),
    }

    const responseData: Record<string, any> = {
        ...mergeCommonResponseFragments([commonFragment]),
        "add_exp_list": rewardCharacterExpResult.add_exp_list,
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
        "category_id": questCategory,
        "start_time": dataHeaders.servertime,
        "is_multi": "multi",
        "quest_name": "",
        "user_periodic_reward_point_list": periodicRewardSettlement.periodicRewardPointList,
        "presigned_quest_category": [],
        "mate_player_result": matePlayerResult,
        "follow_info": followInfo,
        "contribution_score": (body as any).contribution_score ?? 0,
        "host_finished": hostFinished,
        "aborted_play_id": null,
        "degree_list": [],
    }
    composeMissionSettlementResponse(
        responseData,
        projectMissionSettlementFragment(missionSettlement),
        viewerId,
    )
    composeMissionSettlementResponse(
        responseData,
        projectMissionSettlementFragment(awakeMissionSettlement),
        viewerId,
    )
    return { data_headers: dataHeaders, data: responseData }
}
