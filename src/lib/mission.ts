// Mission CDN data loader — reads reward tables for stage thresholds + mission ID lists
import regularRewards from "../../assets/mission_regular_reward.json";
import dailyRewards from "../../assets/mission_daily_reward.json";
import eventRewards from "../../assets/mission_event_reward.json";
import degreeRewards from "../../assets/mission_degree_reward.json";
import collectItemRewards from "../../assets/mission_collect_item_reward.json";
import weeklyRewards from "../../assets/mission_weekly_reward.json";

// Mission definition tables — for pattern → mission_id lookup
import regularDefs from "../../assets/mission_regular.json";
import dailyDefs from "../../assets/mission_daily.json";
import eventDefs from "../../assets/mission_event.json";
import degreeDefs from "../../assets/mission_degree.json";
import collectItemDefs from "../../assets/mission_collect_item.json";
import weeklyDefs from "../../assets/mission_weekly_def.json";
import activeRewards from "../../assets/mission_active_reward.json";

// Category mapping (client API category → reward table + stage data)
// 1=Regular, 2=Daily, 3=Event, 4=CollectItemEvent, 5=Degree
// 10=Weekly (CN-specific patch) — trial mapping

interface MissionStage {
    stage: number;
    targetProgress: number;
}

function buildLookup(rewardTable: Record<string, Record<string, any>>): Record<string, MissionStage[]> {
    const result: Record<string, MissionStage[]> = {};
    for (const [missionId, stages] of Object.entries(rewardTable)) {
        const list: MissionStage[] = [];
        for (const [stageStr, rows] of Object.entries(stages)) {
            const row = (rows as any[])[0];
            const targetProgress = parseInt(row[5] || row[1] || "0");
            const stage = parseInt(stageStr);
            list.push({ stage, targetProgress });
        }
        list.sort((a, b) => a.targetProgress - b.targetProgress);
        result[missionId] = list;
    }
    return result;
}

const missionStageLookup: Record<number, Record<string, MissionStage[]>> = {
    1: buildLookup(regularRewards as any),
    2: buildLookup(dailyRewards as any),
    3: buildLookup(eventRewards as any),
    4: buildLookup(collectItemRewards as any),
    5: buildLookup(degreeRewards as any),
    10: buildLookup(weeklyRewards as any),  // CN-specific: Weekly missions
};

// Pattern → mission_id reverse index (for update_mission_progress)
interface PatternMatch { missionId: number; category: number }
const patternIndex: Record<string, PatternMatch[]> = {};

function indexPatterns(defs: Record<string, any>, category: number) {
    for (const [missionId, rows] of Object.entries(defs)) {
        const row = (rows as any[])[0];
        if (!row || !Array.isArray(row)) continue;
        const pattern = String(row[0]);
        if (!pattern || pattern === '(None)') continue;
        if (!patternIndex[pattern]) patternIndex[pattern] = [];
        patternIndex[pattern].push({ missionId: parseInt(missionId), category });
    }
}

indexPatterns(regularDefs as any, 1);
indexPatterns(dailyDefs as any, 2);
indexPatterns(eventDefs as any, 3);
indexPatterns(collectItemDefs as any, 4);
indexPatterns(degreeDefs as any, 5);
indexPatterns(weeklyDefs as any, 10);

// Degree mission target lookup (extracted from definition descriptions)
// mission_id → target degree level (e.g., 1000→50, 1010→100)
const degreeTargetMap: Record<number, number> = {};
{
    const descRegex = /玩家(?:达到|级别达到)\s*(\d+)/;
    for (const [mid, rows] of Object.entries(degreeDefs as Record<string, any>)) {
        const row = (rows as any[])[0];
        if (!row || !row[2]) continue;
        const match = descRegex.exec(String(row[2]));
        if (match) degreeTargetMap[parseInt(mid)] = parseInt(match[1]);
    }
}

export function getTargetDegree(missionId: number): number | undefined {
    return degreeTargetMap[missionId];
}

export function getMissionsByPattern(pattern: string): PatternMatch[] {
    return patternIndex[pattern] || [];
}

// Active mission reward types (from CDN active_mission_reward.json)
// kind: 1=Item, 2=Equipment, 3=Mana, 4=Character, 5=Exp, 6=Degree, 7=PassCardPoint
export interface ActiveMissionReward {
    kind: number;
    amount: number;
    itemId?: number;
    characterId?: number;
    equipmentId?: number;
}

/**
 * Get all rewards for a given active mission stage.
 * Returns empty array if mission or stage not found.
 */
export function getActiveMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const mission = (activeRewards as Record<string, Record<string, any[]>>)[String(missionId)];
    if (!mission) return [];
    const stageData = mission[String(stage)];
    if (!stageData || !stageData[0]) return [];
    const row = stageData[0];

    const result: ActiveMissionReward[] = [];
    for (let slot = 0; slot < 4; slot++) {
        const base = 7 + slot * 6;
        const kind = parseInt(row[base]) || 0;
        if (kind === 0) continue;
        const amount = parseInt(row[base + 1]) || 0;
        if (amount === 0) continue;

        const reward: ActiveMissionReward = { kind, amount };
        const itemId = row[base + 2] ? parseInt(row[base + 2]) : undefined;
        const charId = row[base + 3] ? parseInt(row[base + 3]) : undefined;
        const equipId = row[base + 4] ? parseInt(row[base + 4]) : undefined;

        if (itemId) reward.itemId = itemId;
        if (charId) reward.characterId = charId;
        if (equipId) reward.equipmentId = equipId;

        result.push(reward);
    }
    return result;
}

/**
 * Get all mission IDs (as integers) for a given category,
 * derived from the CDN reward table — aligns with DummyMissionRepository.createDummyData().
 */
export function getMissionIdsByCategory(category: number): number[] {
    const lookup = missionStageLookup[category];
    if (!lookup) return [];
    return Object.keys(lookup).map(Number);
}

/**
 * Determine the current stage for a mission given player progress.
 * Stage = first stage where targetProgress > progress.
 * Defaults to 1 if no stages defined.
 */
export function getCurrentStage(category: number, missionId: number, progress: number): number {
    const stages = missionStageLookup[category]?.[String(missionId)];
    if (!stages || stages.length === 0) return 1;
    let current = stages[stages.length - 1].stage;
    for (const s of stages) {
        if (progress < s.targetProgress) {
            current = s.stage;
            break;
        }
    }
    return current;
}
