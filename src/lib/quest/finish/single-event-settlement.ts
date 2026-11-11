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
    upsertPlayerQuestProgressSync,
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
import { getRushEventFolderClearRewards } from "../../rush-event-content"
import type { RushFinalOperationOverride } from "../../rush-final-operation-override"
import { getCarnivalRewardDefinitions, grantCarnivalRewards } from "../../carnival-rewards"
import { getCharactersEvolutionImgLevels } from "../../character"
import { getRaidEventRequiredKillCount } from "../../raid-event-master"
import { getSerializedPlayerRushEventPlayedPartiesSync } from "../../rush"
import type { BattleQuest, PlayerRewardResult, Reward } from "../../types"
import type { ActiveQuest } from "../active-quest-service"
import { buildScoreAttackBattleHistoryRecord } from "../score-attack-history"
import type { ValidatedSingleFinishBody } from "../single-finish-validation"
import type { EventSettlementDescriptor } from "./event-settlement-descriptor"
import {
    dispatchBuiltInEventSettlement,
    getOperatorRushHookPhase,
} from "./event-settlement-hook"
import { handleCarnivalEventFinish } from "./carnival-handler"
import { handleRaidEventFinish } from "./raid-handler"
import { handleRushEventFinish } from "./rush-handler"
import {
    handleScoreAttackEventFinish,
    type ScoreAttackBorderTier,
} from "./score-attack-handler"
import {
    handleSoloTimeAttackEventFinish,
    type SoloTimeAttackFinishResult,
} from "./solo-time-attack-handler"
import { resolveSoloTimeAttackTimelineTiers } from "../solo-time-attack-content"
import type { PlayerQuestProgress } from "../../../data/types"
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
    readonly rushFolderRewardOverride: RushFinalOperationOverride | null
    readonly grantRewards: (
        playerId: number,
        rewards: readonly Reward[],
    ) => PlayerRewardResult
    readonly standardRewardGrant: ReturnType<typeof createSingleSettlementStandardRewardGrant>
    /**
     * 结算事务开场读到的 pre-write 进度快照（写入发生前的真实旧进度）。
     * 事件结算必须用它判"旧最佳"——通用进度写入（writeSingleQuestProgress
     * WithinTransactionSync）先于事件派发执行，实时 DB 读会把本次 clearTime
     * 当成旧最佳（2026-11-11 真机：极时首通 oldBest=本次用时 → crossed=0
     * → 零发放/无弹窗/TRY AGAIN）。
     */
    readonly questProgress: PlayerQuestProgress | null
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
        getFolderRewards: (eventId: number, folderId: number) =>
            getRushEventFolderClearRewards(eventId, folderId, input.rushFolderRewardOverride),
        giveRewards: input.grantRewards,
        transaction: <T>(operation: () => T) => getDb().transaction(operation)(),
    }
    const operatorHookPhase = getOperatorRushHookPhase(descriptor)
    let modeRushExtension = operatorHookPhase === "beforeBuiltIn"
        ? dispatchModeRushFinish(rushFinishParams, settlementModeHost)
        : null
    const builtIn = dispatchBuiltInEventSettlement(descriptor, {
        rush: () => handleRushEventFinish(rushFinishParams),
        raid: current => handleRaidEventFinish({
            questCategory,
            questAccomplished,
            activeEventId: current.eventId,
            killCountWeight: current.killCountWeight,
            party,
            playerId,
            questId,
            questData: input.questData,
            getEvoLevelsFn: getCharactersEvolutionImgLevels,
            insertPartyFn: insertPlayerRushEventPlayedPartySync,
            getRequiredKillCountFn: getRaidEventRequiredKillCount,
            getRaidBossStateFn: getRaidEventBossStateSync,
            updateRaidBossStateFn: upsertRaidEventBossStateSync,
            incrementQuestKillCountFn: incrementPlayerRaidEventQuestKillCountSync,
        }),
        carnival: current => handleCarnivalEventFinish({
            questCategory,
            questAccomplished,
            questId,
            questData: {
                eventId: current.eventId,
                folderId: current.folderId,
                difficultyScore: current.difficultyScore,
                timeLimitMs: current.timeLimitMs,
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
        }),
        scoreAttack: current => {
            insertPlayerScoreAttackBattleHistorySync(buildScoreAttackBattleHistoryRecord({
                playerId,
                eventId: current.eventId,
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
            return handleScoreAttackEventFinish({
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
            })
        },
        soloTimeAttack: current => handleSoloTimeAttackEventFinish({
            playerId,
            questId,
            eventId: current.eventId,
            soloQuestId: current.soloQuestId,
            elapsedTimeMs: clearTime,
            isAccomplished: questAccomplished,
            clearRank: input.clearRank,
            party,
            tiers: resolveSoloTimeAttackTimelineTiers(current.eventId, current.soloQuestId),
        }, {
            transaction: operation => operation(),
            // pre-write 快照：通用进度写入先于本派发，实时读会把本次用时
            // 当成旧最佳（2026-11-11 真机根因，见 input.questProgress 注释）
            getProgress: () => input.questProgress,
            // 首通时通用写入已 INSERT 本行，insert 必须走 upsert 防唯一键冲突
            insertProgress: (pid, cat, row) => upsertPlayerQuestProgressSync(pid, cat, row),
            updateProgress: updatePlayerQuestProgressSync,
            deleteActiveQuest: deletePlayerActiveQuestSync,
            grantRewards: input.grantRewards,
            grantDegree: (pid, degreeId) => givePlayerDegreeSync(pid, degreeId),
        }),
    })
    const rush = builtIn.kind === "rush"
        ? builtIn.value
        : { rushEventData: null, rushEventRewardsResult: null }
    const raidEventData = builtIn.kind === "raid" ? builtIn.value : null
    const carnival = builtIn.kind === "carnival" ? builtIn.value : null
    const scoreAttack = builtIn.kind === "scoreAttack" ? builtIn.value : null
    const soloTimeAttack = builtIn.kind === "soloTimeAttack" ? builtIn.value : null
    if (operatorHookPhase === "afterBuiltIn") {
        modeRushExtension = dispatchModeRushFinish(rushFinishParams, settlementModeHost)
    }
    if (modeRushExtension?.rush_battle_reward_list?.length && rush.rushEventData) {
        rush.rushEventData.rush_battle_reward_list.push(...modeRushExtension.rush_battle_reward_list)
    }

    return {
        rushEventData: rush.rushEventData,
        rushEventRewardsResult: rush.rushEventRewardsResult,
        raidEventData,
        carnivalEventData: carnival?.carnivalEventData ?? null,
        carnivalRewardResult: carnival?.rewardResult,
        scoreAttackFinishResult: scoreAttack,
        scoreAttackRewardResult: scoreAttack?.rewardResult,
        soloTimeAttackFinishResult: soloTimeAttack,
    }
}
