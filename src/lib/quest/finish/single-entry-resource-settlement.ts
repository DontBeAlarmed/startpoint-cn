import {
    getPlayerDailyChallengePointListSync,
    getPlayerSync,
    refreshPlayerDailyChallengePointsForRealDaySync,
    updatePlayerDailyChallengePointSync,
    updatePlayerSync,
} from "../../../data/domains/player"
import { getPlayerItemSync, setPlayerItemSync } from "../../../data/domains/item"
import { deletePlayerActiveQuestSync } from "../../../data/domains/quest_active"
import { getRealNow } from "../../../runtime/time/game-time"
import { computeEntryLifecycleStamina } from "../entry-lifecycle"
import type { ActiveQuest } from "../active-quest-service"
import {
    commitEntryResources,
    releaseEntryResources,
    type ChallengePointProjection,
} from "../entry-lifecycle"

export interface SingleEntryResourceSettlementInput {
    playerId: number
    activeQuest: ActiveQuest
    questAccomplished: boolean
    dailyResetHour: number
}

export type SingleEntryResourceSettlementResult =
    | {
        kind: "committed"
        staminaUsed: number
        dailyChallengePointList: ChallengePointProjection[] | null
    }
    | {
        kind: "released"
        staminaUsed: 0
        dailyChallengePointList: null
        afterStamina: number
        afterStaminaHealTime: Date
    }

export function settleSingleEntryResources(
    input: SingleEntryResourceSettlementInput,
): SingleEntryResourceSettlementResult {
    if (input.questAccomplished) {
        const committed = commitEntryResources({
            playerId: input.playerId,
            activeQuest: input.activeQuest,
        }, {
            getPlayer: getPlayerSync,
            updatePlayer: updatePlayerSync,
            refreshDailyChallengePoints: pointPlayerId => refreshPlayerDailyChallengePointsForRealDaySync(
                pointPlayerId,
                getRealNow(),
                input.dailyResetHour,
            ),
            getDailyChallengePointEntries: getPlayerDailyChallengePointListSync,
            updateDailyChallengePoint: updatePlayerDailyChallengePointSync,
        })
        return { kind: "committed", ...committed }
    }

    const released = releaseEntryResources({
        playerId: input.playerId,
        activeQuest: input.activeQuest,
        now: getRealNow(),
    }, {
        getPlayer: getPlayerSync,
        computeStamina: computeEntryLifecycleStamina,
        updatePlayer: updatePlayerSync,
        getItemCount: getPlayerItemSync,
        setItemCount: setPlayerItemSync,
        deleteActiveQuest: deletePlayerActiveQuestSync,
    })
    return {
        kind: "released",
        staminaUsed: 0,
        dailyChallengePointList: null,
        afterStamina: released.afterStamina,
        afterStaminaHealTime: released.afterStaminaHealTime,
    }
}
