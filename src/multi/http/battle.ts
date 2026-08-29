import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getRealNow } from "../../runtime/time/game-time";
import { MultiStartBody, MultiFinishBody, MultiAbortBody, PlayContinueBody } from "../types";
import { generateDataHeaders, realToVirtual } from "../../utils";
import { getRoom, disbandRoom } from "../room/manager";
import { sessionManager } from "../state/SessionManager";
import {
    ActiveQuestSettlementConflictError,
    activeQuests,
    persistActiveQuest,
    publishActiveQuest,
    runAbortActiveQuestTransaction,
    runContinueActiveQuestTransaction,
} from "../../lib/quest/active-quest-service";
import { getPlayerActiveQuestSync } from "../../data/domains/quest_active";
import {
    getPlayerSync,
    updatePlayerSync,
} from "../../data/domains/player";
import { getPlayerItemSync, updatePlayerItemSync } from "../../data/domains/item";
import { getQuestConfigurationErrorResponse, getQuestFromCategorySync } from "../../lib/assets";
import { getServerGameplaySettingsSync } from "../../data/domains/server-settings";
import { computeRealTimeStamina } from "../../lib/stamina";
import { getStaminaCost } from "../../lib/stamina-cost";
import { BattleQuest } from "../../lib/types";
import { getDb } from "../../data/db";
import { getRuntimeContentTableSync } from "../../content/runtime/table-access";
import bundledQuestEntryCosts from "../../../assets/quest_entry_costs.json";
import {
    ActiveQuestAlreadyExistsError,
    buildStartEntryItemList,
    InsufficientEntryItemError,
    InsufficientStaminaError,
    PlayerNotFoundError,
    runStartEntryTransaction,
    type StartEntryCost,
} from "../../lib/quest/start-entry";
import {
    validateMultiStartRequest,
} from "../../lib/quest/multi-battle-validation";
import { isValidMultiViewerId, type MultiHttpContext } from "./context";
import {
    participantKey,
    type ParticipantIdentity,
} from "../coordinator/contracts";
import {
    prepareMultiplayerSettlement,
    runMultiplayerSettlementOrchestration,
} from "../settlement/orchestrator";
import { projectMultiplayerFinishResponse } from "../settlement/response";
import { resolveLocalRescueFragmentEligibility } from "../rescue-fragment-reward";

export function canAbortMultiBattle(
    roomNumber: string,
    participant: ParticipantIdentity,
): boolean {
    const room = getRoom(roomNumber);
    return room?.host_viewer_id !== participant.viewerId
        || sessionManager.isBattleHostParticipant(roomNumber, participant);
}

export function cleanupAbortedMultiBattle(
    roomNumber: string,
    participant: ParticipantIdentity,
): boolean {
    const room = getRoom(roomNumber);
    if (!canAbortMultiBattle(roomNumber, participant)) return false;
    if (room?.host_viewer_id === participant.viewerId) {
        return disbandRoom(roomNumber);
    }
    sessionManager.removeBattleParticipant(roomNumber, participant);
    return false;
}

