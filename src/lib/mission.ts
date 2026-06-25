// Mission CDN data loader — reads reward stage thresholds for all 8 categories
import regularRewards from "../../assets/mission_regular_reward.json";
import dailyRewards from "../../assets/mission_daily_reward.json";
import eventRewards from "../../assets/mission_event_reward.json";
import degreeRewards from "../../assets/mission_degree_reward.json";
import collectItemRewards from "../../assets/mission_collect_item_reward.json";

// Category mapping from MissionIdKind: client API category -> reward table
// 1=Regular, 2=Daily, 3=Event, 4=CollectItemEvent, 5=Degree
// 6=PassCardDaily, 7=PassCardWeek, 8=PassCardEvent (no CDN data yet)

interface MissionStage {
    stage: number;
    targetProgress: number;
}

// Build stage lookup: missionId -> stages sorted by targetProgress
function buildStages(rewardTable: Record<string, Record<string, any>>): Record<string, MissionStage[]> {
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
    1: buildStages(regularRewards as any),
    2: buildStages(dailyRewards as any),
    3: buildStages(eventRewards as any),
    4: buildStages(collectItemRewards as any),
    5: buildStages(degreeRewards as any),
    // Categories 6-8 (PassCard) use empty tables for now
    6: {},
    7: {},
    8: {},
};

/**
 * Determine the current stage for a mission given player progress.
 * Stage = first stage where targetProgress > progressValue.
 * If all stages are completed, returns the highest stage number.
 */
export function getCurrentStage(category: number, missionId: number, progress: number): number {
    const stages = missionStageLookup[category]?.[String(missionId)];
    if (!stages || stages.length === 0) return 1;
    let current = stages[stages.length - 1].stage; // default: max stage
    for (const s of stages) {
        if (progress < s.targetProgress) {
            current = s.stage;
            break;
        }
    }
    return current;
}

/**
 * Get all completed stages for a mission (used to determine if rewards can be claimed).
 */
export function getCompletedStages(category: number, missionId: number, progress: number): number[] {
    const stages = missionStageLookup[category]?.[String(missionId)];
    if (!stages) return [];
    return stages.filter(s => progress >= s.targetProgress).map(s => s.stage);
}
