import { getCurrencyCapacityPolicySync } from "../config-content"

// 官方每日抽卡上限（config_iosbundled 真值对齐 2026-10-26）：
// 单抽每日 99 次、十连每日 99 次、疯狂十连每日 50 次。计数按池、上限全局。
export interface GachaDailyLimits {
    readonly maxOnePerDay: number
    readonly maxTenPerDay: number
}

export function getGachaCurrencyCapacityLimits(): GachaDailyLimits {
    const policy = getCurrencyCapacityPolicySync()
    return Object.freeze({
        maxOnePerDay: policy.gachaOneMaxCount,
        maxTenPerDay: policy.gachaTenMaxCount,
    })
}
