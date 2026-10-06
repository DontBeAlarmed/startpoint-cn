import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import {
    deliverOpenRecruitmentsToViewer,
    parseEstablisherSnapshot,
} from "../../data/domains/attention"
import { getLocalFollowRelationSync } from "../../data/domains/follow"
import { touchPresence } from "../../multi/presence"
import { isBellDeliveryEligible } from "../../multi/bell-gate"
import { generateDataHeaders, getServerTime } from "../../utils";

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
            touchPresence(viewerId)
        } catch (error) {
            console.warn("[ATTENTION] presence touch failed (degraded)", error)
        }

        // 读时惰性投递：guest 轮询时才写入投递行（对齐官方"房主 15s 重发 × guest 轮询"）
        const nowMs = getServerTime() * 1000
        let bells: ReturnType<typeof deliverOpenRecruitmentsToViewer> = []
        try {
            // T1 投递谓词（设计 §5）：本节点房间过房间态门（未开战/房主在线/真人未满员），
            // 异节点房间放行；先过滤后下发，被滤房间的投递行已建（幂等无害）
            bells = deliverOpenRecruitmentsToViewer(viewerId, nowMs, RETURN_ATTENTION_MAX_NUM)
                .filter(recruitment => isBellDeliveryEligible(recruitment.roomNumber))
        } catch (error) {
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
                    "establisher_character_evolution_img_level": 0,
                    "establisher_follow": establisherFollow,
                    "establisher_rank": snapshot.rankLevel,
                    "host_entry_time": snapshot.hostEntryTime,
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
                    // shared early-success transformer; summon_com_seconds comes
                    // from CDN attention_config column 23.
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