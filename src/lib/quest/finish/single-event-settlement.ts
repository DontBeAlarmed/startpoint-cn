import {
    getPlayerCarnivalEventRecordsSync,
    getPlayerClaimedCarnivalRewardIdsSync,
    insertPlayerClaimedCarnivalRewardIdsSync,
    runCarnivalEventTransactionSync,
    upsertPlayerCarnivalEventRecordSync,
} from "../../../data/domains/carnivalEvent"
import { givePlayerDegreeSync } from "../../../data/domains/degree"
import { getPlayerEquipmentListSync } from "../../../data/domains/equipment"
import { getPlayerSync } from "../../../data/domains/player"
import {
    getPlayerSingleQuestProgressSync,
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
} from "../../../data/domains/quest"
import {
    getRaidEventBossStateSync,
    incrementPlayerRaidEventQuestKillCountSync,
    upsertRaidEventBossStateSync,
} from "../../../data/domains/raidEvent"
import {
    deletePlayerRushEventPlayedPartyListSync,
    getPlayerRushEventSync,
    insertPlayerRushEventClearedFolderSync,
    insertPlayerRushEventPlayedPartySync,
    updatePlayerRushEventSync,
} from "../../../data/domains/rushEvent"
import { deletePlayerActiveQuestSync } from "../../../data/domains/quest_active"
import { insertPlayerScoreAttackBattleHistorySync } from "../../../data/domains/score-attack-history"
import { getDb } from "../../../data/db"
import { createModeTransactionHost } from "../../../modes/loader"
import { dispatchModeRushFinish } from "../../../modes/registry"
import { getRushEventFolderClearRewards } from "../../assets"
import { getCarnivalRewardDefinitions, grantCarnivalRewards } from "../../carnival-rewards"
import { getCharactersEvolutionImgLevels } from "../../character"
import { getRaidEventRequiredKillCount } from "../../raid-event-master"
import { getSerializedPlayerRushEventPlayedPartiesSync } from "../../rush"
import type { BattleQuest, PlayerRewardResult, Reward } from "../../types"
import type { ActiveQuest } from "../active-quest-service"
import { buildScoreAttackBattleHistoryRecord } from "../score-attack-history"
import type { ValidatedSingleFinishBody } from "../single-finish-validation"
import type { EventSettlementDescriptor } from "./event-settlement-descriptor"
import { handleCarnivalEventFinish } from "./carnival-handler"
import { handleRaidEventFinish } from "./raid-handler"
import { handleRushEventFinish } from "./rush-handler"
import {
    handleScoreAttackEventFinish,
    type ScoreAttackBorderTier,
} from "./score-attack-handler"
import type { createSingleSettlementStandardRewardGrant } from "./single-standard-reward-callbacks"

const settlementModeHost = createModeTransactionHost(message => console.log(message))

export interface SingleBuiltInEventSettlementInput {
    readonly descriptor: EventSettlementDescriptor
    readonly playerId: number
    readonly body: ValidatedSingleFinishBody
    readonly activeQuest: ActiveQuest
    readonly questData: BattleQuest
    readonly clearRank: number | null
    readonly settlementTime: Date
    readonly rushEventFolderMaxRound?: number
    readonly scoreAttackBorderTiers: readonly ScoreAttackBorderTier[]
    readonly grantRewards: (
        playerId: number,
        rewards: readonly Reward[],
    ) => PlayerRewardResult
    readonly standardRewardGrant: ReturnType<typeof createSingleSettlementStandardRewardGrant>
}

