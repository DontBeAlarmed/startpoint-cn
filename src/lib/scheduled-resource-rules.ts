import type { ScheduledResourceRuleInput } from "../data/domains/scheduled-resource"

export interface ScheduledResourceRuleAuthority {
    readonly itemMaxCounts: Readonly<Record<string, number>>
    readonly maxFreeVmoney: number
    readonly playerExists: (playerId: number) => boolean
}

export type ScheduledResourceRuleValidationResult =
    | { readonly ok: true; readonly value: ScheduledResourceRuleInput }
    | { readonly ok: false; readonly error: string }

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isValidDate(value: unknown): value is Date {
    return value instanceof Date && Number.isFinite(value.getTime())
}

function invalid(error: string): ScheduledResourceRuleValidationResult {
    return { ok: false, error }
}

export function validateScheduledResourceRuleInput(
    input: ScheduledResourceRuleInput,
    authority: ScheduledResourceRuleAuthority,
): ScheduledResourceRuleValidationResult {
    if (input.scope !== "global" && input.scope !== "player") {
        return invalid("规则范围无效")
    }
    if (input.scope === "global" && input.playerId !== null) {
        return invalid("全局规则不能指定存档")
    }
    if (input.scope === "player") {
        if (!isPositiveSafeInteger(input.playerId)) return invalid("指定存档 ID 无效")
        if (!authority.playerExists(input.playerId)) {
            return invalid(`存档 ${input.playerId} 不存在`)
        }
    }

    if (input.rewardType !== "item" && input.rewardType !== "free_vmoney") {
        return invalid("奖励类型只允许道具或免费星导石")
    }
    if (!isPositiveSafeInteger(input.grantAmount)) return invalid("发放数量必须是正整数")
    if (!isNonNegativeSafeInteger(input.triggerThreshold)) {
        return invalid("触发下限必须是非负整数")
    }
    if (!isPositiveSafeInteger(input.inventoryCap)) return invalid("持有上限必须是正整数")
    if (!Number.isSafeInteger(input.triggerThreshold + input.grantAmount)
        || input.triggerThreshold + input.grantAmount >= input.inventoryCap) {
        return invalid("触发下限与发放数量之和必须小于持有上限")
    }

    if (input.rewardType === "item") {
        if (!isPositiveSafeInteger(input.rewardId)) return invalid("道具 ID 无效")
        const officialMax = authority.itemMaxCounts[String(input.rewardId)]
        if (!isPositiveSafeInteger(officialMax)) return invalid(`道具 ID ${input.rewardId} 不存在`)
        if (input.inventoryCap > officialMax) {
            return invalid(`持有上限不能超过道具官方上限 ${officialMax}`)
        }
    } else {
        if (input.rewardId !== null) return invalid("免费星导石不填写道具 ID")
        if (!isPositiveSafeInteger(authority.maxFreeVmoney)) {
            return invalid("免费星导石官方上限无效")
        }
        if (input.inventoryCap > authority.maxFreeVmoney) {
            return invalid(`持有上限不能超过免费星导石官方上限 ${authority.maxFreeVmoney}`)
        }
    }

    if (typeof input.enabled !== "boolean") return invalid("启用状态无效")
    if (input.startsAtReal !== null && !isValidDate(input.startsAtReal)) {
        return invalid("开始时间无效")
    }
    if (input.endsAtReal !== null && !isValidDate(input.endsAtReal)) {
        return invalid("结束时间无效")
    }
    if (input.startsAtReal !== null && input.endsAtReal !== null
        && input.endsAtReal.getTime() <= input.startsAtReal.getTime()) {
        return invalid("结束时间必须晚于开始时间")
    }
    if (input.description !== null && typeof input.description !== "string") {
        return invalid("备注无效")
    }

    return {
        ok: true,
        value: {
            scope: input.scope,
            playerId: input.playerId,
            rewardType: input.rewardType,
            rewardId: input.rewardId,
            grantAmount: input.grantAmount,
            triggerThreshold: input.triggerThreshold,
            inventoryCap: input.inventoryCap,
            enabled: input.enabled,
            startsAtReal: input.startsAtReal === null ? null : new Date(input.startsAtReal),
            endsAtReal: input.endsAtReal === null ? null : new Date(input.endsAtReal),
            description: input.description?.trim() || null,
        },
    }
}
