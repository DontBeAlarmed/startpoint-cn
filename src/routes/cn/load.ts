import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, getServerTime, getServerDate } from "../../utils";
import { getPlayerSync, dailyResetPlayerDataSync, collectPlayerDataPooledExpSync, updatePlayerSync } from "../../data/wdfpData";
import { getClientSerializedData } from "../../data/utils";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { getDisplayHost } from "../../data/multiRoom";

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

function wrapOptionFields(d: any, resVer?: string) {
    // Align with CN CDN version from client res_ver header, fallback to .env CN_RES_VERSION
    d.available_asset_version = resVer || process.env.CN_RES_VERSION || "1.4.54";

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
    d.favorite_party_group_list = [];
    d.ranking_event_reward = [];
    d.party_list = [];

    d.payment_rebate_info = { expired_time: 0, status: 0, start_time: 0 };
    d.monthly_charge_bonus_info = { bonus_days: 0, expired_time: 0, init_time: 0, status: 0, start_time: 0 };
    d.comeback_campaign_boss_boost = { period_start_time: 0, period_end_time: 0 };

    return d;
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/load", async (request: FastifyRequest, reply: FastifyReply) => {
        try {
        const body = request.body as CnLoadBody;
        const accountId = body.viewer_id || body.keychain || 1;

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

        // 若自定义时间与 lastLogin 不同步，强制对齐（防止客户端弹"日期变了"）
        if (now.toDateString() !== player.lastLoginTime.toDateString()) {
            updatePlayerSync({ id: player.id, lastLoginTime: now });
        }

        const clientData = getClientSerializedData(playerId, { viewerId: accountId }) as any;
        if (clientData === null) {
            return reply.status(500).send({ error: "Internal Server Error", message: "No player data." });
        }

        const resVer = request.headers['res_ver'] as string | undefined;
        console.log(`[CN-LOAD] res_ver=${resVer || '(not sent)'} account=${accountId} player=${playerId} party_slot=${clientData?.user_info?.party_slot}`);
        wrapOptionFields(clientData, resVer);

        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders({
                asset_update: true,
                viewer_id: accountId,
                servertime: getServerTime(),
            }),
            data: clientData
        });
        } catch(e: any) {
            console.error(`[CN-LOAD] ERROR:`, e.message, e.stack);
            return reply.status(500).send({ error: "Internal Server Error", message: e.message });
        }
    });
};

export default routes;
