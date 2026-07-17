export const CARNIVAL_REWARD_KINDS = new Set([0, 1, 2, 3, 4, 7])

export interface CarnivalRewardSlot {
    kind: number
    id?: number
    amount: number
}

export interface CarnivalRewardDefinition {
    id: number
    eventId: number
    score: number
    reasonId: number
    rewards: CarnivalRewardSlot[]
}

function parseInteger(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) ? parsed : undefined
}

export function parseCarnivalRewardRow(
    rewardId: number,
    row: unknown[],
): CarnivalRewardDefinition {
    const eventId = parseInteger(row[0])
    const score = parseInteger(row[2])
    const reasonId = parseInteger(row[3])
    if (eventId === undefined) throw new Error(`Carnival reward ${rewardId} has an invalid event id`)
    if (score === undefined) throw new Error(`Carnival reward ${rewardId} has an invalid score`)
    if (reasonId === undefined) throw new Error(`Carnival reward ${rewardId} has an invalid reason id`)

    const rewards: CarnivalRewardSlot[] = []
    for (let index = 4; index < 22; index += 3) {
        const kind = parseInteger(row[index])
        const id = parseInteger(row[index + 1])
        const amount = parseInteger(row[index + 2])
        if (kind === undefined && id === undefined && amount === undefined) continue
        if (kind === undefined) throw new Error(`Carnival reward ${rewardId} has a slot without a kind`)
        if (!CARNIVAL_REWARD_KINDS.has(kind)) {
            throw new Error(`Carnival reward ${rewardId} has unsupported reward kind ${kind}`)
        }
        if (amount === undefined || amount <= 0) {
            throw new Error(`Carnival reward ${rewardId} kind ${kind} has an invalid amount`)
        }
        if ((kind === 0 || kind === 1 || kind === 7) && id === undefined) {
            throw new Error(`Carnival reward ${rewardId} kind ${kind} requires an id`)
        }
        rewards.push({ kind, ...(id !== undefined ? { id } : {}), amount })
    }

    if (rewards.length === 0) throw new Error(`Carnival reward ${rewardId} has no rewards`)
    return { id: rewardId, eventId, score, reasonId, rewards }
}
