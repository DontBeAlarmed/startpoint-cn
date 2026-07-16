import { getPlayerCharactersSync } from "../../data/domains/character"
import { buildManaBoardAwakeCharacterList } from "../character-helpers"
import { reconcileAwakeUnlocks } from "./awake-unlock"

function mergeManaBoardAwake(...values: unknown[]): Record<number, number> {
    const merged: Record<number, number> = {}

    for (const value of values) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue

        for (const [boardIndex, awakeLevel] of Object.entries(value)) {
            const index = Number(boardIndex)
            if (!Number.isSafeInteger(index) || index <= 0) continue
            if (typeof awakeLevel !== "number"
                || !Number.isSafeInteger(awakeLevel)
                || awakeLevel < 0) continue
            merged[index] = Math.max(merged[index] ?? 0, awakeLevel)
        }
    }

    return merged
}

export function reconcileAwakeUnlockCharacterList(
    playerId: number,
    existing: Record<string, unknown>[]
): Record<string, unknown>[] {
    const changed = reconcileAwakeUnlocks(playerId).changed
    if (changed.size === 0) return existing

    const updates = buildManaBoardAwakeCharacterList(
        getPlayerCharactersSync(playerId),
        changed
    )
    const merged: Record<string, unknown>[] = []
    const indexByCharacterId = new Map<string, number>()

    for (const entry of existing) {
        const characterId = entry.character_id
        if (typeof characterId !== "number" && typeof characterId !== "string") {
            merged.push({ ...entry })
            continue
        }

        const key = String(characterId)
        const index = indexByCharacterId.get(key)
        if (index === undefined) {
            indexByCharacterId.set(key, merged.length)
            merged.push({ ...entry })
            continue
        }

        const previous = merged[index]
        merged[index] = {
            ...previous,
            ...entry,
            ...((previous.mana_board_awake !== undefined || entry.mana_board_awake !== undefined) ? {
                mana_board_awake: mergeManaBoardAwake(
                    previous.mana_board_awake,
                    entry.mana_board_awake
                ),
            } : {}),
        }
    }

    for (const update of updates) {
        const key = String(update.character_id)
        const index = indexByCharacterId.get(key)
        if (index === undefined) {
            indexByCharacterId.set(key, merged.length)
            merged.push(update)
            continue
        }

        merged[index] = {
            ...update,
            ...merged[index],
            mana_board_awake: mergeManaBoardAwake(
                merged[index].mana_board_awake,
                update.mana_board_awake
            ),
        }
    }

    return merged
}
