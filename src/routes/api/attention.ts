import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import {
    listUndeliveredOpenRecruitments,
    recordDeliveries,
    parseEstablisherSnapshot,
    type AttentionRecruitment,
} from "../../data/domains/attention"
import { getLocalFollowRelationSync } from "../../data/domains/follow"
import { touchPresence } from "../../multi/presence"
import { isBellDeliveryEligible } from "../../multi/bell-gate"
import { generateDataHeaders, realSecondsToVirtual } from "../../utils";
import { getRealNowMs } from "../../runtime/time/game-time";

// 与下方 config.return_attention_max_num 保持一致：单次 check 最多携带的铃铛数
const RETURN_ATTENTION_MAX_NUM = 3

interface CheckBody {
    viewer_id: number
    holding_number: number
    retry_count: number
    request_number: number
}

interface ActionBody {
    viewer_id: number
    priority_factors: string[]
    api_count: number
}

interface LoggerBody {
    viewer_id: number
    client_logs: any[]
    api_count: number
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/check", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CheckBody

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
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // 铃铛轮询即 presence 上报（原版客户端不加新请求，见 A1 计划书）。
        // 共享库模式下二者都是 SQL 写（跨进程锁竞争/磁盘错误可能抛）——
        // presence 是 advisory 数据、multi 空数组对客户端合法（ReceiveMulti([])），
        // 降级容错：任一失败不拖垮这条最热轮询端点（每在线玩家每 ~10s 一次）
        try {
            await touchPresence(viewerId)
        } catch (error) {
            console.warn("[ATTENTION] presence touch failed (degraded)", error)
        }

        // 读时惰性投递（两步契约）：guest 轮询时才取候选；投递行只对真正下发的
        // 铃铛建——提前烧行会让瞬时 T1 不合格的房间在 45s 生命期内对该 viewer
        // 永久消失（F4）。
        // 不变量：响应里的每个铃铛必须有对应投递行（deliver-once 对抗客户端
        // 无去重插槽）。所以取数与记帐一体成败——记帐失败则整个结果作废，
        // 宁可本轮空响应也不发出没记账的铃铛（否则下轮轮询重投堆叠横幅）。
        // F-06：招募行 TTL（expires_at）写侧锚真实钟，读侧必须同域——虚拟钟会恒判未过期
        const nowMs = getRealNowMs()
        let bells: AttentionRecruitment[] = []
        try {
            // T1 投递谓词（设计 §5）：本节点房间过房间态门（未开战/房主在线/真人未满员），
            // 异节点房间放行
            // 取数放大 3 倍再过滤补满：T1 被滤房间不得挤占 return_attention_max_num 名额
            bells = (await listUndeliveredOpenRecruitments(viewerId, nowMs, RETURN_ATTENTION_MAX_NUM * 3))
                .filter(recruitment => isBellDeliveryEligible(recruitment.roomNumber))
                .slice(0, RETURN_ATTENTION_MAX_NUM)
            await recordDeliveries(viewerId, bells.map(recruitment => recruitment.id))
        } catch (error) {
            bells = []
            console.warn("[ATTENTION] delivery failed (empty multi)", error)
        }
        const multi = bells.map(recruitment => {
            const snapshot = parseEstablisherSnapshot(recruitment.establisherJson)
            // establisher_follow 按查看者实时计算（关注关系变化后铃铛图标跟随）
            let establisherFollow = 0
            try {
                establisherFollow = getLocalFollowRelationSync(playerId, recruitment.hostPid).state
            } catch {
                establisherFollow = 0
            }
            return {
                "attention_key": recruitment.attentionKey,
                "quest_info": {
                    "category_id": recruitment.category,
                    "establisher_character": snapshot.character,
                    // share_room 快照已捕获房主队长真实进化等级（room.ts 实查）；
                    // 与好友大厅（lobby.ts）同款转发，硬编码 0 会让铃铛弹框头像恒为初始皮肤
                    "establisher_character_evolution_img_level": Number(snapshot.evolutionImgLevel) || 0,
                    "establisher_follow": establisherFollow,
                    "establisher_rank": snapshot.rankLevel,
                    // 快照存真实纪元秒；客户端把它喂给加算报酬时刻表判定
                    // （timeToDecideReward，虚拟时间轴），必须以虚拟域下发
                    "host_entry_time": realSecondsToVirtual(snapshot.hostEntryTime),
                    "is_newbie": recruitment.isNewbieHost,
                    "quest_id": recruitment.questId,
                    "room_number": recruitment.roomNumber,
                }
            }
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "config": {
                    "attention_recruitment_interval_seconds": 15,
                    "attention_recruitment_redeliver_limit": 20,
                    "attention_polling_interval_seconds_normal": 10,
                    "attention_polling_interval_seconds_battle": 15,
                    "multi_attention_lifetime_seconds": 30,
                    "contribution_score_rate_to_parasite": 0.25,
                    "attention_log_interval_seconds": 600,
                    "disable_finish_duration_seconds": 5,
                    "disable_decline_count_seconds": 60,
                    "disable_decline_count_limit": 14,
                    "disable_decline_duration_seconds": 30,
                    "disable_intent_disconnect_duration_seconds": 300,
                    "disable_unintent_disconnect_duration_seconds": 5,
                    "disable_remote_error_duration_seconds": 300,
                    // All 23 fields below are strictly validated by the client's
                    // shared early-success transformer (RealRemoteService: null →
                    // Option.None = CDN fallback; Int → Some = overrides CDN).
                    // summon_com_seconds here therefore controls the client's
                    // summon window directly — fully CDN-decoupled.
                    "summon_com_seconds": 20,
                    "attention_animation_time_seconds": 6,
                    "disable_expire_count_limit": 4,
                    "disable_expire_duration_seconds": 180,
                    "polling_delay_normal_seconds_range_min": 1,
                    "polling_delay_normal_seconds_range_max": 10,
                    "polling_delay_battle_seconds_range_min": 1,
                    "polling_delay_battle_seconds_range_max": 15,
                    "return_attention_max_num": 3
                },
                // 客户端强校验 multi[i]（AttentionCheckRealRemoteService）：
                // multi 缺失/为 null = 无铃铛；空数组同样安全（ReceiveMulti([])）
                "multi": multi
            }
        })
    })

    // ---- action (stub: NPC-only, no real matching) ----
    fastify.post("/action", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ActionBody
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) {
            console.log(`[ATTENTION] action: 400 invalid viewer_id=${viewerId}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            })
        }
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "priority_action_score": 0,
                "priority_playing_score": 0
            }
        })
    })

    // ---- logger (stub: NPC-only, discard logs) ----
    fastify.post("/logger", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LoggerBody
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) {
            console.log(`[ATTENTION] logger: 400 invalid viewer_id=${viewerId}`)
            return reply.status(400).send({
                "error": "Bad Request", "message": "Invalid request body."
            })
        }
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        })
    })
}

export default routes;