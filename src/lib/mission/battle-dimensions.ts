import { getDb } from "../../data/db"
import { getCharacterRaces, getRaceKeyString } from "../quest/finish/race-utils"
import { addMissionCounterSync, setMissionCounterMaxSync } from "./counters"
import type { BattleFinishMissionEvent } from "./events"
import type { MissionCounterQuery } from "./counters"

function add(playerId: number, query: MissionCounterQuery, amount: number = 1): void {
    addMissionCounterSync(playerId, query, amount)
}

function recordCharacterCounters(event: BattleFinishMissionEvent): void {
    const allCharacters = [...new Set([...event.partyCharacterIds, ...event.unisonCharacterIds])]
    for (const characterId of allCharacters) {
        add(event.playerId, {
            dimension: "character.battle_clear",
            scopeType: "character",
            scopeKey: String(characterId),
            qualifier: { position: "any" },
        })
    }

    if (event.leaderCharacterId) {
        add(event.playerId, {
            dimension: "character.battle_clear",
            scopeType: "character",
            scopeKey: String(event.leaderCharacterId),
            qualifier: { position: "leader" },
        })
    }

    const sortedCharacters = [...allCharacters].sort((a, b) => a - b)
    for (let i = 0; i < sortedCharacters.length - 1; i++) {
        for (let j = i + 1; j < sortedCharacters.length; j++) {
            add(event.playerId, {
                dimension: "character.co_clear",
                scopeType: "lifetime",
                scopeKey: "all",
                qualifier: { characters: `${sortedCharacters[i]},${sortedCharacters[j]}` },
            })
        }
    }

    const races = sortedCharacters.flatMap(characterId => getCharacterRaces(characterId))
    const raceKey = getRaceKeyString(races)
    if (raceKey) {
        add(event.playerId, {
            dimension: "character.race_clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { raceKey },
        })
    }
}

function recordBattleMissionDimensionWrites(event: BattleFinishMissionEvent): void {
    add(event.playerId, {
        dimension: "battle.clear",
        scopeType: "lifetime",
        scopeKey: "all",
        qualifier: { mode: "any" },
    })
    add(event.playerId, {
        dimension: "battle.clear",
        scopeType: "lifetime",
        scopeKey: "all",
        qualifier: { mode: event.mode },
    })
    add(event.playerId, {
        dimension: "battle.quest_clear",
        scopeType: "lifetime",
        scopeKey: "all",
        qualifier: { questCategory: event.questCategory, questId: event.questId, mode: "any" },
    })
    add(event.playerId, {
        dimension: "battle.quest_clear",
        scopeType: "lifetime",
        scopeKey: "all",
        qualifier: { questCategory: event.questCategory, questId: event.questId, mode: event.mode },
    })

    if (event.clearRank !== null && event.clearRank !== undefined) {
        add(event.playerId, {
            dimension: "battle.rank_clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { rank: event.clearRank },
        })
    }

    if (event.statistics.clearPhase !== undefined) {
        add(event.playerId, {
            dimension: "battle.phase_clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { phase: event.statistics.clearPhase },
        })
    }

    if (event.statistics.dashCount > 0) {
        add(event.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "dash" },
        }, event.statistics.dashCount)
    }
    if (event.statistics.powerFlipCount > 0) {
        add(event.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "power_flip" },
        }, event.statistics.powerFlipCount)
    }
    if (event.statistics.skillCount > 0) {
        add(event.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "skill" },
        }, event.statistics.skillCount)
    }
    if (event.statistics.maxComboCount > 0) {
        setMissionCounterMaxSync(event.playerId, {
            dimension: "battle.max_combo",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: {},
        }, event.statistics.maxComboCount)
    }

    recordCharacterCounters(event)
}

export function recordBattleMissionDimensions(event: BattleFinishMissionEvent): void {
    if (!event.accomplished) return

    getDb().transaction(() => {
        recordBattleMissionDimensionWrites(event)
    })()
}

export function recordBattleMissionDimensionsSafe(event: BattleFinishMissionEvent): void {
    try {
        recordBattleMissionDimensions(event)
    } catch (error) {
        console.warn("[MISSION] battle dimension counter write failed", error)
    }
}
