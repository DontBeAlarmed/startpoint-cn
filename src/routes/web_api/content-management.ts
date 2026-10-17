import path from "node:path"

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { runContentSync, type ContentSyncResult } from "../../content/sync/engine"
import { sanitizeErrorMessage } from "../../content/sync/cli"
import { resetMediumArchiveIndexes } from "../../content/cdn/medium-archive-index"
import {
    getContentSnapshot,
    reloadContentSnapshot,

} from "../../content/runtime/content-snapshot"
import { ContentSmokeValidationError, runContentSmokeValidators } from "../../lib/content-smoke"

/**
 * 内容管理（管理后台）：线上内容热更新。
 *
 * 「应用内容更新」= content:sync 前置 check（秒级扫描 + digest 比对，不取锁
 * 不重建）→ 磁盘已是最新则直接返回不动作；有待应用更新才进 force 全量重建
 * （读 .cdn/patches/<版本>）→ 成功后 reloadContentSnapshot()（原子换运行时
 * 快照）。任何一步失败保留旧快照继续服务（fail-safe），返回结构化结果供
 * 前端展示；磁盘上 current 可能已翻转（重启将生效新版本），失败响应会明示。
 * /state 附带同一 check 的待应用状态（pending），前端据此置灰无更新时的按钮。
 *
 * gameCalendarUtcOffsetMinutes 由服务端启动锁定的 runtimeConfig 注入——
 * 不得端点内自行 parse env（服务进程不加载 .env，错误日历的 release 重启
 * 即启动失败）。
 *
 * 鉴权姿态：与全部管理 API 一致，应用层不做身份校验，由部署层承担——
 * 本端点必须经带认证的反代暴露，禁止直接对公网开放。
 */

export interface ContentManagementRoutesOptions {
    /** 服务端启动锁定的日历偏移（cn-server 惰性透传 runtimeConfig）。 */
    readonly getGameCalendarUtcOffsetMinutes: () => number
    readonly projectRoot?: string
    /** 测试注入点。 */
    readonly runSync?: (options: Parameters<typeof runContentSync>[0]) => Promise<ContentSyncResult>
    readonly reload?: typeof reloadContentSnapshot
    /** apply 成功且资产版本推进后的回调（cn-server 接线 TCP AssetUpdate 广播）；抛错不得影响 apply 结果。 */
    readonly onContentApplied?: (previousVersion: string, currentVersion: string) => void
}

interface ApplyOutcome {
    applied: boolean
    stage?: "sync" | "reload"
    previousVersion?: string
    currentVersion: string
    releaseDigest?: string
    note?: string
    /** applied=false 且因磁盘无新内容跳过（前置 check 判定 up-to-date）。 */
    upToDate?: boolean
}

interface PendingContentCheck {
    /** 磁盘待应用内容的版本（check 扫描结果）。 */
    diskVersion: string
    reason: string
    upToDate: boolean
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

async function runPendingContentCheck(
    projectRoot: string,
    gameCalendarUtcOffsetMinutes: number,
    runSync: (options: Parameters<typeof runContentSync>[0]) => Promise<ContentSyncResult>,
): Promise<PendingContentCheck | null> {
    try {
        const check = await runSync({
            projectRoot,
            env: process.env,
            mode: "check",
            gameCalendarUtcOffsetMinutes,
        })
        return {
            diskVersion: check.targetVersion,
            reason: check.reason,
            upToDate: check.reason === "up-to-date",
        }
    } catch {
        // check 不可用（磁盘异常等）时状态未知：返回 null，前端不置灰，
        // 由 apply 的权威前置 check 兜底
        return null
    }
}

async function performApply(
    projectRoot: string,
    gameCalendarUtcOffsetMinutes: number,
    runSync: (options: Parameters<typeof runContentSync>[0]) => Promise<ContentSyncResult>,
    reload: typeof reloadContentSnapshot,
): Promise<ApplyOutcome> {
    const before = currentContentState()
    try {
        // 前置 check（秒级扫描 + digest 比对，不取锁不重建）：磁盘已是最新
        // 则不进 force——避免无变化时的全量重建与 reload 停顿。check 失败
        // 视为同步失败（force 依赖同一扫描/读取，失败原因一致）。
        const pending = await runSync({
            projectRoot,
            env: process.env,
            mode: "check",
            gameCalendarUtcOffsetMinutes,
        })
        if (pending.reason === "up-to-date") {
            return {
                applied: false,
                upToDate: true,
                currentVersion: before.targetVersion,
                note: "磁盘内容已是最新，未执行重建与热重载",
            }
        }
    } catch (error) {
        return {
            applied: false,
            stage: "sync",
            currentVersion: before.targetVersion,
            note: `内容同步失败：旧内容继续服务（${sanitizeErrorMessage(error instanceof Error ? error.message : String(error), projectRoot)}）`,
        }
    }

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
            note: `内容同步失败：旧内容继续服务（${sanitizeErrorMessage(error instanceof Error ? error.message : String(error), projectRoot)}）`,
        }
    }

    try {
        // R-04 目录级预检：候选快照在替换运行时前先过冒烟校验，坏内容不上线
        await reload({ validate: snapshot => runContentSmokeValidators(snapshot.repository) })
    } catch (error) {
        if (error instanceof ContentSmokeValidationError) {
            return {
                applied: false,
                stage: "reload",
                currentVersion: before.targetVersion,
                note: `目录级预检未通过，坏内容未上线（旧快照继续服务：${sanitizeErrorMessage(error.message, projectRoot)}）；磁盘已更新，重启将生效新版本——请修正或撤除补丁包后重试`,
            }
        }
        return {
            applied: false,
            stage: "reload",
            currentVersion: before.targetVersion,
            note: `内容重载失败：旧快照继续服务（${sanitizeErrorMessage(error instanceof Error ? error.message : String(error), projectRoot)}）；磁盘已更新，重启将生效新版本`,
        }
    }

    // reload 成功：失效 admin 立绘/头像的目录索引缓存（新补丁的归档才能被看到）
    resetMediumArchiveIndexes()

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
        const pending = await runPendingContentCheck(
            projectRoot,
            gameCalendarUtcOffsetMinutes,
            runSync,
        )
        return reply.status(200).send({
            targetVersion: state.targetVersion,
            contentDigest: state.contentDigest,
            appliedAt: lastAppliedAt,
            busy: applyInFlight !== null,
            pending,
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
                // 资产版本确实推进才通知客户端（版本未变的 apply 对客户端不可见）；
                // 通知失败只降级为日志，不回滚 apply 结果
                if (
                    options.onContentApplied
                    && outcome.previousVersion !== undefined
                    && outcome.previousVersion !== outcome.currentVersion
                ) {
                    try {
                        options.onContentApplied(outcome.previousVersion, outcome.currentVersion)
                    } catch (error) {
                        _request.log.warn({ err: error }, "content apply notification failed")
                    }
                }
            }
            return reply.status(200).send({ data: outcome })
        } catch (error) {
            // performApply 内部已全兜；此 catch 防御注入依赖的意外抛错
            // （消息同样经脱敏——与主路径同一卫生约定）
            return reply.status(200).send({
                data: {
                    applied: false,
                    stage: "sync" as const,
                    currentVersion: currentContentState().targetVersion,
                    note: `内容更新失败（${sanitizeErrorMessage(error instanceof Error ? error.message : String(error), projectRoot)}）`,
                },
            })
        } finally {
            applyInFlight = null
        }
    })
}
