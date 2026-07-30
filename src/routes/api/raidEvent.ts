import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDefaultPlayerRushEventSync, getPlayerRushEventClearedFoldersSync, getPlayerRushEventSync, insertPlayerRushEventSync } from "../../data/domains/rushEvent"
import { getDefaultPlayerPartyGroupsSync, getPlayerSync } from "../../data/domains/player"
import { getPlayerCharactersSync } from "../../data/domains/character"
import { ensurePlayerPartyGroupListSync, getPlayerPartyGroupListSync } from "../../data/domains/party"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders, getServerDate } from "../../utils";
import { PartyCategory } from "../../data/types";
import { clientSerializeDate } from "../../data/utils";
import { getSerializedPlayerRushEventPlayedPartiesSync, getPlayerRushEventEndlessBattleRankingSync } from "../../lib/rush";
import { insertActiveQuest } from "../../lib/quest/active-quest-service";
import { getQuestFromCategorySync } from "../../lib/assets";
import { BattleQuest, QuestCategory } from "../../lib/types";
import { ensureSpecialEventPartyGroupsSync, resolvePartyGroupColorId } from "../../lib/special-event-parties";
import {
    getPlayerRaidEventQuestCountsSync,
    getPlayerRaidEventSync,
    getRaidEventBossStateSync,
    upsertPlayerRaidEventSync,
} from "../../data/domains/raidEvent";
import { getDb } from "../../data/db";
import { givePlayerRewardsSync } from "../../lib/quest";
import {
    getRaidEventOverallRewardDefinitions,
    toRaidEventRewardResponse,
} from "../../lib/quest/finish/raid-overall-rewards";
import { settleRaidEventSummary } from "../../lib/raid-event-summary";
import { getRaidEventRequiredKillCount } from "../../lib/raid-event-master";
import { getRaidBossHpPercentage } from "../../lib/quest/finish/raid-handler";
import { getMailArrivedSync } from "../../lib/mail-notification";
import { recordRaidSummaryMissionFactFailSoftSync } from "../../lib/mission/event-entry-facts";

interface EventIdBody {
    event_id: number,
    viewer_id: number,
    api_count: number
}

interface RushPartyGroup {
    party_group_color_id: number,
    party_group_id: number,
    party_list: RushParty[]
}

interface RushParty {
    ability_soul_ids: (number | null)[],
    character_ids: (number | null)[],
    equipment_ids: (number | null)[],
    unison_character_ids: (number | null)[],
    options: { allow_other_players_to_heal_me: boolean },
    party_edited: boolean,
    party_id: number,
    party_name: string
}

