import campaignData from "../../assets/stamina_campaign.json";
import { QuestCategory } from "./types";

interface StaminaCampaign {
    id: string;
    rate: number;
    questType: number;
    questIds: string;
    eventIds: string;
    startTime: Date;
    endTime: Date;
}

const campaigns: StaminaCampaign[] = [];

for (const [id, rows] of Object.entries(campaignData)) {
    const row = (rows as string[][])[0];
    if (!row || !row[5]) continue;
    campaigns.push({
        id,
        rate: parseFloat(row[5]),
        questType: parseInt(row[6]),
        questIds: row[9] || "",
        eventIds: row[7] || "",
        startTime: new Date(row[1]),
        endTime: new Date(row[2]),
    });
}

const CATEGORY_TO_CDN_TYPE: Record<number, number> = {
    [QuestCategory.MAIN]: 0,
    [QuestCategory.EX]: 1,
    [QuestCategory.BOSS_BATTLE]: 2,
    [QuestCategory.DAILY_WEEK_EVENT]: 3,
    [QuestCategory.DAILY_EXP_MANA_EVENT]: 4,
    [QuestCategory.ADVENT_EVENT_SINGLE]: 5,
    [QuestCategory.ADVENT_EVENT_MULTI]: 5,
    [QuestCategory.STORY_EVENT_SINGLE]: 6,
    [QuestCategory.CHALLENGE_DUNGEON_EVENT]: 7,
    [QuestCategory.RANKING_EVENT_SINGLE]: 8,
    [QuestCategory.WORLD_STORY_EVENT]: 9,
    [QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE]: 10,
    [QuestCategory.PRACTICE]: 11,
    [QuestCategory.TOWER_DUNGEON_EVENT]: 13,
    [QuestCategory.EXPERT_SINGLE_EVENT]: 14,
    [QuestCategory.CARNIVAL_EVENT]: 15,
    [QuestCategory.RAID_EVENT]: 16,
    [QuestCategory.RUSH_EVENT]: 17,
    [QuestCategory.SOLO_TIME_ATTACK_EVENT]: 18,
    [QuestCategory.HARD_MULTI_EVENT]: 19,
};

function matchesQuestId(campaign: StaminaCampaign, questId: number): boolean {
    if (campaign.questIds === "(None)" || campaign.questIds === "") return true;
    const ids = campaign.questIds.split(",").map(Number);
    return ids.includes(questId);
}

function matchesEvent(campaign: StaminaCampaign, _questId: number): boolean {
    if (campaign.eventIds === "(None)" || campaign.eventIds === "") return false;
    return true;
}

export function getActiveCampaignRate(
    category: QuestCategory,
    questId: number,
    serverDate: Date,
): number {
    const cdnType = CATEGORY_TO_CDN_TYPE[category];
    if (cdnType === undefined) return 1;

    let rate = 1;
    for (const c of campaigns) {
        if (c.questType !== cdnType) continue;
        if (serverDate < c.startTime || serverDate > c.endTime) continue;
        if (!matchesQuestId(c, questId) && !matchesEvent(c, questId)) continue;
        rate = Math.min(rate, c.rate);
    }
    return rate;
}
