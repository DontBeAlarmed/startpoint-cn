// Mission CDN data loader — reads reward tables for stage thresholds + mission ID lists
import regularRewards from "../../assets/mission_regular_reward.json";
import dailyRewards from "../../assets/mission_daily_reward.json";
import eventRewards from "../../assets/mission_event_reward.json";
import degreeRewards from "../../assets/mission_degree_reward.json";
import collectItemRewards from "../../assets/mission_collect_item_reward.json";

// Category mapping (client API category → reward table + stage data)
// 1=Regular, 2=Daily, 3=Event, 4=CollectItemEvent, 5=Degree
// Categories 6-8 (PassCard) and 10 (StoryEvent) not yet loaded — ignored by client

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
};

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