const routes = async (fastify: FastifyInstance) => {
    // ---- summary (entry point) ----
    fastify.post("/summary", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as EventIdBody;
        const viewerId = body.viewer_id;
        const eventId = body.event_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No player bound to account."
        })
        const requiredKillCount = getRaidEventRequiredKillCount(eventId)
        if (requiredKillCount === undefined) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid raid event id."
        })
        const rewardDefinitions = getRaidEventOverallRewardDefinitions(eventId)
        const evaluationTime = getServerDate()

        // Rush event data for played party tracking
        let rushEventData = getPlayerRushEventSync(playerId, eventId)
        if (rushEventData === null) {
            rushEventData = getDefaultPlayerRushEventSync(eventId)
            insertPlayerRushEventSync(playerId, rushEventData)
        }
        const clearedFolderIdList = getPlayerRushEventClearedFoldersSync(playerId, eventId)
        const serializedPlayedParties = getSerializedPlayerRushEventPlayedPartiesSync(playerId, eventId)
        console.log(`[RAID] summary: folderParties=${Object.keys(serializedPlayedParties.folderParties ?? {}).length} endlessParties=${Object.keys(serializedPlayedParties.endlessParties ?? {}).length}`)

        const summary = getDb().transaction(() => {
            recordRaidSummaryMissionFactFailSoftSync(playerId, eventId, evaluationTime)
            const raidBossState = getRaidEventBossStateSync(eventId)
                ?? { weightedKillCount: 0, totalKillCount: 0 }
            const playerState = getPlayerRaidEventSync(playerId, eventId)
            const settlement = settleRaidEventSummary({
                playerId,
                totalKillCount: raidBossState.totalKillCount,
                receivedUpTo: playerState?.receivedUpTo ?? 0,
                definitions: rewardDefinitions,
                giveRewards: (pid, rewards) => givePlayerRewardsSync(pid, rewards),
                updateReceivedUpTo: receivedUpTo => {
                    upsertPlayerRaidEventSync(
                        playerId,
                        eventId,
                        raidBossState.totalKillCount,
                        receivedUpTo,
                    )
                },
            })
            return {
                raidBossState,
                settlement,
                questCounts: getPlayerRaidEventQuestCountsSync(playerId, eventId),
                player: getPlayerSync(playerId),
            }
        })()
        if (!summary.player) throw new Error(`player ${playerId} disappeared during raid summary`)
        const questList = Object.fromEntries(Object.entries(summary.questCounts).map(([questId, killCount]) => [
            questId,
            { kill_count: killCount },
        ]))

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "aggregated_time": clientSerializeDate(getServerDate()),
                "auto_start_point": 0,
                "kill_count_reward_data": {
                    "received_up_to": summary.raidBossState.totalKillCount,
                    "reward_list": summary.settlement.grants.map(toRaidEventRewardResponse),
                },
                "quest_list": questList,
                "raid_boss": {
                    "hp_percentage": getRaidBossHpPercentage(summary.raidBossState, requiredKillCount),
                    "total_kill_count": summary.raidBossState.totalKillCount,
                },
                ...(summary.settlement.rewardResult ? {
                    "user_info": {
                        "free_mana": summary.player.freeMana,
                        "free_vmoney": summary.player.freeVmoney,
                        "exp_pool": summary.player.expPool,
                    },
                    "character_list": summary.settlement.rewardResult.character_list,
                    "joined_character_id_list": summary.settlement.rewardResult.joined_character_id_list,
                    "equipment_list": summary.settlement.rewardResult.equipment_list,
                    "item_list": summary.settlement.rewardResult.items,
                } : {}),
                "mail_arrived": getMailArrivedSync(playerId),
                "endless_battle_next_round": rushEventData.endlessBattleNextRound,
                "active_rush_battle_folder_id": rushEventData.activeRushBattleFolderId,
                "endless_battle_played_max_round": rushEventData.endlessBattleNextRound,
                "cleared_folder_id_list": clearedFolderIdList,
                "endless_battle_played_party_list": serializedPlayedParties.endlessParties,
                "rush_battle_played_party_list": serializedPlayedParties.folderParties,
                "endless_battle_my_ranking": getPlayerRushEventEndlessBattleRankingSync(playerId, eventId, { rushEventData }),
            }
        });
    });

    // ---- get_boss ----
    fastify.post("/get_boss", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as EventIdBody;
        const viewerId = body.viewer_id;
        const eventId = body.event_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })
        const requiredKillCount = getRaidEventRequiredKillCount(eventId)
        if (requiredKillCount === undefined) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid raid event id."
        })
        const raidBossState = getRaidEventBossStateSync(eventId)
            ?? { weightedKillCount: 0, totalKillCount: 0 }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "raid_boss": {
                    "hp_percentage": getRaidBossHpPercentage(raidBossState, requiredKillCount),
                    "total_kill_count": raidBossState.totalKillCount
                }
            }
        });
    });

    // ---- party (get event party groups) ----
    fastify.post("/party", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, api_count: number };
        const viewerId = body.viewer_id;
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No player bound to account."
        })

        const playerPartyGroups = ensureSpecialEventPartyGroupsSync(
            playerId,
            PartyCategory.RAID,
            PartyCategory.RUSH,
            {
                getGroups: getPlayerPartyGroupListSync,
                getDefaults: getDefaultPlayerPartyGroupsSync,
                ensureGroups: ensurePlayerPartyGroupListSync,
            },
        )
        const group1 = playerPartyGroups['1']
        const partyList: RushParty[] = []

        if (group1 && group1.list) {
            let count = 0
            for (const [pidStr, party] of Object.entries(group1.list)) {
                if (count >= 3) break
                count++
                partyList.push({
                    ability_soul_ids: party.abilitySoulIds,
                    character_ids: party.characterIds,
                    equipment_ids: party.equipmentIds,
                    unison_character_ids: party.unisonCharacterIds,
                    options: { allow_other_players_to_heal_me: party.options.allowOtherPlayersToHealMe },
                    party_edited: party.edited,
                    party_id: Number(pidStr),
                    party_name: party.name
                })
            }
        }

        // Fallback: fill empty parties with leader characters if NORMAL is empty
        while (partyList.length < 3) {
            const pid = partyList.length + 1
            const playerChars = getPlayerCharactersSync(playerId)
            const leaderIds = Object.keys(playerChars).map(Number).filter(id => id > 0).sort((a, b) => a - b)
            const usedIds = new Set(partyList.flatMap(p => p.character_ids.filter(c => c !== null) as number[]))
            const leaderId = leaderIds.find(id => !usedIds.has(id)) ?? null
            partyList.push({
                ability_soul_ids: [null, null, null],
                character_ids: [leaderId, null, null],
                equipment_ids: [null, null, null],
                unison_character_ids: [null, null, null],
                options: { allow_other_players_to_heal_me: true },
                party_edited: false,
                party_id: pid,
                party_name: `Party ${pid}`
            })
        }

        const userPartyGroupList: RushPartyGroup[] = [{
            "party_group_color_id": resolvePartyGroupColorId(group1),
            "party_group_id": 1,
            "party_list": partyList
        }]

        const partyDump = userPartyGroupList.map(g => ({
            gid: g.party_group_id,
            parties: g.party_list.map(p => ({ pid: p.party_id, chars: p.character_ids, unisons: p.unison_character_ids }))
        }))
        console.log(`[RAID] party: response=${JSON.stringify(partyDump)}`)

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_party_group_list": userPartyGroupList
            }
        });
    });

    // ---- battle/start ----
    fastify.post("/battle/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            quest_id: number, party_group_id: number, play_id: string,
            use_auto_start_point: boolean, is_auto_start_mode: boolean,
            auto_start_times?: number, event_id?: number,
            viewer_id: number, api_count: number
        };
        const viewerId = body.viewer_id;
        console.log(`[RAID] battle/start body: questId=${body.quest_id} eventId=${body.event_id} partyGroup=${body.party_group_id}`)
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        });

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error", "message": "No player bound to account."
        })

        const questData = getQuestFromCategorySync(QuestCategory.RAID_EVENT, body.quest_id) as BattleQuest | null
        if (questData === null || questData.eventId === undefined) return reply.status(400).send({
            "error": "Bad Request", "message": "Quest doesn't exist."
        })

        // Register active quest for /single_battle_quest/finish. The request has
        // no event_id, so derive it from the CN raid quest master data.
        const raidEventId = questData.eventId
        insertActiveQuest(playerId, {
            questId: body.quest_id,
            category: QuestCategory.RAID_EVENT,
            useBossBoostPoint: false,
            useBoostPoint: false,
            isAutoStartMode: body.is_auto_start_mode,
            isMulti: false,
            eventId: raidEventId,
            playId: body.play_id,
            continueCount: 0
        })

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        });
    });

};

export default routes;
