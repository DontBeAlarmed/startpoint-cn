// 切片 1 第③步：效果执行器（applyEffects）。
// registry.dispatch 在非拒绝且带 effects 的 decision 上调用本模块；每个
// effect 按 MULTI_EFFECT_SWITCHES 开关逐个启用——启用的 effect 在这里唯一
// 执行（外壳对应手写路径同时关闭，回退=摘掉环境变量重启）；未启用的
// effect 仍处 dry-run（外壳手写路径继续负责）。执行计数经 effect-executor
// 的 appliedTotals 与内核 totals 对账。
// 依赖纪律：本模块不得 import room-lifecycle-registry（registry 反向调
// applyEffects，会成环）；内核发射点没有对应物的外壳行为（NPC post-fill
// 关招募、RemainingTime 广播、EnterComs 定时推送、hardClose 即断）不在此
// 消化，外壳原样保留。

import { closeRecruitmentForRoom } from "../../data/domains/attention"
import { describeError } from "../describe-error"
import {
    isEffectSwitched,
    recordEffectApplied,
    type RoomEffectType,
} from "./effect-executor"
import type { RoomLifecycleDecision } from "./room-lifecycle"

export interface ApplyEffectsDependencies {
    closeRecruitment?: (hostViewerId: number, roomNumber: string) => Promise<void>
}

const dependencies: ApplyEffectsDependencies = {}

/** 测试注入口；生产用默认依赖。 */
export function setApplyEffectsDependenciesForTest(overrides: ApplyEffectsDependencies): void {
    dependencies.closeRecruitment = overrides.closeRecruitment
}

function viewerIdFromIdentity(identity: string): number | null {
    if (!identity.startsWith("viewer:")) return null
    const viewerId = Number(identity.slice("viewer:".length))
    return Number.isSafeInteger(viewerId) && viewerId > 0 ? viewerId : null
}

export function applyEffects(roomNumber: string, eventType: string, decision: RoomLifecycleDecision): void {
    for (const effect of decision.effects) {
        switch (effect.type) {
            case "closeRecruitment": {
                if (!isEffectSwitched("closeRecruitment")) break
                const hostViewerId = viewerIdFromIdentity(decision.state.host)
                if (hostViewerId === null) break
                recordEffectApplied("closeRecruitment")
                const close = dependencies.closeRecruitment ?? closeRecruitmentForRoom
                // W1a：异步形状——fire-and-forget，拒绝就地捕获
                void close(hostViewerId, roomNumber).catch(error => {
                    console.warn(`[MULTI] effect closeRecruitment failed: room=${roomNumber}`
                        + ` event=${eventType}: ${describeError(error)}`)
                })
                break
            }
            default:
                // 其余 effect 尚未切换：dry-run（外壳手写路径负责）。
                break
        }
    }
}
