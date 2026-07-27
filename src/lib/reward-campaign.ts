import { RewardType } from "./types"
import bundledRewardCampaigns from "../../assets/reward_campaign.json"
import { getRuntimeContentTableSync } from "../content/runtime/table-access"

export interface RewardCampaignEntry {
    readonly id: number
    readonly startAtMs: number
    readonly endAtMs: number
    readonly rewardKind: 0 | 1 | 2
    readonly rate: number
    readonly categories: readonly number[]
    readonly keyQueries: readonly (readonly number[] | null)[]
}

export type RewardCampaignTable = Readonly<Record<string, RewardCampaignEntry>>

export interface RewardCampaignRates {
    readonly item: number
    readonly exp: number
    readonly mana: number
}

const DEFAULT_RATES: RewardCampaignRates = Object.freeze({ item: 1, exp: 1, mana: 1 })

function questKeyParts(category: number, questId: number): number[] {
    if (category === 1 || category === 2 || category === 4) {
        return [Math.floor(questId / 1_000_000), Math.floor(questId / 1_000) % 1_000, questId % 1_000]
    }
    if (category === 15) return [questId]
    return [Math.floor(questId / 1_000), questId % 1_000]
}

function matchesCampaign(entry: RewardCampaignEntry, category: number, questId: number): boolean {
    if (!entry.categories.includes(category)) return false
    const parts = questKeyParts(category, questId)
    for (let index = 0; index < parts.length && index < entry.keyQueries.length; index += 1) {
        const query = entry.keyQueries[index]
        if (query !== null && !query.includes(parts[index])) return false
    }
    return true
}

export function resolveRewardCampaignRates(
    campaigns: RewardCampaignTable,
    category: number,
    questId: number,
    now: Date,
): RewardCampaignRates {
    const nowMs = now.getTime()
    const rates = { ...DEFAULT_RATES }
    for (const entry of Object.values(campaigns)) {
        if (nowMs < entry.startAtMs || nowMs > entry.endAtMs
            || !matchesCampaign(entry, category, questId)) continue
        if (entry.rewardKind === 0) rates.item = Math.max(rates.item, entry.rate)
        else if (entry.rewardKind === 1) rates.exp = Math.max(rates.exp, entry.rate)
        else rates.mana = Math.max(rates.mana, entry.rate)
    }
    return rates
}

export function getRewardCampaignRates(
    category: number,
    questId: number,
    now: Date,
): RewardCampaignRates {
    const campaigns = getRuntimeContentTableSync(
        "reward_campaign.json",
        bundledRewardCampaigns as RewardCampaignTable,
    )
    return resolveRewardCampaignRates(campaigns, category, questId, now)
}

function eligibleRate(rewardType: RewardType, rates: RewardCampaignRates): number | null {
    switch (rewardType) {
        case RewardType.ITEM:
        case RewardType.EQUIPMENT:
        case RewardType.ELEMENT:
        case RewardType.AETHER:
            return rates.item
        case RewardType.EXP:
            return rates.exp
        case RewardType.MANA:
            return rates.mana
        default:
            return null
    }
}

export function calculateScoreRewardAmount(
    baseAmount: number,
    rewardType: RewardType,
    rates: RewardCampaignRates,
    boostPointUsed: boolean,
    serverDropMultiplier: number,
): number {
    const campaignRate = eligibleRate(rewardType, rates)
    if (campaignRate === null) return rewardType === RewardType.CHARACTER ? 1 : baseAmount
    const officialMultiplier = campaignRate + (boostPointUsed ? 1 : 0)
    return Math.floor(baseAmount * officialMultiplier + 2e-10) * serverDropMultiplier
}

export function calculateCharacterBattleExp(
    baseAmount: number,
    rates: RewardCampaignRates,
): number {
    return Math.ceil(baseAmount * rates.exp)
}

export function calculateFixedQuestMana(
    baseAmount: number,
    rates: RewardCampaignRates,
): number {
    return Math.floor(baseAmount * rates.mana + 2e-10)
}
