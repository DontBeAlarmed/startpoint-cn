import { GIFT_REWARD_TYPES, type GiftProtocolType, type GiftReward } from "./types"

/**
 * 礼包奖励的名称解析与 chip 文案（列表「奖励」列 + 编辑器奖励行共用）。
 * 名称按类型用 /api/lookup 只读接口解析（与邮件/玩家详情同源），纯展示层。
 */

export interface GiftRewardLookups {
    items: Record<string, string>
    characters: Record<string, { readonly name: string; readonly title: string }>
    equipment: Record<string, { readonly name: string }>
}

export const GIFT_TYPE_LABELS: Record<number, string> = Object.fromEntries(
    GIFT_REWARD_TYPES.map(({ value, label }) => [value, label]),
)

export function giftRewardObjectName(
    reward: Pick<GiftReward, "type" | "typeId">,
    lookups: GiftRewardLookups,
): string | null {
    if (reward.typeId === null) return null
    const key = String(reward.typeId)
    if (reward.type === 1) return lookups.items[key] ?? null
    if (reward.type === 5) return lookups.characters[key]?.name ?? null
    if (reward.type === 6) return lookups.equipment[key]?.name ?? null
    return null
}

/** 单条奖励的 chip 文案：类型·对象名 ×数量（对象未解析到时回退 #ID）。 */
export function giftRewardChipText(
    reward: Pick<GiftReward, "type" | "typeId" | "number">,
    lookups: GiftRewardLookups,
): string {
    const label = GIFT_TYPE_LABELS[reward.type] ?? `类型${reward.type}`
    const name = giftRewardObjectName(reward, lookups)
    const objectText = name ?? (reward.typeId === null ? "" : `#${reward.typeId}`)
    return objectText !== "" ? `${label}·${objectText} ×${reward.number}` : `${label} ×${reward.number}`
}

/** 列表奖励列：≤2 个全显，更多折成 +N（审查稿 #p-gifts）。 */
export function giftRewardChipTexts(
    rewards: readonly GiftReward[],
    lookups: GiftRewardLookups,
): string[] {
    return rewards.map(reward => giftRewardChipText(reward, lookups))
}

export function giftRewardTypeLabel(type: GiftProtocolType | undefined): string {
    return type === undefined ? "-" : GIFT_TYPE_LABELS[type] ?? `类型${type}`
}
