import { deletePlayerActiveQuestSync } from "../../../data/domains/quest_active"
import { deletePlayerRushEventPlayedPartyListSync, getPlayerRushEventSync, insertPlayerRushEventClearedFolderSync, insertPlayerRushEventPlayedPartySync, updatePlayerRushEventSync } from "../../../data/domains/rushEvent"
import { getPlayerDailyChallengePointListSync, getPlayerSync, updatePlayerDailyChallengePointSync, updatePlayerSync } from "../../../data/domains/player"
import { getPlayerItemSync, givePlayerItemSync } from "../../../data/domains/item"
import { getServerGameplaySettingsSync } from "../../../data/domains/server-settings"
import { getRaidEventBossStateSync, incrementPlayerRaidEventQuestKillCountSync, upsertRaidEventBossStateSync } from "../../../data/domains/raidEvent"
import { getPlayerSingleQuestProgressSync, insertPlayerQuestProgressSync, updatePlayerQuestProgressSync } from "../../../data/domains/quest"
import { getPlayerEquipmentListSync } from "../../../data/domains/equipment"
import { insertPlayerScoreAttackBattleHistorySync } from "../../../data/domains/score-attack-history"
import { insertPlayerPracticeBattleHistorySync } from "../../../data/domains/practice-battle-history"
import { getPlayerCarnivalEventRecordsSync, getPlayerClaimedCarnivalRewardIdsSync, insertPlayerClaimedCarnivalRewardIdsSync, runCarnivalEventTransactionSync, upsertPlayerCarnivalEventRecordSync } from "../../../data/domains/carnivalEvent"
import { givePlayerDegreeSync } from "../../../data/domains/degree"
import { getDb } from "../../../data/db"
import type { Player, PlayerQuestProgress } from "../../../data/types"
import { getRushEventFolderClearRewards } from "../../assets"
import { getCharactersEvolutionImgLevels, givePlayerCharactersExpSync } from "../../character"
import { getCommonScoreRewardCount } from "../../score-reward-lottery"
import { calculateCharacterBattleExp, calculateFixedQuestMana, calculateFixedQuestPoolExp, getRewardCampaignRates } from "../../reward-campaign"
import { QuestCategory, type BattleQuest, type Reward } from "../../types"
import { getRankDegree, getMaxStamina } from "../../stamina"
import { getRuntimeContentTableSync } from "../../../content/runtime/table-access"
import { getContentSnapshot } from "../../../content/runtime/content-snapshot"
import { settleAdditionalRewardsSync, type AdditionalRewardTable } from "../../additional-reward"
import { getSerializedPlayerRushEventPlayedPartiesSync } from "../../rush"
import { reconcileActiveMissionFacts, reconcileAwakeUnlockCharacterList, settleAwakeBattleMissions, settleMissionCategories } from "../../mission"
import { buildBattleMissionSettlementScopes, recordMissionBattleFacts } from "../../mission/battle-facts"
import { getCarnivalRewardDefinitions, grantCarnivalRewards } from "../../carnival-rewards"
import { givePlayerEquipmentSync } from "../../equipment"
import { getRaidEventRequiredKillCount } from "../../raid-event-master"
import { buildScoreAttackBattleHistoryRecord } from "../score-attack-history"
import { buildPracticeBattleHistoryRecord } from "../practice-battle-history"
import type { QuestRewardEligibility } from "../first-clear-reward"
import type { ActiveQuest } from "../active-quest-service"
import type { ValidatedSingleFinishBody } from "../single-finish-validation"
import { dispatchModeRushFinish } from "../../../modes/registry"
import { createModeTransactionHost } from "../../../modes/loader"
import { getServerTime } from "../../../utils"
import bundledEventChallengePointMap from "../../../../assets/event_challenge_point_map.json"
import bundledAdditionalRewardRules from "../../../../assets/additional_reward_rules.json"
import { handleCarnivalEventFinish } from "./carnival-handler"
import { handleRushEventFinish } from "./rush-handler"
import { handleRaidEventFinish } from "./raid-handler"
import { handleScoreAttackEventFinish, type ScoreAttackBorderTier } from "./score-attack-handler"
import { handleDailyChallengePoint } from "./challenge-point"
import type { FinishContext } from "./types"
import { selectScoreRewardGrantPlan } from "../score-reward-selection"
import {
    grantSingleSettlementScoreRewardsWithinTransactionSync,
    grantSingleSettlementRewardsWithinTransactionSync,
    type SingleSettlementRewardSourceKind,
    withSingleSettlementExpPool,
} from "./single-settlement-reward-grant"
const settlementModeHost = createModeTransactionHost(message => console.log(message))

