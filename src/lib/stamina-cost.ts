import questEntryCosts from "../../assets/quest_entry_costs.json";
import { getActiveCampaignRate } from "./stamina-campaign";
import { QuestCategory } from "./types";
import { getServerDate } from "../utils";

const entryCostMap = questEntryCosts as Record<string, { itemId: number; itemCount: number; stamina: number }>;

export function getStaminaCost(questKey: string): { baseCost: number; cost: number; rate: number } {
    const entry = entryCostMap[questKey];
    if (!entry || !entry.stamina) return { baseCost: 0, cost: 0, rate: 1 };

    const parts = questKey.split("_");
    const category = parseInt(parts[0]) as QuestCategory;
    const questId = parseInt(parts.slice(1).join("_"));

    const rate = getActiveCampaignRate(category, questId, getServerDate());
    const cost = Math.max(1, Math.floor(entry.stamina * rate));

    return { baseCost: entry.stamina, cost, rate };
}
