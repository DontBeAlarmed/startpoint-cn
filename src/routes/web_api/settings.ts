import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { closeAllOpenRecruitments } from "../../data/domains/attention"
import {
    getServerGameplaySettingsSync,
    updateServerGameplaySettingsSync,
} from "../../data/domains/server-settings"

interface GameplaySettingsBody {
    readonly dropMultiplier?: unknown
    readonly multiRescueFragmentRewardsEnabled?: unknown
    readonly multiRescueHostRewardsEnabled?: unknown
    readonly rush700011To700017CompatibilityEnabled?: unknown
    readonly multiRandomRecruitmentPublishEnabled?: unknown
    readonly multiNpcReleaseSeconds?: unknown
    readonly multiNpcCloseRecruitmentAfterFill?: unknown
    readonly multiNpcOneShotLifecycle?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

// 与 src/multi/room/manager.ts 的 DEFAULT_INCOMPLETE_EXPIRY_MS 同源：
// env 可变（MULTI_ROOM_INCOMPLETE_EXPIRY_MS），W 校验必须比较运行时值而非常量
function resolveRoomIncompleteExpiryMs(): number {
    const raw = Number(process.env.MULTI_ROOM_INCOMPLETE_EXPIRY_MS)
    return Number.isFinite(raw) && raw > 0 ? raw : 900_000
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/gameplay", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.status(200).send(getServerGameplaySettingsSync())
    })

    fastify.patch("/gameplay", async (request: FastifyRequest, reply: FastifyReply) => {
        // 三模式卡片一次保存多个字段：放宽为「≥1 已知字段」原子保存
        // （单条 UPDATE；未知字段仍然拒绝——保留旧契约的防拼错语义）
        if (!isPlainObject(request.body) || Object.keys(request.body).length < 1) {
            return reply.status(400).send({ error: "请求必须至少包含一个游戏设置字段" })
        }
        const body = request.body as GameplaySettingsBody
        const hasMultiplier = Object.prototype.hasOwnProperty.call(body, "dropMultiplier")
        const hasRescueSetting = Object.prototype.hasOwnProperty.call(body, "multiRescueFragmentRewardsEnabled")
        const hasHostRescueSetting = Object.prototype.hasOwnProperty.call(body, "multiRescueHostRewardsEnabled")
        const hasRushCompatibilitySetting = Object.prototype.hasOwnProperty.call(
            body,
            "rush700011To700017CompatibilityEnabled",
        )
        const hasPublishSetting = Object.prototype.hasOwnProperty.call(
            body,
            "multiRandomRecruitmentPublishEnabled",
        )
        const hasReleaseSeconds = Object.prototype.hasOwnProperty.call(body, "multiNpcReleaseSeconds")
        const hasCloseAfterFill = Object.prototype.hasOwnProperty.call(
            body,
            "multiNpcCloseRecruitmentAfterFill",
        )
        const hasOneShotLifecycle = Object.prototype.hasOwnProperty.call(body, "multiNpcOneShotLifecycle")
        const knownFields = [
            hasMultiplier, hasRescueSetting, hasHostRescueSetting, hasRushCompatibilitySetting,
            hasPublishSetting, hasReleaseSeconds, hasCloseAfterFill, hasOneShotLifecycle,
        ]
        if (!knownFields.some(hasField => hasField)
            || Object.keys(body).length > knownFields.filter(hasField => hasField).length) {
            return reply.status(400).send({ error: "未知的游戏设置字段" })
        }
        if (hasMultiplier && (!Number.isSafeInteger(body.dropMultiplier)
            || (body.dropMultiplier as number) < 1
            || (body.dropMultiplier as number) > 10)) {
            return reply.status(400).send({ error: "掉落倍率必须是 1 到 10 之间的整数" })
        }
        if (hasRescueSetting && typeof body.multiRescueFragmentRewardsEnabled !== "boolean") {
            return reply.status(400).send({ error: "多人救援碎片开关必须是布尔值" })
        }
        if (hasHostRescueSetting && typeof body.multiRescueHostRewardsEnabled !== "boolean") {
            return reply.status(400).send({ error: "房主救援碎片开关必须是布尔值" })
        }
        if (hasRushCompatibilitySetting
            && typeof body.rush700011To700017CompatibilityEnabled !== "boolean") {
            return reply.status(400).send({ error: "狂热激战常驻批次兼容开关必须是布尔值" })
        }
        if (hasPublishSetting && typeof body.multiRandomRecruitmentPublishEnabled !== "boolean") {
            return reply.status(400).send({ error: "随机招募铃铛发布开关必须是布尔值" })
        }
        if (hasReleaseSeconds) {
            const value = body.multiNpcReleaseSeconds
            if (!Number.isSafeInteger(value) || (value as number) < 0) {
                return reply.status(400).send({ error: "NPC 释放窗口必须是不少于 0 的整数秒" })
            }
            // W + margin < 房间不完整寿命（运行时 env 值，非静态常量）：
            // 否则房间先自毁、NPC 永不进场
            const expiryMs = resolveRoomIncompleteExpiryMs()
            if ((value as number) * 1000 + 60_000 > expiryMs) {
                return reply.status(400).send({
                    error: `NPC 释放窗口过长：窗口加 60 秒余量不能超过房间不完整寿命 ${Math.floor(expiryMs / 1000)} 秒`,
                })
            }
        }
        if (hasCloseAfterFill && typeof body.multiNpcCloseRecruitmentAfterFill !== "boolean") {
            return reply.status(400).send({ error: "NPC 补位后关闭招募开关必须是布尔值" })
        }
        if (hasOneShotLifecycle && typeof body.multiNpcOneShotLifecycle !== "boolean") {
            return reply.status(400).send({ error: "NPC 一场一换开关必须是布尔值" })
        }
        const current = getServerGameplaySettingsSync()
        const updated = updateServerGameplaySettingsSync({
            dropMultiplier: hasMultiplier ? body.dropMultiplier as number : current.dropMultiplier,
            multiRescueFragmentRewardsEnabled: hasRescueSetting
                ? body.multiRescueFragmentRewardsEnabled as boolean : undefined,
            multiRescueHostRewardsEnabled: hasHostRescueSetting
                ? body.multiRescueHostRewardsEnabled as boolean : undefined,
            rush700011To700017CompatibilityEnabled: hasRushCompatibilitySetting
                ? body.rush700011To700017CompatibilityEnabled as boolean : undefined,
            multiRandomRecruitmentPublishEnabled: hasPublishSetting
                ? body.multiRandomRecruitmentPublishEnabled as boolean : undefined,
            multiNpcReleaseSeconds: hasReleaseSeconds
                ? body.multiNpcReleaseSeconds as number : undefined,
            multiNpcCloseRecruitmentAfterFill: hasCloseAfterFill
                ? body.multiNpcCloseRecruitmentAfterFill as boolean : undefined,
            multiNpcOneShotLifecycle: hasOneShotLifecycle
                ? body.multiNpcOneShotLifecycle as boolean : undefined,
        })
        // 热切换规则 2：publishBell on→off 真转换时全量关闭 open 招募
        //（handler 层调用 attention 域，settings 域保持零跨域依赖；
        // 混合模式客户端重开会持续续期在途行，不扫则关铃后仍有长尾）
        if (hasPublishSetting
            && current.multiRandomRecruitmentPublishEnabled
            && !updated.multiRandomRecruitmentPublishEnabled) {
            try {
                closeAllOpenRecruitments()
            } catch (error) {
                console.warn("[SETTINGS] close all open recruitments failed", error)
            }
        }
        return reply.status(200).send(updated)
    })
}

export default routes