export interface SingleSettlementWritesInput {
    body: ValidatedSingleFinishBody
    questData: BattleQuest & { rankPointReward: number }
    rewardEligibility: QuestRewardEligibility
    finishCtx: FinishContext
    rushEventFolderMaxRound?: number
    scoreAttackBorderTiers: ScoreAttackBorderTier[]
}

export function executeSingleSettlementWrites(
    input: SingleSettlementWritesInput,
    settlementActiveQuest: ActiveQuest,
    settlementPlayer: Player,
) {
    const { body, questData, rewardEligibility, finishCtx,
        rushEventFolderMaxRound, scoreAttackBorderTiers } = input
    const { playerId, questCategory, questId, clearTime, clearRank,
        questAccomplished, questProgress } = finishCtx
    const isScoreAttackEvent = questCategory === QuestCategory.SCORE_ATTACK_EVENT
    const party = body.statistics.party
    const leaderId = party.characters[0]?.id
    const partyCharacterIds: number[] = []
    for (const value of [...party.characters, ...party.unison_characters]) {
        const characterId = value?.id
        if (typeof characterId === "number"
            && Number.isSafeInteger(characterId)
            && characterId > 0) partyCharacterIds.push(characterId)
    }
    const beforeRankPoint = settlementPlayer.rankPoint
    const newRankPoint = beforeRankPoint + questData.rankPointReward
    const newBoostPoint = settlementPlayer.boostPoint - (settlementActiveQuest.useBoostPoint ? 1 : 0)
    const newBossBoostPoint = settlementPlayer.bossBoostPoint - (settlementActiveQuest.useBossBoostPoint ? 1 : 0)
    const useBoostPoint = settlementActiveQuest.useBoostPoint || settlementActiveQuest.useBossBoostPoint
    const settlementTime = new Date(getServerTime() * 1000)
    const rewardCampaignRates = getRewardCampaignRates(questCategory, questId, settlementTime)
    const fixedManaReward = calculateFixedQuestMana(questData.manaReward, rewardCampaignRates, useBoostPoint)
    const fixedPoolExpReward = calculateFixedQuestPoolExp(questData.poolExpReward, rewardCampaignRates, useBoostPoint)
    const addExpAmount = calculateCharacterBattleExp(questData.characterExpReward, rewardCampaignRates)
    const newMana = settlementPlayer.freeMana + fixedManaReward + body.add_mana
    const manaObtained = fixedManaReward + body.add_mana
    finishCtx.manaObtained = manaObtained
    let rewardPlayerState = {
        freeMana: settlementPlayer.freeMana,
        freeVmoney: settlementPlayer.freeVmoney,
        expPool: settlementPlayer.expPool,
    }
    const grantDirectRewards = (
        pid: number,
        kind: SingleSettlementRewardSourceKind,
        rewards: readonly Reward[],
    ) => {
        const result = grantSingleSettlementRewardsWithinTransactionSync(
            pid, kind, rewards, rewardPlayerState,
        )
        rewardPlayerState = result.playerAfter
        return result.aggregate
    }
    const clearReward = !isScoreAttackEvent && rewardEligibility.firstClear && questData.clearReward !== undefined
        ? grantDirectRewards(playerId, "clear", [questData.clearReward]) : null
    const sPlusClearReward = !isScoreAttackEvent && rewardEligibility.sPlus && questData.sPlusReward !== undefined
        ? grantDirectRewards(playerId, "s_plus", [questData.sPlusReward]) : null

    if (questAccomplished && !isScoreAttackEvent) {
        if (questProgress !== null) {
            const updateData: Partial<PlayerQuestProgress> & Pick<PlayerQuestProgress, "questId"> = {
                questId,
                finished: true,
                bestElapsedTimeMs: questProgress.bestElapsedTimeMs === undefined || questProgress.bestElapsedTimeMs === null
                    ? clearTime : Math.min(clearTime, questProgress.bestElapsedTimeMs),
                highScore: questProgress.highScore === undefined ? body.score : Math.max(body.score, questProgress.highScore),
                leaderCharacterId: leaderId ?? undefined,
            }
            if (clearRank !== null) {
                updateData.clearRank = questProgress.clearRank === undefined
                    ? clearRank : Math.max(clearRank, questProgress.clearRank)
            }
            updatePlayerQuestProgressSync(playerId, questCategory, updateData)
        } else {
            insertPlayerQuestProgressSync(playerId, questCategory, {
                questId, finished: true, bestElapsedTimeMs: clearTime, highScore: body.score,
                clearRank: clearRank ?? 5, leaderCharacterId: leaderId ?? undefined,
            })
        }
    }

    const oldRkDegree = getRankDegree(beforeRankPoint)
    const newDegreeId = getRankDegree(newRankPoint)
    const didLevelUp = newDegreeId > oldRkDegree
    const afterStamina = didLevelUp ? settlementPlayer.stamina + getMaxStamina(newDegreeId) : settlementPlayer.stamina
    const afterStaminaHealTime = didLevelUp ? new Date() : settlementPlayer.staminaHealTime
    updatePlayerSync({
        id: playerId,
        freeMana: newMana,
        expPool: settlementPlayer.expPool + fixedPoolExpReward,
        rankPoint: newRankPoint,
        boostPoint: newBoostPoint,
        bossBoostPoint: newBossBoostPoint,
        totalManaObtained: (settlementPlayer.totalManaObtained ?? 0) + manaObtained,
        maxComboAchieved: Math.max(settlementPlayer.maxComboAchieved ?? 0, body.statistics.max_combo_count ?? 0),
        ...(didLevelUp ? { stamina: afterStamina, staminaHealTime: afterStaminaHealTime } : {}),
    })
    rewardPlayerState = {
        freeMana: newMana,
        freeVmoney: rewardPlayerState.freeVmoney,
        expPool: settlementPlayer.expPool + fixedPoolExpReward,
    }
    if (didLevelUp) console.log(`[BATTLE-FINISH] player ${playerId} leveled up: ${oldRkDegree} -> ${newDegreeId}, stamina refilled`)

    const dailyChallengePointList = handleDailyChallengePoint({
        questCategory, eventId: questData.eventId, playerId,
        challengePointMap: getRuntimeContentTableSync(
            "event_challenge_point_map.json",
            bundledEventChallengePointMap as Record<string, number>,
        ),
        getEntries: pid => getPlayerDailyChallengePointListSync(pid),
        updatePoint: (pid, id, point) => updatePlayerDailyChallengePointSync(pid, id, point),
    })
    console.log(`[BATTLE] scoreReward groupId=${questData.scoreRewardGroupId} groupLen=${questData.scoreRewardGroup?.length ?? "null"} questId=${questId} category=${questCategory}`)
    const scoreRewardSelection = selectScoreRewardGrantPlan(
        questData.scoreRewardGroupId, questData.scoreRewardGroup, useBoostPoint, questData.element, {
            commonRewardCount: getCommonScoreRewardCount(questData, clearRank) ?? undefined,
            rewardCampaignRates, rewardDate: settlementTime,
        },
    )
    const scoreRewardGrant = grantSingleSettlementScoreRewardsWithinTransactionSync(
        playerId, scoreRewardSelection, rewardPlayerState,
    )
    rewardPlayerState = scoreRewardGrant.grant.playerAfter
    const scoreRewardsResult = scoreRewardGrant.result
    const additionalRewardSettlement = questAccomplished
        ? settleAdditionalRewardsSync(
            getRuntimeContentTableSync(
                "additional_reward_rules.json",
                bundledAdditionalRewardRules as AdditionalRewardTable,
            ),
            {
                questCategory, questId, enemyLevel: questData.enemyLevel,
                nowMs: settlementTime.getTime(), isMulti: false,
                isQuestCleared: (category, requiredQuestId) => (
                    getPlayerSingleQuestProgressSync(playerId, category, requiredQuestId)?.finished === true
                ),
                rewardCampaignRates, boostPointUsed: useBoostPoint,
                serverDropMultiplier: getServerGameplaySettingsSync().dropMultiplier,
            },
            { grantRewards: rewards => grantDirectRewards(playerId, "additional", rewards) },
        )
        : { dropAdditionalRewardIds: [], rewardResult: null }
    const missionBattleFacts = recordMissionBattleFacts(finishCtx, settlementTime)
    const rewardCharacterExpResult = givePlayerCharactersExpSync(
        playerId, partyCharacterIds, addExpAmount, questData.fixedParty !== undefined,
    )
    rewardPlayerState = withSingleSettlementExpPool(
        rewardPlayerState, rewardCharacterExpResult.exp_pool,
    )

    const rushFinishParams = {
        questCategory, questAccomplished, questData, clearTime, party, playerId, questId,
        getEvoLevels: (pid: number, chars: (number | null)[]) => getCharactersEvolutionImgLevels(pid, chars),
        folderMaxRound: rushEventFolderMaxRound,
        getRushEvent: (pid: number, eid: number) => getPlayerRushEventSync(pid, eid),
        updateRushEvent: (pid: number, data: any) => updatePlayerRushEventSync(pid, data),
        insertParty: (pid: number, eid: number, data: any) => insertPlayerRushEventPlayedPartySync(pid, eid, data),
        insertClearedFolder: (pid: number, eid: number, fid: number) => insertPlayerRushEventClearedFolderSync(pid, eid, fid),
        deletePartyList: (pid: number, eid: number, battleType: number) => deletePlayerRushEventPlayedPartyListSync(pid, eid, battleType),
        getSerializedParties: (pid: number, eid: number) => getSerializedPlayerRushEventPlayedPartiesSync(pid, eid),
        getFolderRewards: (eid: number, fid: number) => getRushEventFolderClearRewards(eid, fid),
        giveRewards: (pid: number, rewards: any[]) => grantDirectRewards(pid, "rush", rewards),
        transaction: (operation: () => any) => getDb().transaction(operation)(),
    }
    const { rushEventData, rushEventRewardsResult } = handleRushEventFinish(rushFinishParams)
    const modeRushExtension = dispatchModeRushFinish(rushFinishParams, settlementModeHost)
    if (modeRushExtension?.rush_battle_reward_list?.length && rushEventData) {
        rushEventData.rush_battle_reward_list.push(...modeRushExtension.rush_battle_reward_list)
    }
    const raidEventData = handleRaidEventFinish({
        questCategory, questAccomplished, activeEventId: settlementActiveQuest.eventId ?? undefined,
        killCountWeight: questData.killCountWeight, party, playerId, questId,
        getEvoLevelsFn: (pid, chars) => getCharactersEvolutionImgLevels(pid, chars),
        insertPartyFn: (pid, eid, data) => insertPlayerRushEventPlayedPartySync(pid, eid, data),
        getRequiredKillCountFn: eid => getRaidEventRequiredKillCount(eid),
        getRaidBossStateFn: eid => getRaidEventBossStateSync(eid),
        updateRaidBossStateFn: (eid, state) => upsertRaidEventBossStateSync(eid, state),
        incrementQuestKillCountFn: (pid, eid, qid) => incrementPlayerRaidEventQuestKillCountSync(pid, eid, qid),
    })
    const carnivalFinishResult = handleCarnivalEventFinish({
        questCategory, questAccomplished, questId, questData, clearTime, party, playerId,
        getRecordsFn: (pid, eid) => getPlayerCarnivalEventRecordsSync(pid, eid),
        upsertFn: (pid, eid, fid, score, chars, unisons) => upsertPlayerCarnivalEventRecordSync(pid, eid, fid, score, chars, unisons),
        getRewardDefinitionsFn: eid => getCarnivalRewardDefinitions(eid),
        getClaimedRewardIdsFn: (pid, eid) => getPlayerClaimedCarnivalRewardIdsSync(pid, eid),
        grantRewardsFn: (pid, definitions) => grantCarnivalRewards(pid, definitions, {
            getPlayer: getPlayerSync, giveItem: givePlayerItemSync,
            giveEquipment: givePlayerEquipmentSync, giveDegree: givePlayerDegreeSync,
            updatePlayer: updatePlayerSync,
        }),
        claimRewardIdsFn: (pid, eid, rewardIds) => insertPlayerClaimedCarnivalRewardIdsSync(pid, eid, rewardIds),
        transactionFn: runCarnivalEventTransactionSync,
    })
    const carnivalEventData = carnivalFinishResult?.carnivalEventData ?? null
    const carnivalRewardResult = carnivalFinishResult?.rewardResult

    if (isScoreAttackEvent) insertPlayerScoreAttackBattleHistorySync(buildScoreAttackBattleHistoryRecord({
        playerId, eventId: questData.eventId!, playId: settlementActiveQuest.playId,
        categoryId: questCategory, questId, finishKind: 0, createdAt: settlementTime,
        elapsedTimeMs: clearTime, score: body.score, clearRank, party,
        statistics: body.statistics, equipmentList: getPlayerEquipmentListSync(playerId),
    }))
    if (questCategory === QuestCategory.PRACTICE) insertPlayerPracticeBattleHistorySync(buildPracticeBattleHistoryRecord({
        playerId, playId: settlementActiveQuest.playId, categoryId: questCategory, questId,
        finishKind: questAccomplished ? 0 : 1, createdAt: settlementTime,
        elapsedTimeMs: clearTime, score: body.score, clearRank: questAccomplished ? clearRank : null,
        party, statistics: body.statistics, equipmentList: getPlayerEquipmentListSync(playerId),
    }))
    const scoreAttackFinishResult = isScoreAttackEvent ? handleScoreAttackEventFinish({
        playerId, questId, category: questCategory, score: body.score,
        elapsedTimeMs: clearTime, isAccomplished: questAccomplished,
        quest: {
            bRankScore: questData.bRankScore!, aRankScore: questData.aRankScore!,
            sRankScore: questData.sRankScore!, ssRankScore: questData.ssRankScore!,
        },
        tiers: scoreAttackBorderTiers, party,
    }, {
        transaction: operation => operation(),
        getProgress: (pid, category, qid) => getPlayerSingleQuestProgressSync(pid, category, qid),
        grantRewards: (pid, rewards) => grantDirectRewards(pid, "score_attack", rewards),
        updateProgress: (pid, category, progress) => updatePlayerQuestProgressSync(pid, category, progress),
        insertProgress: (pid, category, progress) => insertPlayerQuestProgressSync(pid, category, progress),
        deleteActiveQuest: pid => deletePlayerActiveQuestSync(pid),
    }) : null
    const scoreAttackRewardResult = scoreAttackFinishResult?.rewardResult
    const missionSettlement = settleMissionCategories(
        playerId, buildBattleMissionSettlementScopes(partyCharacterIds), settlementTime,
    )
    const awakeMissionSettlement = settleAwakeBattleMissions({
        playerId, questAccomplished, characterIds: partyCharacterIds,
        directlyChangedMissionIds: missionBattleFacts.awakeMissionIds,
        evaluationTime: settlementTime,
    })
    const activeMissionList = reconcileActiveMissionFacts({
        playerId, repository: getContentSnapshot().repository, now: settlementTime,
    })
    const itemList = {
        ...(settlementActiveQuest.entryItemId
            ? { [settlementActiveQuest.entryItemId]: getPlayerItemSync(playerId, settlementActiveQuest.entryItemId) ?? 0 }
            : {}),
        ...scoreRewardsResult.items,
        ...(additionalRewardSettlement.rewardResult?.items ?? {}),
        ...(scoreAttackRewardResult?.items ?? {}),
        ...(rushEventRewardsResult?.items ?? {}),
        ...(carnivalRewardResult?.item_list ?? {}),
    }
    const characterList = reconcileAwakeUnlockCharacterList(playerId, [
        ...rewardCharacterExpResult.character_list as unknown as Record<string, unknown>[],
        ...((clearReward?.character_list || []) as Record<string, unknown>[]),
        ...((sPlusClearReward?.character_list || []) as Record<string, unknown>[]),
        ...(scoreRewardsResult.character_list as Record<string, unknown>[]),
        ...((scoreAttackRewardResult?.character_list ?? []) as Record<string, unknown>[]),
        ...(missionSettlement.characterList as Record<string, unknown>[]),
        ...awakeMissionSettlement.characterList,
    ])
    if (!isScoreAttackEvent) deletePlayerActiveQuestSync(playerId)

    return {
        afterStamina, afterStaminaHealTime, dailyChallengePointList,
        scoreRewardSelection, scoreRewardsResult,
        additionalRewardSettlement, rewardCharacterExpResult, rushEventData, rushEventRewardsResult,
        raidEventData, carnivalEventData, carnivalRewardResult, scoreAttackFinishResult,
        scoreAttackRewardResult, itemList, characterList, clearReward, sPlusClearReward,
        missionSettlement, awakeMissionSettlement, activeMissionList, fixedManaReward,
        fixedPoolExpReward, newMana, beforeRankPoint, newRankPoint, newBoostPoint, newBossBoostPoint,
    }
}

export type SingleSettlementWritesResult = ReturnType<typeof executeSingleSettlementWrites>
