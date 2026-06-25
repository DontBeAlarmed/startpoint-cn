import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deletePlayerRushEventPlayedPartyListSync, getPlayerActiveQuestSync, insertPlayerActiveQuestSync, deletePlayerActiveQuestSync, updatePlayerActiveQuestContinueCountSync, getPlayerDailyChallengePointListSync, getPlayerItemSync, getPlayerRushEventPlayedPartiesSync, getPlayerRushEventSync, getPlayerSingleQuestProgressSync, getPlayerSync, getSession, givePlayerItemSync, insertPlayerQuestProgressSync, insertPlayerRushEventClearedFolderSync, insertPlayerRushEventPlayedPartySync, updatePlayerDailyChallengePointSync, updatePlayerEquipmentSync, updatePlayerItemSync, updatePlayerQuestProgressSync, updatePlayerRushEventSync, updatePlayerSync, upsertPlayerCarnivalEventRecordSync } from "../../data/wdfpData";
import { getQuestFromCategorySync, getRushEventFolderClearRewards } from "../../lib/assets";
import { getCharactersEvolutionImgLevels, givePlayerCharactersExpSync } from "../../lib/character";
import { givePlayerRewardsSync, givePlayerRewardSync, givePlayerScoreRewardsSync } from "../../lib/quest";
import { BattleQuest, EquipmentItemReward, PlayerRewardResult, QuestCategory } from "../../lib/types";
import { generateDataHeaders, getServerTime } from "../../utils";
import { rushEventFolderMaxRounds } from "./rushEvent";
import { RushEventBattleType, UserRushEventPlayedParty } from "../../data/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { computeRealTimeStamina, getRankDegree, getMaxStamina } from "../../lib/stamina";
import { readFileSync, existsSync } from "fs";
import path from "path";
import questEntryCosts from "../../../assets/quest_entry_costs.json";
import scoreAttackBorderRewards from "../../../assets/score_attack_border_reward.json";
import eventChallengePointMap from "../../../assets/event_challenge_point_map.json";

// Load carnival quest score data
let carnivalScoreLookup: Record<string, { difficulty_score: number, time_limit_ms: number, folder_id: number, event_id: number }> = {}
try {
    const scorePath = path.join(process.cwd(), "assets", "carnival_event_quest_scores.json")
    if (existsSync(scorePath)) {
        carnivalScoreLookup = JSON.parse(readFileSync(scorePath, "utf-8"))
    }
} catch {} // Init failed silently; carnival scoring won't work
import { getSerializedPlayerRushEventPlayedPartiesSync } from "../../lib/rush";

interface StartBody {
    quest_id: number
    use_boss_boost_point: boolean
    use_boost_point: boolean
    category: number
    viewer_id: number
    play_id: string
    is_auto_start_mode: boolean
    party_id: number
    api_count: number
}

interface QuestStatistics {
    clear_phase: number,
    party: {
        unison_characters: ({ id: (number | null) } | null)[],
        characters: ({ id: (number | null) } | null)[],
        equipments: ({ id: (number | null) } | null)[],
        ability_soul_ids: (number | null)[],
        leader?: ({ id: (number | null) } | null)
    }
}

export interface FinishBody {
    is_restored: boolean
    continue_count: number
    elapsed_time_ms: number
    quest_id: number
    category: number
    score: number
    viewer_id: number
    add_mana: number
    is_accomplished: boolean
    statistics: QuestStatistics
    api_count: number
}

interface PlayContinueBody {
    api_count: number,
    payment_type: number,
    quest_id: number,
    viewer_id: number,
    paly_id: string,
    category: number
}

interface AbortBody {
    api_count: number,
    finish_kind: number,
    statistics: QuestStatistics,
    viewer_id: number,
    quest_id: number,
    play_id: string,
    category: number
}

interface ReturnRushEvent {
    rush_battle_reward_list: {
        kind: number,
        kind_id: number,
        number: number
    }[],
    rush_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null,
    endless_battle_played_party_list: Record<number, UserRushEventPlayedParty> | null,
    is_out_of_period: boolean,
    endless_battle_next_round: number | null,
    endless_battle_max_round: number | null,
    high_score: number | null,
    best_elapsed_time_ms: number | null,
    old_endless_battle_max_round: number | null,
    old_best_elapsed_time_ms: number | null
}