export function settleSingleBuiltInEvent(
    input: SingleBuiltInEventSettlementInput,
) {
    const { body, descriptor } = input
    const playerId = input.playerId
    const questCategory = body.category
    const questId = body.quest_id
    const questAccomplished = body.is_accomplished
    const clearTime = body.elapsed_time_ms
    const party = body.statistics.party

    const rushFinishParams = {
        questCategory,
        questAccomplished,
        questData: input.questData,
        clearTime,
        party,
        playerId,
        questId,
        getEvoLevels: (pid: number, chars: (number | null)[]) =>
            getCharactersEvolutionImgLevels(pid, chars),
        folderMaxRound: input.rushEventFolderMaxRound,
        getRushEvent: getPlayerRushEventSync,
        updateRushEvent: updatePlayerRushEventSync,
        insertParty: insertPlayerRushEventPlayedPartySync,
        insertClearedFolder: insertPlayerRushEventClearedFolderSync,
        deletePartyList: deletePlayerRushEventPlayedPartyListSync,
        getSerializedParties: getSerializedPlayerRushEventPlayedPartiesSync,
        getFolderRewards: getRushEventFolderClearRewards,
        giveRewards: input.grantRewards,
        transaction: <T>(operation: () => T) => getDb().transaction(operation)(),
    }
    const rush = descriptor.kind === "rush"
        ? handleRushEventFinish(rushFinishParams)
        : { rushEventData: null, rushEventRewardsResult: null }
    const modeRushExtension = dispatchModeRushFinish(rushFinishParams, settlementModeHost)
    if (modeRushExtension?.rush_battle_reward_list?.length && rush.rushEventData) {
        rush.rushEventData.rush_battle_reward_list.push(...modeRushExtension.rush_battle_reward_list)
    }

    const raidEventData = descriptor.kind === "raid" ? handleRaidEventFinish({
        questCategory,
        questAccomplished,
        activeEventId: descriptor.eventId,
        killCountWeight: descriptor.killCountWeight,
        party,
        playerId,
        questId,
        getEvoLevelsFn: getCharactersEvolutionImgLevels,
        insertPartyFn: insertPlayerRushEventPlayedPartySync,
        getRequiredKillCountFn: getRaidEventRequiredKillCount,
        getRaidBossStateFn: getRaidEventBossStateSync,
        updateRaidBossStateFn: upsertRaidEventBossStateSync,
        incrementQuestKillCountFn: incrementPlayerRaidEventQuestKillCountSync,
    }) : null

    const carnival = descriptor.kind === "carnival" ? handleCarnivalEventFinish({
        questCategory,
        questAccomplished,
        questId,
        questData: {
            eventId: descriptor.eventId,
            folderId: descriptor.folderId,
            difficultyScore: descriptor.difficultyScore,
            timeLimitMs: descriptor.timeLimitMs,
        },
        clearTime,
        party,
        playerId,
        getRecordsFn: getPlayerCarnivalEventRecordsSync,
        upsertFn: upsertPlayerCarnivalEventRecordSync,
        getRewardDefinitionsFn: getCarnivalRewardDefinitions,
        getClaimedRewardIdsFn: getPlayerClaimedCarnivalRewardIdsSync,
        grantRewardsFn: (pid, definitions) => grantCarnivalRewards(pid, definitions, {
            getPlayer: getPlayerSync,
            giveDegree: givePlayerDegreeSync,
            standardRewardGrant: input.standardRewardGrant.forCarnival,
        }),
        claimRewardIdsFn: insertPlayerClaimedCarnivalRewardIdsSync,
        assertTargetPlayerFn: input.standardRewardGrant.assertTargetPlayer,
        transactionFn: runCarnivalEventTransactionSync,
    }) : null

    if (descriptor.kind === "scoreAttack") {
        insertPlayerScoreAttackBattleHistorySync(buildScoreAttackBattleHistoryRecord({
            playerId,
            eventId: descriptor.eventId!,
            playId: input.activeQuest.playId,
            categoryId: questCategory,
            questId,
            finishKind: 0,
            createdAt: input.settlementTime,
            elapsedTimeMs: clearTime,
            score: body.score,
            clearRank: input.clearRank,
            party,
            statistics: body.statistics,
            equipmentList: getPlayerEquipmentListSync(playerId),
        }))
    }
    const scoreAttack = descriptor.kind === "scoreAttack" ? handleScoreAttackEventFinish({
        playerId,
        questId,
        category: questCategory,
        score: body.score,
        elapsedTimeMs: clearTime,
        isAccomplished: questAccomplished,
        quest: {
            bRankScore: input.questData.bRankScore!,
            aRankScore: input.questData.aRankScore!,
            sRankScore: input.questData.sRankScore!,
            ssRankScore: input.questData.ssRankScore!,
        },
        tiers: [...input.scoreAttackBorderTiers],
        party,
    }, {
        transaction: operation => operation(),
        getProgress: getPlayerSingleQuestProgressSync,
        grantRewards: input.grantRewards,
        updateProgress: updatePlayerQuestProgressSync,
        insertProgress: insertPlayerQuestProgressSync,
        deleteActiveQuest: deletePlayerActiveQuestSync,
    }) : null

    return {
        rushEventData: rush.rushEventData,
        rushEventRewardsResult: rush.rushEventRewardsResult,
        raidEventData,
        carnivalEventData: carnival?.carnivalEventData ?? null,
        carnivalRewardResult: carnival?.rewardResult,
        scoreAttackFinishResult: scoreAttack,
        scoreAttackRewardResult: scoreAttack?.rewardResult,
    }
}
