import path from "node:path"

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { runContentSync, type ContentSyncResult } from "../../content/sync/engine"
import {
    getContentSnapshot,
    reloadContentSnapshot,
} from "../../content/runtime/content-snapshot"

/**
 * 内容管理（管理后台）：线上内容热更新。
 *
 * 「应用内容更新」= content:sync（force，读 .cdn/patches/<版本>）→ 成功后
 * reloadContentSnapshot()（原子换运行时快照）。任何一步失败保留旧快照继续
 * 服务（fail-safe），返回结构化结果供前端展示；磁盘上 current 可能已翻转
 * （重启将生效新版本），失败响应会明示。
 *
 * gameCalendarUtcOffsetMinutes 由服务端启动锁定的 runtimeConfig 注入——
 * 不得端点内自行 parse env（服务进程不加载 .env，错误日历的 release 重启
 * 即启动失败）。
 */

export interface ContentManagementRoutesOptions {
    /** 服务端启动锁定的日历偏移（cn-server 惰性透传 runtimeConfig）。 */
    readonly getGameCalendarUtcOffsetMinutes: () => number
    readonly projectRoot?: string
    /** 测试注入点。 */
    readonly runSync?: (options: Parameters<typeof runContentSync>[0]) => Promise<ContentSyncResult>
    readonly reload?: typeof reloadContentSnapshot
}

interface ApplyOutcome {
    applied: boolean
    stage?: "sync" | "reload"
    previousVersion?: string
    currentVersion: string
    releaseDigest?: string
    note?: string
}

let applyInFlight: Promise<ApplyOutcome> | null = null
let lastAppliedAt: string | null = null

function currentContentState() {
    const snapshot = getContentSnapshot()
    return {
        targetVersion: snapshot.cdn.targetVersion,
        // 旧版内容仓库可能没有 multiBattleContentDigest（bundled fixture 等）
        contentDigest: snapshot.repository.info().multiBattleContentDigest ?? null,
    }
}

async function performApply(
    projectRoot: string,
    gameCalendarUtcOffsetMinutes: number,
    runSync: (options: Parameters<typeof runContentSync>[0]) => Promise<ContentSyncResult>,
    reload: typeof reloadContentSnapshot,
): Promise<ApplyOutcome> {
    const before = currentContentState()
    let syncResult: ContentSyncResult
    try {
        // sync 失败（含 lock 超时）以异常呈现：旧内容继续服务
        syncResult = await runSync({
            projectRoot,
            env: process.env,
            mode: "force",
            gameCalendarUtcOffsetMinutes,
        })
    } catch (error) {
        return {
            applied: false,
            stage: "sync",
            currentVersion: before.targetVersion,
            note: `内容同步失败：旧内容继续服务（${error instanceof Error ? error.message : String(error)}）`,
        }
    }

    try {
        await reload()
    } catch (error) {
        return {
            applied: false,
            stage: "reload",
            currentVersion: before.targetVersion,
            note: `内容重载失败：旧快照继续服务（${error instanceof Error ? error.message : String(error)}）；磁盘已更新，重启将生效新版本`,
        }
    }

    const after = currentContentState()
    return {
        applied: true,
        previousVersion: before.targetVersion,
        currentVersion: after.targetVersion,
        releaseDigest: syncResult.releaseDigest,
    }
}

export function registerContentManagementRoutes(
    fastify: FastifyInstance,
    options: ContentManagementRoutesOptions,
): void {
    const runSync = options.runSync ?? runContentSync
    const reload = options.reload ?? reloadContentSnapshot
    const projectRoot = path.resolve(options.projectRoot ?? __dirname, "../../..")
    const gameCalendarUtcOffsetMinutes = options.getGameCalendarUtcOffsetMinutes()

    fastify.get("/state", async (_request: FastifyRequest, reply: FastifyReply) => {
        const state = currentContentState()
        return reply.status(200).send({
            targetVersion: state.targetVersion,
            contentDigest: state.contentDigest,
            appliedAt: lastAppliedAt,
            busy: applyInFlight !== null,
        })
    })

    fastify.post("/apply", async (_request: FastifyRequest, reply: FastifyReply) => {
        if (applyInFlight !== null) {
            return reply.status(409).send({
                error: "内容更新正在进行中",
                code: "APPLY_IN_PROGRESS",
                message: "请等待当前任务完成后再试",
            })
        }
        applyInFlight = performApply(
            projectRoot,
            gameCalendarUtcOffsetMinutes,
            runSync,
            reload,
        )
        try {
            const outcome = await applyInFlight
            if (outcome.applied) {
                lastAppliedAt = new Date().toISOString()
            }
            return reply.status(200).send({ data: outcome })
        } catch (error) {
            // performApply 内部已全兜；此 catch 防御注入依赖的意外抛错
            return reply.status(200).send({
                data: {
                    applied: false,
                    stage: "sync" as const,
                    currentVersion: currentContentState().targetVersion,
                    note: error instanceof Error ? error.message : String(error),
                },
            })
        } finally {
            applyInFlight = null
        }
    })
}
