import { mergeMissionSettlementResponse } from "../../mission/response"
import type { SingleFinishSuccess } from "./single-orchestrator"

export interface SingleFinishResponseFinalPlayerProjection {
    readonly freeMana: number
    readonly expPool: number
    readonly expPooledTime: number
    readonly freeVmoney: number
    readonly rankPoint: number
    readonly degreeId: number
    readonly stamina: number
    readonly staminaHealTime: number
    readonly boostPoint: number
    readonly bossBoostPoint: number
}

export interface SingleFinishResponseHeaders {
    servertime: number
    [key: string]: unknown
}

interface SingleFinishResponseUserInfo {
    free_mana: number
    exp_pool: number
    exp_pooled_time: number
    free_vmoney: number
    rank_point: number
    degree_id: number
    stamina: number
    stamina_heal_time: number
    boost_point: number
    boss_boost_point: number
    [key: string]: number
}

interface SingleFinishResponseRewards {
    overflow_pool_exp: number
    converted_pool_exp: number
    reward_pool_exp: number
    reward_mana: number
    field_mana: number
}

type ScoreAttackEventData = NonNullable<
    SingleFinishSuccess["scoreAttackFinishResult"]
>["scoreAttackEvent"]

export interface SingleFinishResponseData {
    user_info: SingleFinishResponseUserInfo
    add_exp_list: SingleFinishSuccess["rewardCharacterExpResult"]["add_exp_list"]
    character_list: unknown[]
    bond_token_status_list: SingleFinishSuccess["rewardCharacterExpResult"]["bond_token_status_list"]
    rewards: SingleFinishResponseRewards
    old_high_score: number
    joined_character_id_list: number[]
    before_rank_point: number
    clear_rank: number
    drop_score_reward_ids: SingleFinishSuccess["scoreRewardsResult"]["drop_score_reward_ids"]
    drop_rare_reward_ids: SingleFinishSuccess["scoreRewardsResult"]["drop_rare_reward_ids"]
    drop_additional_reward_ids: SingleFinishSuccess["additionalRewardSettlement"]["dropAdditionalRewardIds"]
    drop_periodic_reward_ids: unknown[]
    equipment_list: unknown[]
    category_id: number
    start_time: number
    is_multi: "single"
    quest_name: ""
    item_list: SingleFinishSuccess["itemList"]
    raid_event: SingleFinishSuccess["raidEventData"]
    rush_event: SingleFinishSuccess["rushEventData"]
    carnival_event: SingleFinishSuccess["carnivalEventData"]
    score_attack_event: ScoreAttackEventData | null
    user_daily_challenge_point_list: unknown[]
    presigned_quest_category: unknown[]
    active_mission_list: SingleFinishSuccess["activeMissionList"]
    mission_info: unknown[]
    degree_list: Array<{ viewer_id: number; degree_id: number }>
    mail_arrived: boolean
}

export interface SingleFinishResponseEnvelope {
    data_headers: SingleFinishResponseHeaders
    data: SingleFinishResponseData
}

export interface SingleFinishResponseProjectionInput {
    readonly result: SingleFinishSuccess
    readonly dataHeaders: SingleFinishResponseHeaders
    readonly player: SingleFinishResponseFinalPlayerProjection
    readonly mailArrived: boolean
}

export function buildSingleFinishResponse({
    result,
    dataHeaders,
    player,
    mailArrived,
}: SingleFinishResponseProjectionInput): SingleFinishResponseEnvelope {
    const {
        body,
        dailyChallengePointList,
        scoreRewardsResult,
        additionalRewardSettlement,
        rewardCharacterExpResult,
        rushEventData,
        rushEventRewardsResult,
        raidEventData,
        carnivalEventData,
        carnivalRewardResult,
        scoreAttackFinishResult,
        scoreAttackRewardResult,
        itemList,
        characterList,
        clearReward,
        sPlusClearReward,
        missionSettlement,
        awakeMissionSettlement,
        activeMissionList,
        fixedManaReward,
        fixedPoolExpReward,
        beforeRankPoint,
        clearRank,
        questProgress,
    } = result
    const scoreAttackEventData = scoreAttackFinishResult?.scoreAttackEvent ?? null
    const viewerId = body.viewer_id

    const responseData: SingleFinishResponseData = {
        "user_info": {
            "free_mana": player.freeMana,
            "exp_pool": player.expPool,
            "exp_pooled_time": player.expPooledTime,
            "free_vmoney": player.freeVmoney,
            "rank_point": player.rankPoint,
            "degree_id": player.degreeId,
            "stamina": player.stamina,
            "stamina_heal_time": player.staminaHealTime,
            "boost_point": player.boostPoint,
            "boss_boost_point": player.bossBoostPoint,
        },
        "add_exp_list": rewardCharacterExpResult.add_exp_list,
        "character_list": characterList,
        "bond_token_status_list": rewardCharacterExpResult.bond_token_status_list,
        "rewards": {
            "overflow_pool_exp": 0,
            "converted_pool_exp": 0,
            "reward_pool_exp": fixedPoolExpReward,
            "reward_mana": fixedManaReward,
            "field_mana": body.add_mana,
        },
        "old_high_score": scoreAttackFinishResult?.oldHighScore ?? (questProgress === null ? 0 : questProgress.highScore || 0),
        "joined_character_id_list": [
            ...(clearReward?.joined_character_id_list || []),
            ...(sPlusClearReward?.joined_character_id_list || []),
            ...scoreRewardsResult.joined_character_id_list,
            ...(scoreAttackRewardResult?.joined_character_id_list ?? []),
        ],
        "before_rank_point": beforeRankPoint,
        "clear_rank": clearRank ?? 5,
        "drop_score_reward_ids": scoreRewardsResult.drop_score_reward_ids,
        "drop_rare_reward_ids": scoreRewardsResult.drop_rare_reward_ids,
        "drop_additional_reward_ids": additionalRewardSettlement.dropAdditionalRewardIds,
        "drop_periodic_reward_ids": [],
        "equipment_list": [
            ...scoreRewardsResult.equipment_list,
            ...(clearReward?.equipment_list || []),
            ...(sPlusClearReward?.equipment_list || []),
            ...(rushEventRewardsResult?.equipment_list || []),
            ...(scoreAttackRewardResult?.equipment_list ?? []),
            ...(carnivalRewardResult?.equipment_list ?? []),
        ],
        "category_id": body.category,
        "start_time": dataHeaders.servertime,
        "is_multi": "single",
        "quest_name": "",
        "item_list": itemList,
        "raid_event": raidEventData,
        "rush_event": rushEventData,
        "carnival_event": carnivalEventData,
        "score_attack_event": scoreAttackEventData,
        "user_daily_challenge_point_list": dailyChallengePointList ?? [],
        "presigned_quest_category": [],
        "active_mission_list": activeMissionList,
        "mission_info": [],
        "degree_list": [],
        "mail_arrived": mailArrived,
    }
    // The legacy mission adapter mutates a dynamic response shape. Keep that
    // conversion local so the projector's public input and output remain strict.
    const missionResponseTarget = responseData as unknown as Parameters<
        typeof mergeMissionSettlementResponse
    >[0]
    mergeMissionSettlementResponse(missionResponseTarget, {
        ...missionSettlement,
        itemList: {},
        userInfo: undefined,
    }, viewerId)
    mergeMissionSettlementResponse(missionResponseTarget, {
        ...awakeMissionSettlement,
        itemList: {},
        userInfo: undefined,
    }, viewerId)

    return {
        "data_headers": dataHeaders,
        "data": responseData,
    }
}
