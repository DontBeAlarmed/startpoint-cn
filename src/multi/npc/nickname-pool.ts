import { randomInt } from "crypto"
import { readFileSync } from "fs"
import path from "path"
import { MultiRoom, RoomNpcAssignment } from "../../lib/types/multi"

export type RandomIndex = (upperExclusive: number) => number

const FALLBACK_NAMES = ["开心超人", "名字真难取"] as const
const nicknameAsset = JSON.parse(readFileSync(
    path.resolve(__dirname, "..", "..", "..", "assets", "server", "npc_contributor_names.json"),
    "utf8",
)) as { names: string[] }
const DEFAULT_NAMES: readonly string[] = nicknameAsset.names

function clampCount(count: number): number {
    if (Number.isNaN(count)) return 0
    return Math.min(2, Math.max(0, Math.trunc(count)))
}

export function sampleWithoutReplacement(
    names: readonly string[],
    count: number,
    randomIndex: RandomIndex = randomInt,
): string[] {
    const pool = [...names]
    const sampleCount = Math.min(clampCount(count), pool.length)

    for (let index = 0; index < sampleCount; index++) {
        const upperExclusive = pool.length - index
        const offset = randomIndex(upperExclusive)
        if (!Number.isInteger(offset) || offset < 0 || offset >= upperExclusive) {
            throw new RangeError(`Random index ${offset} out of range for upperExclusive ${upperExclusive}`)
        }
        const selectedIndex = index + offset
        ;[pool[index], pool[selectedIndex]] = [pool[selectedIndex], pool[index]]
    }

    return pool.slice(0, sampleCount)
}

export function ensureNpcRoster(
    room: MultiRoom,
    count: number,
    names: readonly string[] = DEFAULT_NAMES,
    randomIndex: RandomIndex = randomInt,
): RoomNpcAssignment[] {
    const targetCount = clampCount(count)
    const existingIds = new Set(room.npc_roster.map(assignment => assignment.com_id))
    const missingIds = ([1, 2] as const)
        .slice(0, targetCount)
        .filter(comId => !existingIds.has(comId))
    if (missingIds.length === 0) return room.npc_roster

    const usedNames = new Set(room.npc_roster.map(assignment => assignment.name))
    const availableNames = [...new Set(names)].filter(name => !usedNames.has(name))
    const sampledNames = sampleWithoutReplacement(availableNames, missingIds.length, randomIndex)

    for (const comId of missingIds) {
        let name = sampledNames.shift()
        if (name === undefined) {
            name = [...FALLBACK_NAMES, `NPC${comId}`, "NPC1", "NPC2"]
                .find(candidate => !usedNames.has(candidate))
        }
        if (name === undefined) {
            throw new Error("Unable to assign a unique NPC nickname")
        }
        room.npc_roster.push({ com_id: comId, name })
        usedNames.add(name)
    }

    room.npc_roster.sort((left, right) => left.com_id - right.com_id)
    return room.npc_roster
}

export function getActiveNpcRoster(room: MultiRoom, count: number): RoomNpcAssignment[] {
    const activeCount = clampCount(count)
    if (activeCount === 0) return []
    return room.npc_roster.slice(-activeCount)
}