export interface ActiveQuest {
    questId: number,
    category: QuestCategory,
    useBossBoostPoint: boolean,
    useBoostPoint: boolean,
    isAutoStartMode: boolean,
    isMulti: boolean,
    roomNumber?: string,
    matePlayerIds?: number[],
    mateComIds?: number[],
    entryItemId?: number,
    eventId?: number,
    playId: string,
    continueCount: number
}

const continueVmoneyCost = 50;

export const activeQuests: Record<number, ActiveQuest> = {}

export function insertActiveQuest(playerId: number, quest: ActiveQuest) {
    activeQuests[playerId] = quest
    // Persist to DB for battle recovery across server restarts
    insertPlayerActiveQuestSync(playerId, {
        playerId,
        playId: quest.playId,
        questId: quest.questId,
        category: quest.category,
        useBossBoostPoint: quest.useBossBoostPoint,
        useBoostPoint: quest.useBoostPoint,
        isAutoStartMode: quest.isAutoStartMode,
        isMulti: quest.isMulti,
        roomNumber: quest.roomNumber ?? null,
        entryItemId: quest.entryItemId ?? null,
        eventId: quest.eventId ?? null,
        continueCount: quest.continueCount
    })
}

const routes = async (fastify: FastifyInstance) => {

    fastify.post("/finish", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FinishBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const playerData = playerId !== null ? getPlayerSync(playerId) : null

        if (playerData === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get active quest data
        const activeQuestData = activeQuests[playerId]
        console.log(`[FINISH] req: playerId=${playerId} questId=${body.quest_id} category=${body.category} activeExists=${activeQuestData !== undefined} multi=${activeQuestData?.isMulti ?? false}`)
        if (activeQuestData === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No active quest to finish."
        })

        const questCategory = activeQuestData.category
        const questId = activeQuestData.questId
        console.log(`[FINISH] active: category=${questCategory} questId=${questId}`)
        const questData = getQuestFromCategorySync(questCategory, questId) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData)) {
            console.log(`[BATTLE] finish failed: category=${questCategory} questId=${questId} found=${!!questData} hasRankReward=${questData ? ('rankPointReward' in questData) : 'N/A'}`)
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Quest doesn't exist."
            })
        }

        // delete the active quest data from global record
        delete activeQuests[playerId]
        deletePlayerActiveQuestSync(playerId)

        // calculate clear rank (only if quest has rank time thresholds)
        const clearTime = body.elapsed_time_ms
        const hasRankThresholds = questData.bRankTime > 0
        const clearRank = hasRankThresholds ? (
            questData.sPlusRankTime >= clearTime ? 5
                : questData.sRankTime >= clearTime ? 4
                    : questData.aRankTime >= clearTime ? 3
                        : questData.bRankTime >= clearTime ? 2
                            : 1
        ) : null

        // calculate player rewards
        const newExpPool = playerData.expPool + questData.poolExpReward
        const beforeRankPoint = playerData.rankPoint
        const newRankPoint = beforeRankPoint + questData.rankPointReward
        let newMana = playerData.freeMana + questData.manaReward + body.add_mana

        // calculate boost point
        let newBoostPoint = playerData.boostPoint - (activeQuestData.useBoostPoint ? 1 : 0)
        let newBossBoostPoint = playerData.bossBoostPoint - (activeQuestData.useBossBoostPoint ? 1 : 0)
        let useBoostPoint = (activeQuestData.useBoostPoint && (newBoostPoint >= 0)) || (activeQuestData.useBossBoostPoint && (newBossBoostPoint >= 0))

        // check current quest progress
        const questProgress = getPlayerSingleQuestProgressSync(playerId, questCategory, questId);
        const questPreviouslyCompleted = questProgress !== null

        // Score attack: accomplished determined by border reward minimum tier (from CDN)
        let questAccomplished = body.is_accomplished
        if (questCategory === QuestCategory.SCORE_ATTACK_EVENT) {
            const eventId = questData.eventId
            const folderId = questData.folderId
            if (eventId !== undefined && folderId !== undefined) {
                const borderTiers = (scoreAttackBorderRewards as Record<string, {score: number}[]>)[`${eventId}_${folderId}`]
                if (borderTiers && borderTiers.length > 0) {
                    questAccomplished = body.score >= borderTiers[0].score
                }
            }
        }

        const clearReward = !questPreviouslyCompleted && questData.clearReward !== undefined ? givePlayerRewardSync(playerId, questData.clearReward) : null
        const sPlusClearReward = (clearRank === 5) && (questProgress?.clearRank !== 5) && (questData.sPlusReward !== undefined) ? givePlayerRewardSync(playerId, questData.sPlusReward) : null
        if (questAccomplished) {
            // update quest progress
            if (questPreviouslyCompleted) {
                // simply update the quest progress if it already exists.
                const updateData: any = {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: questProgress.bestElapsedTimeMs === undefined || questProgress.bestElapsedTimeMs === null ? clearTime : Math.min(clearTime, questProgress.bestElapsedTimeMs),
                    highScore: questProgress.highScore === undefined ? body.score : Math.max(body.score, questProgress.highScore)
                }
                if (clearRank !== null) {
                    updateData.clearRank = questProgress.clearRank === undefined ? clearRank : Math.max(clearRank, questProgress.clearRank)
                }
                updatePlayerQuestProgressSync(playerId, questCategory, updateData)
            } else {
                // insert if it doesn't already exist.
                const insertData: any = {
                    questId: questId,
                    finished: true,
                    bestElapsedTimeMs: clearTime,
                    highScore: body.score,
                    clearRank: clearRank ?? 5  // default S+ for quests without rank thresholds
                }
                insertPlayerQuestProgressSync(playerId, questCategory, insertData)
            }
        }

        // update player
        const newDegreeId = getRankDegree(newRankPoint)
        const didLevelUp = newDegreeId > playerData.degreeId
        updatePlayerSync({
            id: playerId,
            freeMana: newMana,
            expPool: newExpPool,
            rankPoint: newRankPoint,
            boostPoint: newBoostPoint,
            bossBoostPoint: newBossBoostPoint,
            degreeId: newDegreeId,
            ...(didLevelUp ? { stamina: playerData.stamina + getMaxStamina(newDegreeId), staminaHealTime: new Date() } : {}),
        })
        if (didLevelUp) {
            playerData.stamina = playerData.stamina + getMaxStamina(newDegreeId)
            playerData.staminaHealTime = new Date()
            console.log(`[BATTLE-FINISH] player ${playerId} leveled up: ${playerData.degreeId} -> ${newDegreeId}, stamina refilled`)
        }
        playerData.degreeId = newDegreeId

        // Consume daily challenge point
        let dailyChallengePointList: Object[] | null = null
        if (questCategory === QuestCategory.EXPERT_SINGLE_EVENT && questData.eventId) {
            const cpKey = `expert_${questData.eventId}`
            const challengePointId = (eventChallengePointMap as Record<string, number>)[cpKey]
            if (challengePointId) {
                const entries = getPlayerDailyChallengePointListSync(playerId)
                const entry = entries.find(e => e.id === challengePointId)
                if (entry && entry.point > 0) {
                    updatePlayerDailyChallengePointSync(playerId, challengePointId, entry.point - 1)
                    console.log(`[BATTLE] challengePoint consumed: id=${challengePointId} old=${entry.point} new=${entry.point - 1}`)
                }
                // Serialize for response
                dailyChallengePointList = entries.map(e => ({
                    "id": e.id,
                    "point": e.id === challengePointId ? Math.max(0, e.point - 1) : e.point,
                    "campaign_list": e.campaignList.map(c => ({
                        "campaign_id": c.campaignId,
                        "additional_point": c.additionalPoint
                    }))
                }))
            }
        }

        // reward score rewards
        if (questCategory === QuestCategory.SCORE_ATTACK_EVENT) {
            console.log(`[SCORE_ATTACK] questId=${questId} body={score:${body.score}, elapsed:${body.elapsed_time_ms}, accomplished:${body.is_accomplished}, addMana:${body.add_mana}, continue:${body.continue_count}}`)
            console.log(`[SCORE_ATTACK] questData={groupId:${questData.scoreRewardGroupId}, groupLen:${questData.scoreRewardGroup?.length ?? 'null'}, bRank:${questData.bRankTime}, aRank:${questData.aRankTime}, sRank:${questData.sRankTime}, sPlus:${questData.sPlusRankTime}, rankPt:${questData.rankPointReward}, charExp:${questData.characterExpReward}, mana:${questData.manaReward}, poolExp:${questData.poolExpReward}, clearReward:${questData.clearReward?.id ?? 'none'}}`)
        }
        console.log(`[BATTLE] scoreReward groupId=${questData.scoreRewardGroupId} groupLen=${questData.scoreRewardGroup?.length ?? 'null'} questId=${questId} category=${questCategory}`)
        const scoreRewardsResult = givePlayerScoreRewardsSync(playerId, questData.scoreRewardGroupId, questData.scoreRewardGroup, useBoostPoint, questData.element)
        let scoreAttackRewardIds: number[] = []
        if (questCategory === QuestCategory.SCORE_ATTACK_EVENT) {
            // Look up border rewards for score attack events
            const eventId = questData.eventId
            const folderId = questData.folderId
            if (eventId !== undefined && folderId !== undefined) {
                const borderKey = `${eventId}_${folderId}`
                const borderTiers = (scoreAttackBorderRewards as Record<string, {score: number, rewardItemId: number, rewardCount: number, coinItemId: number, coinCount: number}[]>)[borderKey]
                if (borderTiers) {
                    // Find highest tier the player's score qualifies for
                    let matched: typeof borderTiers[0] | null = null
                    for (const tier of borderTiers) {
                        if (body.score >= tier.score) {
                            matched = tier
                        }
                    }
                    if (matched) {
                        console.log(`[SCORE_ATTACK] borderReward matched: score=${body.score} tierScore=${matched.score} coinItem=${matched.coinItemId}x${matched.coinCount}`)
                        // Give coin item only (rewardItemId=16001 does not exist in CDN)
                        if (matched.coinItemId > 0 && matched.coinCount > 0) {
                            givePlayerItemSync(playerId, matched.coinItemId, matched.coinCount)
                            scoreRewardsResult.items[String(matched.coinItemId)] = (scoreRewardsResult.items[String(matched.coinItemId)] ?? 0) + matched.coinCount
                            scoreAttackRewardIds.push(matched.coinItemId)
                        }
                    }
                }
            }
            console.log(`[SCORE_ATTACK] afterReward: dropIds=${JSON.stringify(scoreRewardsResult.drop_score_reward_ids)}, drops=${scoreRewardsResult.drop_score_reward_ids.length}, items=${JSON.stringify(scoreRewardsResult.items)}, equipList=${scoreRewardsResult.equipment_list?.length ?? 0}`)
            console.log(`[SCORE_ATTACK] response: accomplished=${questAccomplished}, clearRank=${clearRank}, score=${body.score}, elapsed=${body.elapsed_time_ms}, items=${JSON.stringify(scoreRewardsResult.items)}, clientCategory=${questCategory}`)
        }

        // reward character exp
        const bodyPartyStatistics = body.statistics.party
        const partyCharacterIds = [...bodyPartyStatistics.characters, ...bodyPartyStatistics.unison_characters]
        const partyCharacterIdsArray: number[] = []
        for (const value of partyCharacterIds.values()) {
            if (value !== null && value.id !== null) partyCharacterIdsArray.push(value.id);
        }
        const addExpAmount = questData.characterExpReward

        const rewardCharacterExpResult = givePlayerCharactersExpSync(
            playerId,
            partyCharacterIdsArray,
            addExpAmount,
            questData.fixedParty !== undefined
        )

        const dataHeaders = generateDataHeaders({
            viewer_id: viewerId
        })

        // handle event quest-specific data & rewards
        let rushEventData: ReturnRushEvent | null = null
        let rushEventRewardsResult: PlayerRewardResult | null = null

        if (questCategory === QuestCategory.RUSH_EVENT) {
            // rush event

            const rushEventId = questData.rushEventId
            const rushEventFolderId = questData.rushEventFolderId
            const rushEventRound = questData.rushEventRound
            console.log(`[RUSH] finish: playerId=${playerId} eventId=${rushEventId} folderId=${rushEventFolderId} round=${rushEventRound} clearTime=${clearTime}`)

            if (rushEventFolderId !== undefined && rushEventRound !== undefined && rushEventId !== undefined) {
                // update rush event data
                const rushEventBattleType = rushEventRound === 0 ? RushEventBattleType.ENDLESS : RushEventBattleType.FOLDER

                // map character ids
                const characterIds = bodyPartyStatistics.characters.map(val => val?.id ?? null)
                const unisonCharacterIds = bodyPartyStatistics.unison_characters.map(val => val?.id ?? null)

                // get evolution image levels
                const evolutionImgLevels: (number | null)[] = getCharactersEvolutionImgLevels(playerId, characterIds)
                const unisonEvolutionImgLevels: (number | null)[] = getCharactersEvolutionImgLevels(playerId, unisonCharacterIds)

                let round: number = questId

                // update endless battle stats
                let oldEndlessMaxRound: number | null = null
                let oldBestElapsedTimeMs: number | null = null
                let newEndlessMaxRound: number | null = null
                let newEndlessNextRound: number | null = null
                let newBestElapsedTimeMs: number | null = null

                if (rushEventBattleType === RushEventBattleType.ENDLESS) {
                    // get player rush event data
                    const playerRushEventData = getPlayerRushEventSync(playerId, rushEventId)

                    const playerNextRound = playerRushEventData?.endlessBattleNextRound ?? 1
                    const playerMaxRound = playerRushEventData?.endlessBattleMaxRound ?? 1
                    const playerBestClearTime = playerRushEventData?.endlessBattleMaxRoundTime ?? Number.MAX_SAFE_INTEGER
                    round = playerNextRound

                    // Capture old values before update
                    oldEndlessMaxRound = playerMaxRound
                    oldBestElapsedTimeMs = playerBestClearTime < Number.MAX_SAFE_INTEGER ? playerBestClearTime : null

                    const isNewRecord = (playerNextRound >= playerMaxRound && playerBestClearTime >= clearTime) || (playerNextRound > playerMaxRound)
                    if (isNewRecord) {
                        console.log(`[RUSH] finish: ENDLESS NEW RECORD! round=${playerNextRound} time=${clearTime}`)
                        updatePlayerRushEventSync(playerId, {
                            eventId: rushEventId,
                            endlessBattleMaxRound: playerNextRound,
                            endlessBattleMaxRoundTime: clearTime,
                            endlessBattleMaxRoundCharacterIds: characterIds,
                            endlessBattleMaxRoundCharacterEvolutionImgLvls: evolutionImgLevels
                        })
                        newEndlessMaxRound = playerNextRound
                        newBestElapsedTimeMs = clearTime
                    } else {
                        newEndlessMaxRound = playerMaxRound
                        newBestElapsedTimeMs = playerBestClearTime < Number.MAX_SAFE_INTEGER ? playerBestClearTime : null
                    }
                    newEndlessNextRound = playerNextRound + 1

                    // always record played party for endless
                    insertPlayerRushEventPlayedPartySync(playerId, rushEventId, {
                        characterIds, unisonCharacterIds,
                        equipmentIds: bodyPartyStatistics.equipments.map(val => val?.id ?? null),
                        abilitySoulIds: bodyPartyStatistics.ability_soul_ids,
                        evolutionImgLevels, unisonEvolutionImgLevels,
                        battleType: rushEventBattleType, round
                    })
                } else if (rushEventBattleType === RushEventBattleType.FOLDER) {
                    const isFolderFinal = rushEventRound >= (rushEventFolderMaxRounds[rushEventFolderId] ?? 0)
                    if (isFolderFinal) {
                        // mark folder as complete
                        insertPlayerRushEventClearedFolderSync(playerId, rushEventId, rushEventFolderId)
                        updatePlayerRushEventSync(playerId, { eventId: rushEventId, activeRushBattleFolderId: null })
                        deletePlayerRushEventPlayedPartyListSync(playerId, rushEventId, rushEventBattleType)
                    } else {
                        // record played party for non-final rounds
                        insertPlayerRushEventPlayedPartySync(playerId, rushEventId, {
                            characterIds, unisonCharacterIds,
                            equipmentIds: bodyPartyStatistics.equipments.map(val => val?.id ?? null),
                            abilitySoulIds: bodyPartyStatistics.ability_soul_ids,
                            evolutionImgLevels, unisonEvolutionImgLevels,
                            battleType: rushEventBattleType, round
                        })
                    }
                }

                // get serialized parties
                const serializedPlayedParties = getSerializedPlayerRushEventPlayedPartiesSync(playerId, rushEventId)

                // set rush event data
                const isEndless = rushEventBattleType === RushEventBattleType.ENDLESS
                rushEventData = {
                    "rush_battle_reward_list": [],
                    "rush_battle_played_party_list": serializedPlayedParties.folderParties,
                    "endless_battle_played_party_list": serializedPlayedParties.endlessParties,
                    "is_out_of_period": false,
                    "endless_battle_next_round": isEndless ? newEndlessNextRound : null,
                    "endless_battle_max_round": isEndless ? newEndlessMaxRound : null,
                    "high_score": isEndless ? clearTime : null,
                    "best_elapsed_time_ms": isEndless ? newBestElapsedTimeMs : null,
                    "old_endless_battle_max_round": isEndless ? oldEndlessMaxRound : null,
                    "old_best_elapsed_time_ms": isEndless ? oldBestElapsedTimeMs : null
                }

                // give rewards if allowed (FOLDER only, not ENDLESS)
                if (rushEventBattleType === RushEventBattleType.FOLDER && rushEventRound >= (rushEventFolderMaxRounds[rushEventFolderId] ?? 0)) {
                    const rewards = getRushEventFolderClearRewards(rushEventId, rushEventFolderId) ?? []
                    console.log(`[RUSH] finish: folder clear! rewards=${rewards.length} items`)
                    rushEventRewardsResult = givePlayerRewardsSync(playerId, rewards)

                    rushEventData.rush_battle_reward_list = rewards.map(reward => {
                        const itemReward = reward as EquipmentItemReward
                        return {
                            "kind": 1,
                            "kind_id": itemReward.id,
                            "number": itemReward.count
                        }
                    })
                }
            }
        }

        // Record played party for RAID_EVENT
        if (questCategory === QuestCategory.RAID_EVENT && activeQuestData.eventId) {
            const eventId = activeQuestData.eventId
            const characterIds = bodyPartyStatistics.characters.map(val => val?.id ?? null)
            const unisonCharacterIds = bodyPartyStatistics.unison_characters.map(val => val?.id ?? null)
            const evolutionImgLevels = getCharactersEvolutionImgLevels(playerId, characterIds)
            const unisonEvolutionImgLevels = getCharactersEvolutionImgLevels(playerId, unisonCharacterIds)
            insertPlayerRushEventPlayedPartySync(playerId, eventId, {
                characterIds, unisonCharacterIds,
                equipmentIds: bodyPartyStatistics.equipments.map(val => val?.id ?? null),
                abilitySoulIds: bodyPartyStatistics.ability_soul_ids,
                evolutionImgLevels,
                unisonEvolutionImgLevels,
                battleType: RushEventBattleType.FOLDER,
                round: questId
            })
            console.log(`[RAID] recorded played party: eventId=${eventId} questId=${questId}`)
        }

        // handle carnival event score & records
        let carnivalEventData: any = null
        if (questCategory === QuestCategory.CARNIVAL_EVENT && questAccomplished) {
            const carnivalInfo = carnivalScoreLookup[String(questId)]
            if (carnivalInfo) {
                const characterIds = bodyPartyStatistics.characters.map((v: any) => v?.id ?? null)
                const unisonCharacterIds = bodyPartyStatistics.unison_characters.map((v: any) => v?.id ?? null)
                const leaderCharId = bodyPartyStatistics.leader?.id ?? 0

                const difficultyBonus = carnivalInfo.difficulty_score * 100
                const timeBonus = Math.max(0, carnivalInfo.time_limit_ms - clearTime)
                const totalScore = difficultyBonus + timeBonus

                upsertPlayerCarnivalEventRecordSync(
                    playerId,
                    carnivalInfo.event_id,
                    carnivalInfo.folder_id,
                    totalScore,
                    characterIds,
                    unisonCharacterIds
                )

                // Build carnival_event response for client
                const previousTotalBest = carnivalEventData === null ? 0 : 0  // simplified: no previous total

                carnivalEventData = {
                    is_record_valid: true,
                    leader_character_id: leaderCharId,
                    new_degree_ids: [] as number[],
                    previous_total_best_score: previousTotalBest,
                    reward_ids: [] as number[],
                    score: {
                        difficulty_bonus: difficultyBonus,
                        time_bonus: timeBonus
                    }
                }
            }
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": {
                "user_info": {
                    "free_mana": newMana + (clearReward?.user_info.free_mana || 0) + (sPlusClearReward?.user_info.free_mana || 0) + scoreRewardsResult.user_info.free_mana,
                    "exp_pool": rewardCharacterExpResult.exp_pool + (clearReward?.user_info.exp_pool || 0) + scoreRewardsResult.user_info.exp_pool,
                    "exp_pooled_time": getServerTime(playerData.expPooledTime),
                    "free_vmoney": playerData.freeVmoney + (clearReward?.user_info.free_vmoney || 0) + (sPlusClearReward?.user_info.free_vmoney || 0) + scoreRewardsResult.user_info.free_vmoney,
                    "rank_point": newRankPoint,
                    "degree_id": newDegreeId,
                    "stamina": computeRealTimeStamina(playerData),
                    "stamina_heal_time": getServerTime(),
                    "boost_point": newBoostPoint,
                    "boss_boost_point": newBossBoostPoint
                },
                "add_exp_list": rewardCharacterExpResult.add_exp_list,
                "character_list": [
                    ...rewardCharacterExpResult.character_list,
                    ...(clearReward?.character_list || []),
                    ...(sPlusClearReward?.character_list || []),
                    ...scoreRewardsResult.character_list
                ],
                "bond_token_status_list": rewardCharacterExpResult.bond_token_status_list,
                "rewards": {
                    "overflow_pool_exp": 0,
                    "converted_pool_exp": 0,
                    "reward_pool_exp": questData.poolExpReward,
                    "reward_mana": questData.manaReward,
                    "field_mana": body.add_mana
                },
                "old_high_score": questProgress === null ? 0 : questProgress.highScore || 0,
                "joined_character_id_list": [
                    ...(clearReward?.joined_character_id_list || []),
                    ...(sPlusClearReward?.joined_character_id_list || []),
                    ...scoreRewardsResult.joined_character_id_list
                ],
                "before_rank_point": beforeRankPoint,
                "clear_rank": clearRank ?? 5,
                "drop_score_reward_ids": scoreRewardsResult.drop_score_reward_ids,
                "drop_rare_reward_ids": scoreRewardsResult.drop_rare_reward_ids,
                "drop_additional_reward_ids": [],
                "drop_periodic_reward_ids": [],
                "equipment_list": [
                    ...scoreRewardsResult.equipment_list,
                    ...(clearReward?.equipment_list || []),
                    ...(sPlusClearReward?.equipment_list || []),
                    ...(rushEventRewardsResult?.equipment_list || [])
                ],
                "category_id": body.category,
                "start_time": dataHeaders['servertime'],
                "is_multi": "single",
                "quest_name": "",
                "item_list": {
                    ...(activeQuestData.entryItemId ? { [activeQuestData.entryItemId]: getPlayerItemSync(playerId, activeQuestData.entryItemId) ?? 0 } : {}),
                    ...scoreRewardsResult.items,
                    ...(rushEventRewardsResult?.items ?? {})
                },
                "rush_event": rushEventData,
                "carnival_event": carnivalEventData,
                "user_daily_challenge_point_list": dailyChallengePointList ?? [],
                "presigned_quest_category": []
            }
        })

    })

    fastify.post("/abort", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as AbortBody

        const viewerId = body.viewer_id
        if (isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!

        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        const headers = generateDataHeaders({ viewer_id: body.viewer_id })

        // delete existing active quest
        delete activeQuests[playerId]
        deletePlayerActiveQuestSync(playerId)

        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": {},
                "category_id": body.category,
                "is_multi": "single",
                "start_time": headers['servertime'],
                "quest_name": ""
            }
        })
    })

    fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as StartBody

        const viewerId = body.viewer_id
        const partyId = body.party_id
        const questId = body.quest_id
        const category = body.category
        const useBoostPoint = body.use_boost_point
        const useBossBoostPoint = body.use_boss_boost_point
        const isAutoStartMode = body.is_auto_start_mode
        if (isNaN(viewerId) || isNaN(partyId) || isNaN(questId) || isNaN(category) || useBoostPoint === undefined || useBossBoostPoint === undefined || isAutoStartMode === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!

        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get quest data
        const questData = getQuestFromCategorySync(category, questId) as BattleQuest | null
        if (questData === null || !('rankPointReward' in questData)) {
            console.log(`[BATTLE] start failed: category=${category} questId=${questId} found=${!!questData} hasRankReward=${questData ? ('rankPointReward' in questData) : 'N/A'}`)
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Quest doesn't exist."
            })
        }

        // Deduct entry cost (ticket/item)
        const questKey = `${category}_${questId}`
        const entryCost = (questEntryCosts as Record<string, {itemId: number, itemCount: number, stamina: number}>)[questKey]
        console.log(`[BATTLE] start entry: questId=${questId} questKey=${questKey} entryCost=${JSON.stringify(entryCost)}`)
        if (entryCost && entryCost.itemId > 0) {
            const playerItemCount = getPlayerItemSync(playerId, entryCost.itemId) ?? 0
            console.log(`[BATTLE] start deduct: itemId=${entryCost.itemId} playerHas=${playerItemCount} need=${entryCost.itemCount}`)
            if (playerItemCount < entryCost.itemCount) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": `Not enough entry items (need ${entryCost.itemCount} of ${entryCost.itemId}, have ${playerItemCount}).`
                })
            }
            updatePlayerItemSync(playerId, entryCost.itemId, playerItemCount - entryCost.itemCount)
        }

        // Deduct stamina cost
        const staminaCost = entryCost?.stamina ?? 0
        let afterStamina = 0
        if (staminaCost > 0) {
            const player = getPlayerSync(playerId)
            if (!player) {
                console.error(`[BATTLE-START] player not found: ${playerId}`)
                return reply.status(500).send({
                    "error": "Internal Server Error",
                    "message": "Player not found."
                })
            }
            const currentStamina = computeRealTimeStamina(player)
            if (currentStamina < staminaCost) {
                console.warn(`[BATTLE-START] player ${playerId} stamina insufficient: ${currentStamina} < ${staminaCost}`)
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": "Insufficient stamina."
                })
            }
            const newStamina = Math.max(0, currentStamina - staminaCost)
            updatePlayerSync({
                id: playerId,
                stamina: newStamina,
                staminaHealTime: new Date()
            })
            afterStamina = newStamina
            console.log(`[BATTLE-START] stamina: ${currentStamina} -> ${newStamina} (cost: ${staminaCost})`)
        } else {
            // No stamina deduction, read current stamina for response
            const player = getPlayerSync(playerId)
            afterStamina = player?.stamina ?? 0
        }

        // add to active quests table
        delete activeQuests[playerId]
        activeQuests[playerId] = {
            questId: questId,
            category: category,
            useBoostPoint: useBoostPoint,
            useBossBoostPoint: useBossBoostPoint,
            isAutoStartMode: isAutoStartMode,
            isMulti: false,
            entryItemId: entryCost?.itemId,
            playId: body.play_id,
            continueCount: 0
        }

        // update player last party slot
        if (questData.fixedParty === undefined) {
            updatePlayerSync({
                id: playerId,
                partySlot: partyId
            })
        }

        const dataHeaders = generateDataHeaders({
            viewer_id: viewerId
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": dataHeaders,
            "data": {
                "user_info": {
                    "last_main_quest_id": body.quest_id,
                    "stamina": afterStamina,
                    "stamina_heal_time": getServerTime()
                },
                "category_id": body.category,
                "is_multi": "single",
                "start_time": dataHeaders['servertime'],
                "quest_name": ""
            }
        })
    })

    fastify.post("/play_continue", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PlayContinueBody

        const viewerId = body.viewer_id
        if (isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // get active quest data
        const activeQuestData = activeQuests[playerId]
        if (activeQuestData === undefined) return reply.status(400).send({
            "error": "Bad Request",
            "message": "No active quest to continue."
        })

        const freeVmoney = player.freeVmoney
        const newFreeVmoney = freeVmoney - continueVmoneyCost
        const vmoney = player.vmoney
        const newVmoney = 0 > newFreeVmoney ? vmoney - continueVmoneyCost : vmoney
        if (0 > newFreeVmoney && 0 > newVmoney) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Not enough vmoney to continue"
        })

        // update the player's vmoney balances
        const setNewFreeVmoney = 0 > newFreeVmoney ? freeVmoney : newFreeVmoney
        updatePlayerSync({
            id: playerId,
            freeVmoney: setNewFreeVmoney,
            vmoney: newVmoney
        })

        // increment continue count for battle recovery
        activeQuestData.continueCount++
        updatePlayerActiveQuestContinueCountSync(playerId, activeQuestData.continueCount)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_vmoney": setNewFreeVmoney,
                    "vmoney": newVmoney
                },
                "mail_arrived": false
            }
        })

    })
}

export default routes;