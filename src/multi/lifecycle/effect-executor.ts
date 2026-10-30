// 切片 1：效果执行器 dry-run（行为不变）。
// 内核 decide() 返回的 effects 生产从不消费——外壳在各处手写等价副作用
// （站点清单见 EFFECT_INVENTORY，切片 1 调用方盘点产出）。本模块先把
// decision.effects 记账不执行：dry-run 期间外壳手写路径保持唯一执行者，
// 这里只回答"内核认为该发生什么、频率多少"；经 server/status 暴露供
// 真机比对。后续按 effect 单个切换：开关打开 → 执行器成为该 effect 的
// 唯一执行者并关闭对应手写路径，幂等键 (room, generation, effect,
// identity)，切换一个比对一次，9 个全部收口后才算"effects 生产执行完成"。
// 本模块不 import registry（registry 反向挂记录钩子，避免环）。

import { getRealNowMs } from "../../runtime/time/game-time"
import type { RoomEffect, RoomLifecycleDecision } from "./room-lifecycle"

export type RoomEffectType = RoomEffect["type"]

export interface EffectInventoryEntry {
    readonly effect: RoomEffectType
    /** 外壳当前手写等价物站点摘要（file:line，切换该 effect 时逐条核对） */
    readonly handWrittenSites: readonly string[]
    /** pending=未迁移；drying=dry-run 比对中；switched=执行器唯一执行者 */
    readonly state: "pending" | "drying" | "switched"
}

/**
 * 9 个 effect 的手写站点清单（切片 1 调用方盘点，HEAD b18a888e 基线）。
 * 切换某个 effect 前必须重核对该行站点——站点会随后续切片漂移。
 */
export const EFFECT_INVENTORY: readonly EffectInventoryEntry[] = Object.freeze([
    Object.freeze({
        effect: "sendEnterReply" as const,
        handWrittenSites: Object.freeze([
            "tcp/lobby.ts handleEnter 标准回复（host+guest 共用）",
            "tcp/lobby.ts handleEnter Welcome 早退分支（单元素 mates，内核未建模）",
        ]),
        state: "pending" as const,
    }),
    Object.freeze({
        effect: "sendDismiss" as const,
        handWrittenSites: Object.freeze([
            "state/SessionManager.ts dismissClient（唯一发送点；dismiss-only：每 socket 最后一条房间命令，禁同 tick destroy）",
            "room/manager.ts disbandRoom 正常路径 + 残留 client 守卫",
            "coordinator/embedded.ts removeOwnedRoom hardClose（有意豁免：广播后立即断）",
        ]),
        state: "pending" as const,
    }),
    Object.freeze({
        effect: "broadcastMates" as const,
        handWrittenSites: Object.freeze([
            "tcp/lobby.ts ×6 broadcastMateListToRoom（enter/离席/编队/设置等；per-client 投影）",
            "coordinator/embedded.ts node cleanup 裸广播（无 per-client 投影，切换时需对齐）",
            "tcp/lobby.ts beginBattle StartBattle 成员帧（[1,[5,...]]，与 mates 帧不同）",
            "tcp/lobby.ts EnterComs joinDelay 定时逐客户端推送（内核事件流外，不能吞）",
        ]),
        state: "pending" as const,
    }),
    Object.freeze({
        effect: "releaseSeats" as const,
        handWrittenSites: Object.freeze([
            "coordinator/embedded.ts releaseBattle（两段式：member 座位先放，battle_participants 留 state4 服务矩阵）",
            "room/manager.ts updateRoomState 4→1 过滤到房主（幂等重跑）",
            "room/manager.ts reconcileHostReturn（4→1 咽喉，清 battle_participants + mates 重置）",
        ]),
        state: "pending" as const,
    }),
    Object.freeze({
        effect: "persistBattleRelease" as const,
        handWrittenSites: Object.freeze([
            "state/SessionManager.ts battleFacts.releaseRoom/removeParticipant/markFinalized",
            "coordinator/embedded.ts releaseIfFullyFinalized（R-01 守卫：activeSessionId 必须匹配，防旧代迟到释放）",
        ]),
        state: "pending" as const,
    }),
    Object.freeze({
        effect: "updateShareRow" as const,
        handWrittenSites: Object.freeze([
            "room/share-sync.ts syncRoomShareRow（lobby ×5 / manager ×2 / embedded ×1 / one-shot ×1 触发，全 fire-and-forget）",
            "顺序约束：必须在 mates 重写之后（双审 P1：先重建 mates 后同步）",
        ]),
        state: "pending" as const,
    }),
    Object.freeze({
        effect: "closeRecruitment" as const,
        handWrittenSites: Object.freeze([
            "tcp/lobby.ts beginBattle（开战）",
            "room/disband-listener.ts（解散）+ http/room.ts HTTP 兜底（幂等重复）",
            "npc/release.ts applyNpcPostFill（内核无对应事件——执行器不能吞）",
        ]),
        state: "pending" as const,
    }),
    Object.freeze({
        effect: "scheduleGc" as const,
        handWrittenSites: Object.freeze([
            "room/manager.ts startRoomCleanup 60s 轮询 + gcSweep decision 消费（closing→disband、battleFinalized 豁免 2h）",
            "room-lifecycle-registry.ts sweepClosing（绕过 decide 的 detached 回收）",
            "外壳附加策略：2h 硬上界/15min 弃战/15-30min 老化/30s RemainingTime（内核无对应）",
        ]),
        state: "pending" as const,
    }),
    Object.freeze({
        effect: "closeRoom" as const,
        handWrittenSites: Object.freeze([
            "room/manager.ts disbandRoom 咽喉（先拆后确认：rooms.delete+dismiss 先行，registry 等 closeConfirmed/sweep 才删）",
            "room/disband-listener.ts 持久清理（释放 active quest + 删 share 行 + 关招募）",
            "幂等契约：重复解散且无 client 不发空 dismiss",
        ]),
        state: "pending" as const,
    }),
])

