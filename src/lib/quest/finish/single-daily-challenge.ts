import bundledEventChallengePointMap from "../../../../assets/event_challenge_point_map.json"

import {
    getPlayerDailyChallengePointListSync,
    refreshPlayerDailyChallengePointsForRealDaySync,
    updatePlayerDailyChallengePointSync,
} from "../../../data/domains/player"
import { getRuntimeContentTableSync } from "../../../content/runtime/table-access"
import { getRealNow } from "../../../runtime/time/game-time"
import { QuestCategory } from "../../types"
import { handleDailyChallengePoint } from "./challenge-point"

export function settleSingleDailyChallengePoint(params: {
    questCategory: QuestCategory
    questId: number
    eventId: number | undefined
    playerId: number
    dailyResetHour: number
}): Object[] | null {
    return handleDailyChallengePoint({
        ...params,
        challengePointMap: getRuntimeContentTableSync(
            "event_challenge_point_map.json",
            bundledEventChallengePointMap as Record<string, number>,
        ),
        refreshPoints: playerId => refreshPlayerDailyChallengePointsForRealDaySync(
            playerId,
            getRealNow(),
            params.dailyResetHour,
        ),
        getEntries: getPlayerDailyChallengePointListSync,
        updatePoint: updatePlayerDailyChallengePointSync,
    })
}
