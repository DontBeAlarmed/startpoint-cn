import { getQuestEntryCostByKey } from "./quest-entry-content";
import { getActiveCampaignRate } from "./stamina-campaign";
import { QuestCategory } from "./types";
import { getServerDate } from "../utils";

export function getStaminaCost(questKey: string): { baseCost: number; cost: number; rate: number } {
    const entry = getQuestEntryCostByKey(questKey);
    if (!entry || !entry.stamina) return { baseCost: 0, cost: 0, rate: 1 };

    const parts = questKey.split("_");
    const category = parseInt(parts[0]) as QuestCategory;
    const questId = parseInt(parts.slice(1).join("_"));

    const rate = getActiveCampaignRate(category, questId, getServerDate());
    const cost = Math.max(1, Math.floor(entry.stamina * rate));

    return { baseCost: entry.stamina, cost, rate };
}

/**
 * F4 冻结的 Campaign 公式：对临时减免后的成本应用倍率（先折半/置零，再打折），
 * 非零成本最低扣 1；rate 0 或成本 0 时为 0。
 */
export function applyStaminaConsumptionRate(temporaryCost: number, rate: number): number {
    if (temporaryCost === 0 || rate === 0) return 0
    return Math.max(1, Math.floor(temporaryCost * rate))
}

/**
 * 同服 guest 实际体力（CN StaminaCostCalculator 语义）：互关(1) 免费；
 * 其余（0/2/3）先 floor(raw*0.5) 再应用 Campaign。
 */
export function getLocalGuestStaminaCost(
    questKey: string,
    state: 0 | 1 | 2 | 3,
): number {
    if (state === 1) return 0
    const { baseCost, rate } = getStaminaCost(questKey)
    return applyStaminaConsumptionRate(Math.floor(baseCost * 0.5), rate)
}
