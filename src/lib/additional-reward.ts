import { calculateScoreRewardAmount, type RewardCampaignRates } from "./reward-campaign"
import type { DropScoreRewardId, PlayerRewardResult, Reward } from "./types"
import { RewardType } from "./types"

export interface AdditionalRewardCandidate {
    readonly index: number
    readonly groupStringId: string
    readonly type: number
    readonly id?: number
    readonly number: number
    readonly weight: number
}
interface QuestRangeRule {
    readonly categories: readonly number[]
    readonly keyQueries: readonly (readonly number[] | null)[]
}

export interface AdditionalRewardCollectItemRule extends QuestRangeRule {
    readonly eventId: number
    readonly startAtMs: number
    readonly endAtMs: number
    readonly prerequisite: { readonly category: number; readonly questId: number } | null
    readonly thresholds: readonly {
        readonly enemyLevelMin: number
        readonly groupId: number
    }[]
}

export interface AdditionalRewardBossPickupRule extends QuestRangeRule {
    readonly eventId: number
    readonly startAtMs: number
    readonly endAtMs: number
    readonly groupId: number
    readonly availableRank: number
}

export interface AdditionalRewardTable {
    readonly groups: Readonly<Record<string, readonly AdditionalRewardCandidate[]>>
    readonly collectItemRules: readonly AdditionalRewardCollectItemRule[]
    readonly bossPickupRules: readonly AdditionalRewardBossPickupRule[]
}

export interface AdditionalRewardSelection extends AdditionalRewardCandidate {
    readonly groupId: number
    readonly id: number
    readonly type: 0
}

export interface AdditionalRewardResolveInput {
    readonly questCategory: number
    readonly questId: number
    readonly enemyLevel: number
    readonly nowMs: number
    readonly isMulti: boolean
    readonly isQuestCleared: (category: number, questId: number) => boolean
}

export interface AdditionalRewardSettlementInput extends AdditionalRewardResolveInput {
    readonly rewardCampaignRates: RewardCampaignRates
    readonly boostPointUsed: boolean
    readonly serverDropMultiplier: number
}

export interface AdditionalRewardSettlementResult {
    readonly dropAdditionalRewardIds: readonly DropScoreRewardId[]
    readonly rewardResult: PlayerRewardResult | null
}

function questKeyParts(category: number, questId: number): readonly number[] {
    if (category === 1 || category === 2 || category === 4) {
        return [
            Math.floor(questId / 1_000_000),
            Math.floor(questId / 1_000) % 1_000,
            questId % 1_000,
        ]
    }
    if (category === 15) return [questId]
    return [Math.floor(questId / 1_000), questId % 1_000]
}

function matchesQuestRange(rule: QuestRangeRule, category: number, questId: number): boolean {
    if (!rule.categories.includes(category)) return false
    const parts = questKeyParts(category, questId)
    for (let index = 0; index < parts.length && index < rule.keyQueries.length; index += 1) {
        const query = rule.keyQueries[index]
        if (query !== null && !query.includes(parts[index])) return false
    }
    return true
}

function deterministicItemSelection(
    table: AdditionalRewardTable,
    groupId: number,
): AdditionalRewardSelection | null {
    const candidates = table.groups[String(groupId)]
    if (candidates?.length !== 1) return null
    const candidate = candidates[0]
    if (candidate.type !== 0
        || !Number.isSafeInteger(candidate.id)
        || candidate.id! <= 0
        || !Number.isSafeInteger(candidate.number)
        || candidate.number <= 0) return null
    return { ...candidate, groupId, type: 0, id: candidate.id! }
}

export function resolveAdditionalRewardSelections(
    table: AdditionalRewardTable,
    input: AdditionalRewardResolveInput,
): readonly AdditionalRewardSelection[] {
    if (!Number.isSafeInteger(input.enemyLevel) || input.enemyLevel < 0) return []
    const selections: AdditionalRewardSelection[] = []
    for (const rule of table.collectItemRules) {
        if (input.nowMs < rule.startAtMs || input.nowMs > rule.endAtMs
            || !matchesQuestRange(rule, input.questCategory, input.questId)
            || (rule.prerequisite !== null
                && !input.isQuestCleared(
                    rule.prerequisite.category,
                    rule.prerequisite.questId,
                ))) continue
        for (const threshold of rule.thresholds) {
            if (threshold.enemyLevelMin > input.enemyLevel) break
            const selected = deterministicItemSelection(table, threshold.groupId)
            if (selected !== null) selections.push(selected)
        }
    }
    if (input.isMulti) {
        for (const rule of table.bossPickupRules) {
            if (input.nowMs < rule.startAtMs || input.nowMs > rule.endAtMs
                || !matchesQuestRange(rule, input.questCategory, input.questId)) continue
            const selected = deterministicItemSelection(table, rule.groupId)
            if (selected !== null) selections.push(selected)
        }
    }
    return selections
}

export function settleAdditionalRewardsSync(
    table: AdditionalRewardTable,
    input: AdditionalRewardSettlementInput,
    dependencies: {
        readonly grantRewards: (rewards: Reward[]) => PlayerRewardResult | null
    },
): AdditionalRewardSettlementResult {
    const selections = resolveAdditionalRewardSelections(table, input)
    if (selections.length === 0) {
        return { dropAdditionalRewardIds: [], rewardResult: null }
    }

    const itemAmounts = new Map<number, number>()
    const dropAdditionalRewardIds: DropScoreRewardId[] = []
    for (const selected of selections) {
        const amount = calculateScoreRewardAmount(
            selected.number,
            RewardType.ITEM,
            input.rewardCampaignRates,
            input.boostPointUsed,
            input.serverDropMultiplier,
        )
        itemAmounts.set(selected.id, (itemAmounts.get(selected.id) ?? 0) + amount)
        dropAdditionalRewardIds.push({
            group_id: selected.groupId,
            index: selected.index,
            number: amount,
        })
    }
    const rewards: Reward[] = [...itemAmounts].map(([id, count]) => ({
        type: RewardType.ITEM,
        id,
        count,
    }))
    const rewardResult = dependencies.grantRewards(rewards)
    if (rewardResult === null) throw new Error("Failed to grant additional rewards.")
    return { dropAdditionalRewardIds, rewardResult }
}