export function registerBattleRoutes(fastify: FastifyInstance, context: MultiHttpContext): void {

    // ---- start ----
    fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiStartBody;
        const { viewer_id, quest_id, category, party_id, use_boost_point, use_boss_boost_point, is_auto_start_mode, room_number, mate_player_ids, play_id } = body;
        console.log("[MULTI] start received");

        const requestValidation = validateMultiStartRequest({
            viewerId: viewer_id,
            partyId: party_id,
            questId: quest_id,
            category,
            playId: play_id,
            useBoostPoint: use_boost_point,
            useBossBoostPoint: use_boss_boost_point,
            isAutoStartMode: is_auto_start_mode,
            isRoomMember: true,
            roomCategory: category,
            roomQuestId: quest_id,
        });
        if (!requestValidation.ok) {
            return reply.status(400).send({
                "error": "Bad Request", "message": requestValidation.message,
            });
        }

        const ctx = await context.resolvePlayerContext(viewer_id);
        if (!ctx) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id or no player bound."
            });
        }

        let questData: BattleQuest | null;
        try {
            questData = getQuestFromCategorySync(category, quest_id);
        } catch (error) {
            const configurationError = getQuestConfigurationErrorResponse(error);
            if (configurationError !== null) return reply.status(500).send(configurationError);
            throw error;
        }
        if (questData === null || !('rankPointReward' in questData)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Quest doesn't exist."
            });
        }

        const availability = context.questAvailability.check(category, quest_id);
        if (!availability.available) {
            return reply.status(400).send({
                "error": availability.code, "message": "Quest is not available."
            });
        }

        const compatibility = context.snapshotProvider.getCompatibility(request.headers);
        if (!compatibility.ok) {
            return reply.status(400).send({
                "error": compatibility.error, "message": "Battle session is unavailable.",
            });
        }

        const participant = context.snapshotProvider.getParticipant(viewer_id);
        const room = await context.coordinator.getRoomStatus({
            participant,
            roomNumber: room_number,
        });
        const identityKey = participantKey(participant.nodeSessionId, participant.viewerId);
        const isRoomMember = room.ok && room.value.members.some(member => participantKey(
            member.nodeSessionId,
            member.viewerId,
        ) === identityKey);
        const roomValidation = validateMultiStartRequest({
            viewerId: viewer_id,
            partyId: party_id,
            questId: quest_id,
            category,
            playId: play_id,
            useBoostPoint: use_boost_point,
            useBossBoostPoint: use_boss_boost_point,
            isAutoStartMode: is_auto_start_mode,
            isRoomMember,
            roomCategory: room.ok ? room.value.category : -1,
            roomQuestId: room.ok ? room.value.questId : -1,
        });
        if (!room.ok || !roomValidation.ok) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": roomValidation.ok ? "Room is unavailable." : roomValidation.message,
            });
        }

        const battle = await context.coordinator.startBattle({
            participant,
            roomNumber: room_number,
            compatibility: compatibility.value,
        });
        if (!battle.ok
            || battle.value.finalized
            || battle.value.roomNumber !== room_number
            || participantKey(
                battle.value.host.nodeSessionId,
                battle.value.host.viewerId,
            ) !== participantKey(room.value.host.nodeSessionId, room.value.host.viewerId)
            || !battle.value.participants.some(member => participantKey(
                member.nodeSessionId,
                member.viewerId,
            ) === identityKey)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Battle session is unavailable.",
            });
        }

        const isRoomHost = participantKey(
            room.value.host.nodeSessionId,
            room.value.host.viewerId,
        ) === identityKey;
        const questKey = `${category}_${quest_id}`;
        const entryCost = isRoomHost
            ? getRuntimeContentTableSync(
                "quest_entry_costs.json",
                bundledQuestEntryCosts as Record<string, StartEntryCost>,
            )[questKey]
            : undefined;
        const staminaCost = isRoomHost ? getStaminaCost(questKey).cost : 0;
        const coordinatorOrigin = await context.resolveCoordinatorOrigin({
            participant,
            roomNumber: battle.value.roomNumber,
        });
        const gameplaySettings = getServerGameplaySettingsSync();
        const rescueFragmentEligible = resolveLocalRescueFragmentEligibility({
            allMultiRoomsEligible: gameplaySettings.multiRescueFragmentRewardsEnabled,
            isRoomHost,
            hostSelfRescueEnabled: gameplaySettings.multiRescueHostRewardsEnabled,
        });
        const activeQuest = {
            questId: quest_id,
            category,
            useBoostPoint: use_boost_point,
            useBossBoostPoint: use_boss_boost_point,
            isAutoStartMode: is_auto_start_mode,
            isMulti: true,
            coordinatorOrigin,
            roomNumber: room_number,
            battleSessionId: battle.value.battleSessionId,
            matePlayerIds: Array.isArray(mate_player_ids) ? mate_player_ids : [],
            mateComIds: [],
            rescueFragmentEligible,
            entryItemId: entryCost && entryCost.itemId > 0 ? entryCost.itemId : undefined,
            entryItemCount: entryCost && entryCost.itemCount > 0 ? entryCost.itemCount : undefined,
            playId: play_id,
            continueCount: 0,
        };
        const startTime = getRealNow();
        let startResult;
        try {
            startResult = runStartEntryTransaction({
                playerId: ctx.playerId,
                entryCost,
                staminaCost,
                partyId: party_id,
                updatePartySlot: questData.fixedParty === undefined,
                activeQuest,
                now: startTime,
            }, {
                transaction: operation => getDb().transaction(operation)(),
                getActiveQuest: getPlayerActiveQuestSync,
                getPlayer: getPlayerSync,
                computeStamina: computeRealTimeStamina,
                getItemCount: getPlayerItemSync,
                updateItemCount: updatePlayerItemSync,
                updatePlayer: updatePlayerSync,
                persistActiveQuest,
                publishActiveQuest,
            });
        } catch (error) {
            if (error instanceof ActiveQuestAlreadyExistsError
                || error instanceof InsufficientEntryItemError
                || error instanceof InsufficientStaminaError
                || error instanceof PlayerNotFoundError) {
                return reply.status(400).send({
                    "error": "Bad Request", "message": error.message,
                });
            }
            throw error;
        }
        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id }),
            "data": {
                "is_multi": "multi",
                "play_id": play_id,
                "user_info": {
                    "stamina": startResult.afterStamina,
                    "stamina_heal_time": realToVirtual(startTime),
                },
                "item_list": buildStartEntryItemList(startResult),
            }
        });
    });

    // ---- finish ----
    fastify.post("/finish", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiFinishBody;
        const viewerId = body.viewer_id;
        console.log("[MULTI] finish received");

        if (!isValidMultiViewerId(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await context.resolvePlayerContext(viewerId);
        if (!ctx || !ctx.player) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id."
            });
        }

        const { playerId } = ctx;
        const preparation = await prepareMultiplayerSettlement({
            body,
            context,
            playerId,
            viewerId,
        });
        if (!preparation.ok) {
            return reply.status(preparation.statusCode).send(preparation.response);
        }
        let settlementResult;
        try {
            settlementResult = runMultiplayerSettlementOrchestration(preparation.value);
        } catch (error) {
            if (error instanceof ActiveQuestSettlementConflictError) {
                return reply.status(400).send({
                    "error": "Bad Request", "message": error.message,
                });
            }
            throw error;
        }
        const response = await projectMultiplayerFinishResponse({
            activeQuest: preparation.value.activeQuest,
            body,
            playerId,
            settlement: settlementResult,
            viewerId,
        });
        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send(response);
    });

    // ---- abort ----
    fastify.post("/abort", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as MultiAbortBody;
        const viewerId = body.viewer_id;
        console.log("[MULTI] abort received");

        if (!isValidMultiViewerId(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await context.resolvePlayerContext(viewerId);
        if (!ctx) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id or no player bound."
            });
        }

        const { playerId } = ctx;
        const participant = context.snapshotProvider.getParticipant(viewerId);
        const activeQuestData = activeQuests[playerId];
        const storedQuest = getPlayerActiveQuestSync(playerId)
        if (!activeQuestData
            || !storedQuest
            || !storedQuest.isMulti
            || typeof storedQuest.roomNumber !== "string"
            || storedQuest.playId !== body.play_id
            || storedQuest.questId !== body.quest_id
            || storedQuest.category !== body.category) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Active quest does not match abort request."
            })
        }
        const abortResult = runAbortActiveQuestTransaction(playerId, {
            playId: body.play_id,
            questId: body.quest_id,
            category: body.category,
        });
        if (!abortResult.cancelled) return reply.status(400).send({
            "error": "Bad Request", "message": "Active quest was already changed."
        })

        try {
            const hubAbort = await context.coordinator.abortBattle({
                participant,
                roomNumber: storedQuest.roomNumber,
            })
            if (!hubAbort.ok) {
                console.warn(
                    `[MULTI] abort: Hub cleanup deferred to node session invalidation`
                    + `/revocation for room ${storedQuest.roomNumber}`
                    + ` (${hubAbort.error})`,
                )
            }
        } catch {
            console.warn(
                `[MULTI] abort: Hub cleanup deferred to node session invalidation`
                + `/revocation for room ${storedQuest.roomNumber}`,
            )
        }

        const headers = generateDataHeaders({ viewer_id: viewerId });
        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": headers,
            "data": {
                "user_info": {},
                "category_id": body.category,
                "is_multi": "multi",
                "start_time": headers['servertime'],
                "quest_name": "",
                "aborted_play_id": null,
                "unfinished_play_id": null,
                "drawn_quest": null,
                "party_info": null,
                "presigned_url": null
            }
        });
    });

    // ---- play_continue ----
    fastify.post("/play_continue", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PlayContinueBody;
        const viewerId = body.viewer_id;
        console.log("[MULTI] play_continue received");

        if (!isValidMultiViewerId(viewerId)) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            });
        }

        const ctx = await context.resolvePlayerContext(viewerId);
        if (!ctx || !ctx.player) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid viewer id or no player bound."
            });
        }

        const { playerId } = ctx;

        if (activeQuests[playerId] === undefined) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "No active quest to continue."
            });
        }

        const activeData = activeQuests[playerId];
        const continueCount = runContinueActiveQuestTransaction(playerId, activeData, {
            playId: body.play_id,
            questId: body.quest_id,
            category: body.category,
        });
        if (continueCount === null) {
            return reply.status(400).send({
                "error": "Bad Request", "message": "Active quest does not match continue request."
            });
        }

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                continue_count: continueCount,
            }
        });
    });
}
