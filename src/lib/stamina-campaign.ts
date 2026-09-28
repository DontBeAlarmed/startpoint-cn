import { getContentSnapshot, type ReadonlyContentRepository } from "../content/runtime/content-snapshot";
import { type GameCalendarPolicy } from "../time/game-calendar";
import { getGameCalendar } from "../time/game-calendar-provider";
import { QuestCategory } from "./types";

type LevelSelector =
    | { readonly kind: "all" }
    | { readonly kind: "within"; readonly ids: readonly number[] };

interface StaminaCampaign {
    id: string;
    rate: number;
    questType: number;
    // Level selectors in CDN column order: [eventIds(row7), middle(row8), questIds(row9)].
    // "(None)" leaves the level unconstrained, "" matches nothing, "1,2" matches 1 or 2.
    selectors: readonly [LevelSelector, LevelSelector, LevelSelector];
    startTime: Date;
    endTime: Date;
}

type CampaignTable = Record<string, string[][]>

/** CDN quest types whose selector triple is a full three-level id path (Main/Ex/BossBattle). */
const THREE_LEVEL_QUEST_TYPES: ReadonlySet<number> = new Set([0, 1, 2]);

function parseLevelSelector(raw: string): LevelSelector {
    if (raw === "(None)") return { kind: "all" }
    if (raw === "") return { kind: "within", ids: [] }
    return { kind: "within", ids: raw.split(",").map(Number) }
}

function buildCampaigns(
    campaignData: CampaignTable,
    calendar: GameCalendarPolicy = getGameCalendar(),
): readonly StaminaCampaign[] {
    const campaigns: StaminaCampaign[] = []
    for (const [id, rows] of Object.entries(campaignData)) {
        const row = rows[0]
        if (!row || !row[5]) continue
        campaigns.push({
            id,
            rate: parseFloat(row[5]),
            questType: parseInt(row[6]),
            selectors: [
                parseLevelSelector(row[7]),
                parseLevelSelector(row[8]),
                parseLevelSelector(row[9]),
            ],
            // Master windows are offset-less wall-clock strings: they must go
            // through the game calendar policy, never host-local Date parsing.
            startTime: new Date(calendar.parseMasterTimestamp(row[1])),
            endTime: new Date(calendar.parseMasterTimestamp(row[2])),
        })
    }
    return Object.freeze(campaigns)
}

const campaignsByRepository = new WeakMap<ReadonlyContentRepository, readonly StaminaCampaign[]>()

function getCampaigns(): readonly StaminaCampaign[] {
    const repository = getContentSnapshot().repository
    const cached = campaignsByRepository.get(repository)
    if (cached) return cached
    const campaigns = buildCampaigns(repository.table<CampaignTable>("stamina_campaign.json"))
    campaignsByRepository.set(repository, campaigns)
    return campaigns
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

/**
 * Official selector semantics (CN 1.8.1 QuestRangeReferenceIdKindTools +
 * StaminaCampaignValues): a campaign targets a quest by matching the quest id's
 * digit path against the selector lists. Main/Ex/BossBattle campaigns
 * (questType 0/1/2) consult all three levels against the twice-by-1000
 * decomposition of the quest id; every event-type campaign (questType >= 3)
 * consults [eventIds, questIds] against [floor(id/1000), id%1000] and ignores
 * the middle column. "(None)" leaves a level unconstrained, an empty list
 * matches nothing at that level, and a multi-id event list degrades to its
 * first id, mirroring the client's keyFromId single-id coercion (only
 * single-id rows exist in the CDN data).
 */
function matchesSelectors(campaign: StaminaCampaign, questId: number): boolean {
    let path: readonly number[]
    let levels: readonly number[]
    if (THREE_LEVEL_QUEST_TYPES.has(campaign.questType)) {
        path = [
            Math.floor(questId / 1_000_000),
            Math.floor(questId / 1_000) % 1_000,
            questId % 1_000,
        ]
        levels = [0, 1, 2]
    } else {
        path = [Math.floor(questId / 1_000), questId % 1_000]
        levels = [0, 2]
    }
    for (let index = 0; index < levels.length; index++) {
        const selector = campaign.selectors[levels[index]]
        if (selector.kind === "all") continue
        const ids = index === 0 && selector.ids.length > 1
            ? selector.ids.slice(0, 1)
            : selector.ids
        if (!ids.includes(path[index])) return false
    }
    return true
}

export function getActiveCampaignRate(
    category: QuestCategory,
    questId: number,
    serverDate: Date,
): number {
    const cdnType = CATEGORY_TO_CDN_TYPE[category];
    if (cdnType === undefined) return 1;

    let rate = 1;
    for (const c of getCampaigns()) {
        if (c.questType !== cdnType) continue;
        if (serverDate < c.startTime || serverDate > c.endTime) continue;
        if (!matchesSelectors(c, questId)) continue;
        rate = Math.min(rate, c.rate);
    }
    return rate;
}
