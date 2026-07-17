import { getDb } from "../db"
import {
    getPlayerDegreeIdsSync as getDegreeIds,
    givePlayerDegreeSync as giveDegree,
} from "../../lib/carnival-reward-persistence"
import { mergeOwnedDegreeIds } from "../../lib/degrees"

export function getPlayerDegreeIdsSync(playerId: number): number[] {
    return getDegreeIds(getDb(), playerId)
}

export function givePlayerDegreeSync(playerId: number, degreeId: number) {
    return giveDegree(getDb(), playerId, degreeId)
}

export function getOwnedPlayerDegreeIdsSync(playerId: number, currentDegreeId: number): number[] {
    return mergeOwnedDegreeIds(currentDegreeId, getPlayerDegreeIdsSync(playerId))
}
