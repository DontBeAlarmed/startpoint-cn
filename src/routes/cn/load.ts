import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";
import { generateDataHeaders, getServerTime, getServerDate } from "../../utils";
import { collectPlayerDataPooledExpSync, dailyResetPlayerDataSync, getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import {
    getPlayerActiveQuestSync,
    updatePlayerActiveQuestCoordinatorOriginSync,
    updatePlayerActiveQuestEntryItemCountSync,
} from "../../data/domains/quest_active"
import { getSession } from "../../data/domains/session"
import { getClientSerializedData } from "../../data/utils";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getDisplayHost } from "../../multi/room/serializer";
import { getRoom } from "../../multi/room/manager";
import { runPermanentValidators } from "../../lib/validate";
import { restoreActiveQuestFromStorage } from "../../lib/quest/entry-lifecycle";
import { ActiveQuest, publishActiveQuest, runAbortActiveQuestTransaction } from "../../lib/quest/active-quest-service";
import type { StartEntryCost } from "../../lib/quest/start-entry";
import { getContentSnapshot } from "../../content/runtime/content-snapshot";
import {
    parseAssetProviderConfig,
    resolveAssetLoadState,
    type AssetProviderConfig,
} from "../../content/cdn/asset-mode";
import bundledQuestEntryCosts from "../../../assets/quest_entry_costs.json";
import { getRuntimeContentTableSync } from "../../content/runtime/table-access";
import { reconcileActiveMissionFacts } from "../../lib/mission/active-reconciliation";
import { recordEventLoginMissionFactSync } from "../../lib/mission/event-entry-facts";
import { setCnMsgpackPendingCommit } from "./msgpack";
import {
    isValidBattleSessionId,
    isValidMultiRoomNumber,
    type MultiCoordinatorOrigin,
    type ParticipantIdentity,
} from "../../multi/coordinator/contracts";
import type {
    MultiBattleRecoveryInspection,
    MultiSettlementIdentity,
} from "../../multi/settlement/verifier";

interface CnLoadBody {
    device_id: number;
    device_token: string;
    keychain: number;
    graphics_device_name: string;
    platform_os_version: string;
    storage_directory_path: string;
    oaid?: string;
    imei?: string;
    mac?: string;
    advertise_id?: string;
    viewer_id?: number;
}