export interface EffectDryRunEventSample {
    readonly roomNumber: string
    readonly event: string
    readonly effects: readonly RoomEffectType[]
}

export interface EffectDryRunStatus {
    readonly mode: "dry-run"
    readonly events: number
    readonly totals: Readonly<Record<string, number>>
    readonly lastEventAtMs: number | null
    readonly lastEvent: EffectDryRunEventSample | null
}

const totals = new Map<RoomEffectType, number>()
let events = 0
let lastEventAtMs: number | null = null
let lastEvent: EffectDryRunEventSample | null = null

/**
 * registry.dispatch 在 decision 非拒绝且带 effects 时调用；只记账，不执行。
 */
export function recordEffectsDryRun(
    roomNumber: string,
    eventType: string,
    decision: RoomLifecycleDecision,
): void {
    const effectTypes = new Set<RoomEffectType>()
    for (const effect of decision.effects) {
        totals.set(effect.type, (totals.get(effect.type) ?? 0) + 1)
        effectTypes.add(effect.type)
    }
    events += 1
    lastEventAtMs = getRealNowMs()
    lastEvent = Object.freeze({
        roomNumber,
        event: eventType,
        effects: Object.freeze([...effectTypes]),
    })
}

export function getEffectDryRunStatus(): EffectDryRunStatus {
    const totalsSnapshot: Record<string, number> = {}
    for (const [effect, count] of totals) totalsSnapshot[effect] = count
    return Object.freeze({
        mode: "dry-run",
        events,
        totals: Object.freeze(totalsSnapshot),
        lastEventAtMs,
        lastEvent,
    })
}

/** 测试隔离：清空 dry-run 记账（不影响内核注册表与手写路径）。 */
export function resetEffectDryRunForTest(): void {
    totals.clear()
    events = 0
    lastEventAtMs = null
    lastEvent = null
}