function wrapOptionFields(d: any, availableAssetVersion: string) {
    d.available_asset_version = availableAssetVersion;

    if (d.user_info) {
        if (typeof d.user_info.last_login_time === 'number') {
            const dt = new Date(d.user_info.last_login_time * 1000);
            const p = (n: number) => n.toString().padStart(2, '0');
            d.user_info.last_login_time = `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
        }
        d.user_info.is_bought_fund_ex_quest ??= false;
        d.user_info.is_bought_fund_main_quest ??= false;
        d.user_info.is_bought_fund_laite ??= false;
        d.user_info.is_bought_fund_laite2 ??= false;
        d.user_info.is_bought_fund_laite3 ??= false;
        d.user_info.is_newbie ??= true;
        d.user_info.is_comeback ??= false;
        d.user_info.month_card_remain_days ??= 0;
        d.user_info.weekly_bonus_remain_days ??= 0;
        d.user_info.monthly_payment_total ??= 0;
        d.user_info.renewal_gift_remain_days ??= 0;
    }

    if (d.user_option) {
        d.user_option.episode_encyclopedia_suggest_show ??= false;
        d.user_option.server_push ??= false;
        d.user_option.stamina ??= false;
    }

    d.cn_crash_url = `http://${getDisplayHost()}:${process.env.CN_LISTEN_PORT || "8001"}/crash`;
    d.survey_url = "";
    d.qq_group_url = "";
    d.bug_report_url = "";
    d.enable_gift = false;
    d.enable_customer_service = false;
    d.enable_rename = true;
    d.enable_delete_file = false;
    d.enable_newbie = false;
    d.enable_little_assistant = false;
    d.mission_tips = false;
    d.monthly_tip = false;
    d.simple_payment_item_list = [];
    d.ex_boost_draw_result = null;
    d.pass_force_reward = false;
    d.crazy_gacha_result_list = [];
    d.last_crazy_gacha_draw_result = [];
    d.fund_receive_list = [];
    d.login_info = {};
    d.tower_dungeon_list = [];
    d.special_exchange_campaign_list = [];
    d.win_lottery_active_mission_list = [];
    d.stars_gacha_campaign_list = [];
    // Build favorite_party_group_list from user_party_group_list
    // Required for HomeScene kind=1 (profile_favorite) to work without F1010
    // fromPartyInfo expects party_name/party_edited (not name/edited like fromPartyInfoLite)
    d.favorite_party_group_list = Object.entries(d.user_party_group_list || {}).map(([groupId, group]: [string, any]) => ({
        party_group_id: Number(groupId),
        party_group_color_id: group.color_id,
        party_list: Object.entries(group.list || {}).map(([partyId, party]: [string, any]) => ({
            party_id: Number(partyId),
            party_name: party.name,
            character_ids: party.character_ids,
            unison_character_ids: party.unison_character_ids,
            equipment_ids: party.equipment_ids,
            ability_soul_ids: party.ability_soul_ids,
            options: party.options,
            party_edited: party.edited,
            current_battle_power: party.current_battle_power,
            before_battle_power: party.before_battle_power,
        }))
    }));

    d.ranking_event_reward = [];
    d.party_list = [];

    d.payment_rebate_info = { expired_time: 0, status: 0, start_time: 0 };
    d.monthly_charge_bonus_info = { bonus_days: 0, expired_time: 0, init_time: 0, status: 0, start_time: 0 };
    d.comeback_campaign_boss_boost = { period_start_time: 0, period_end_time: 0 };

    return d;
}

export interface CnLoadRouteOptions {
    readonly assetProvider?: AssetProviderConfig;
    readonly multiMode?: "embedded" | "host" | "client";
    readonly multiRecoveryVerifier?: {
        inspect(input: MultiSettlementIdentity): Promise<MultiBattleRecoveryInspection>;
    };
    readonly getMultiParticipant?: (viewerId: number) => ParticipantIdentity;
}

function hasStoredBattleIdentity(activeQuest: ActiveQuest): boolean {
    return activeQuest.isMulti && activeQuest.battleSessionId !== null
        && activeQuest.battleSessionId !== undefined;
}

function isValidStoredBattleIdentity(activeQuest: ActiveQuest): activeQuest is ActiveQuest & {
    roomNumber: string;
    battleSessionId: string;
} {
    return isValidMultiRoomNumber(activeQuest.roomNumber)
        && isValidBattleSessionId(activeQuest.battleSessionId);
}

function fallbackParticipant(
    mode: CnLoadRouteOptions["multiMode"],
    viewerId: number,
): ParticipantIdentity {
    return {
        nodeSessionId: mode === "client" ? "remote-pending" as any : "embedded" as any,
        viewerId,
    };
}

function inferLegacyCoordinatorOrigin(
    mode: CnLoadRouteOptions["multiMode"],
): MultiCoordinatorOrigin {
    return mode === "client" ? "remote" : "local";
}

const routes = async (fastify: FastifyInstance, options: CnLoadRouteOptions) => {
    const assetProvider = options.assetProvider ?? parseAssetProviderConfig({
        projectRoot: path.resolve(__dirname, "../../.."),
    });

    fastify.post("/load", async (request: FastifyRequest, reply: FastifyReply) => {
        try {
        const body = request.body as CnLoadBody;
        const viewerId = body.viewer_id || body.keychain || 1;

        const session = await getSession(String(viewerId));
        const accountId = session ? session.accountId : (body.viewer_id || body.keychain || 1);
        const playerId = resolvePlayerIdSync(accountId);
        if (!playerId) {
            return reply.status(400).send({ error: "Bad Request", message: "No player found" });
        }

        const player = getPlayerSync(playerId);
        if (player === null) {
            return reply.status(500).send({ error: "Internal Server Error", message: "No player data." });
        }

        const now = getServerDate();
        dailyResetPlayerDataSync(player, now);
        collectPlayerDataPooledExpSync(player, now);

        // Run save validators (permanent fixes: max_level, etc.)
        runPermanentValidators(playerId);

        // 若自定义时间与 lastLogin 不同步，强制对齐（防止客户端弹"日期变了"）
        if (now.toDateString() !== player.lastLoginTime.toDateString()) {
            updatePlayerSync({ id: player.id, lastLoginTime: now });
        }

        let activeQuest: ActiveQuest | null = getPlayerActiveQuestSync(playerId);
        if (activeQuest) {
            if (activeQuest.isMulti && activeQuest.coordinatorOrigin === null) {
                const coordinatorOrigin = inferLegacyCoordinatorOrigin(options.multiMode);
                updatePlayerActiveQuestCoordinatorOriginSync(playerId, coordinatorOrigin);
                activeQuest = { ...activeQuest, coordinatorOrigin };
            }
            let authoritativeMissing = false;
            if (hasStoredBattleIdentity(activeQuest)) {
                if (!isValidStoredBattleIdentity(activeQuest)) {
                    console.warn("[CN-LOAD] multi recovery skipped code=MULTI_RECOVERY_INVALID_IDENTITY");
                } else if (options.multiRecoveryVerifier) {
                    const participant = options.getMultiParticipant?.(viewerId)
                        ?? fallbackParticipant(options.multiMode, viewerId);
                    const recovery = await options.multiRecoveryVerifier.inspect({
                        ...participant,
                        roomNumber: activeQuest.roomNumber,
                        battleSessionId: activeQuest.battleSessionId,
                        coordinatorOrigin: activeQuest.coordinatorOrigin as MultiCoordinatorOrigin,
                    });
                    authoritativeMissing = recovery.state === "missing";
                }
            }
            const legacyRoomMissing = activeQuest.coordinatorOrigin === "local"
                && !hasStoredBattleIdentity(activeQuest)
                && !!activeQuest.roomNumber
                && getRoom(activeQuest.roomNumber) === undefined;
            if (authoritativeMissing || legacyRoomMissing) {
                console.log(`[CN-LOAD] active quest room ${activeQuest.roomNumber} not found, cancelling`);
                const aborted = runAbortActiveQuestTransaction(playerId, {
                    playId: activeQuest.playId,
                    questId: activeQuest.questId,
                    category: activeQuest.category,
                });
                activeQuest = aborted.cancelled ? null : getPlayerActiveQuestSync(playerId);
            }
            if (activeQuest) {
                activeQuest = restoreActiveQuestFromStorage(playerId, activeQuest, {
                    getEntryCost: (category, questId) => (
                        getRuntimeContentTableSync(
                            "quest_entry_costs.json",
                            bundledQuestEntryCosts as Record<string, StartEntryCost>,
                        )
                    )[`${category}_${questId}`],
                    persistEntryItemCount: updatePlayerActiveQuestEntryItemCountSync,
                    publishActiveQuest,
                });
            }
        }

        const contentSnapshot = getContentSnapshot();
        reconcileActiveMissionFacts({
            playerId,
            repository: contentSnapshot.repository,
            now: getServerTime() * 1000,
        });

        const responsePayload = (() => {
            const clientData = getClientSerializedData(playerId, { viewerId: accountId }) as any;
            if (clientData === null) throw new Error("No player data.");

            const resVer = request.headers['res_ver'] as string | undefined;
            console.log(`[CN-LOAD] res_ver=${resVer || '(not sent)'} account=${accountId} player=${playerId} party_slot=${clientData?.user_info?.party_slot}`);
            const snapshotTargetVersion = assetProvider.mode === "client-owned"
                ? ""
                : contentSnapshot.cdn.targetVersion;
            const assetState = resolveAssetLoadState(assetProvider, resVer, snapshotTargetVersion);
            wrapOptionFields(clientData, assetState.availableAssetVersion);

            // Inject unfinished quest lists for battle recovery
            if (activeQuest) {
                const entry = { play_id: activeQuest.playId, continue_count: activeQuest.continueCount };
                if (activeQuest.isMulti) {
                    clientData.unfinished_quest_list = [];
                    clientData.unfinished_multi_quest_list = [entry];
                } else {
                    clientData.unfinished_quest_list = [entry];
                    clientData.unfinished_multi_quest_list = [];
                }
            } else {
                clientData.unfinished_quest_list = [];
                clientData.unfinished_multi_quest_list = [];
            }

            const payload = {
                data_headers: generateDataHeaders({
                    asset_update: assetState.assetUpdate,
                    viewer_id: accountId,
                    servertime: getServerTime(),
                }),
                data: clientData
            };
            return payload;
        })();

        reply.header("content-type", "application/x-msgpack");
        setCnMsgpackPendingCommit(reply, () => {
            recordEventLoginMissionFactSync(playerId, now);
        });
        reply.status(200).send(responsePayload);
        } catch(e: any) {
            console.error(`[CN-LOAD] ERROR:`, e.message, e.stack);
            return reply.status(500).send({ error: "Internal Server Error", message: e.message });
        }
    });
};

export default routes;
