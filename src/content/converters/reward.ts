import { deepFreeze } from "../deep-freeze"
import type {
    NestedOrderedMapTextRows,
    OrderedMapTextRow,
} from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

const CLEAR_REWARD_PATH = "master/reward/clear_reward.orderedmap"
const SCORE_REWARD_PATH = "master/reward/score_reward.orderedmap"
const RARE_SCORE_REWARD_PATH = "master/reward/rare_score_reward.orderedmap"
const SCORE_ATTACK_BORDER_PATH = "master/quest/event/score_attack_border_reward.orderedmap"
const RUSH_QUEST_FOLDER_PATH = "master/quest/event/rush_event_quest_folder.orderedmap"
const RUSH_RANKING_REWARD_PATH = "master/quest/event/rush_event_ranking_reward.orderedmap"

const INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

export interface RewardSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
    readNested(logicalPath: string): Promise<readonly NestedOrderedMapTextRows[]>
}

export interface RewardConversionOutput {
    readonly "clear_reward.json": Readonly<Record<string, unknown>>
    readonly "score_reward.json": Readonly<Record<string, readonly unknown[]>>
    readonly "rare_score_reward.json": Readonly<Record<string, readonly unknown[]>>
    readonly "score_attack_border_reward.json": Readonly<Record<string, readonly unknown[]>>
    readonly "rush_event_quest_folder.json": Readonly<Record<string, unknown>>
    readonly "rush_event_ranking_reward.json": Readonly<Record<string, unknown>>
}

function invalidReward(reason: string): never {
    throw new Error(`invalid reward content: ${reason}`)
}

function compareIds(left: string, right: string): number {
    return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
}

function requireId(value: string, subject: string): string {
    if (!POSITIVE_INTEGER_PATTERN.test(value)) {
        invalidReward(`${subject} must be a canonical positive integer: ${value}`)
    }
    return value
}

function parseInteger(value: string, subject: string): number {
    if (!INTEGER_PATTERN.test(value)) invalidReward(`${subject} must be an integer: ${value}`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidReward(`${subject} must be a safe integer: ${value}`)
    return parsed
}

function parsePositiveInteger(value: string, subject: string): number {
    requireId(value, subject)
    return Number(value)
}

function parseOptionalInteger(value: string, subject: string): number | undefined {
    return value === "" || value === "(None)" ? undefined : parseInteger(value, subject)
}

function parseFiniteNumber(value: string, subject: string): number {
    if (value.trim() !== value || value === "") {
        invalidReward(`${subject} must be a finite number: ${value}`)
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) invalidReward(`${subject} must be a finite number: ${value}`)
    return parsed
}

function parseRow(row: OrderedMapTextRow, tableName: string, columnCount: number): string[] {
    requireId(row.key, `${tableName} key`)
    const fields = parseCsvLine(row.text, `${tableName}[${row.key}]`, invalidReward)
    if (fields.length !== columnCount) {
        invalidReward(`${tableName}[${row.key}] must have ${columnCount} columns, got ${fields.length}`)
    }
    return fields
}

function sortedRows(rows: readonly OrderedMapTextRow[]): OrderedMapTextRow[] {
    return [...rows].sort((left, right) => compareIds(left.key, right.key))
}

function sortedGroups(groups: readonly NestedOrderedMapTextRows[]): NestedOrderedMapTextRows[] {
    return [...groups].sort((left, right) => compareIds(left.key, right.key))
}

function convertClearRewards(rows: readonly OrderedMapTextRow[]): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const row of sortedRows(rows)) {
        const fields = parseRow(row, "clear_reward", 4)
        const reward: Record<string, unknown> = {
            name: "",
            type: parseInteger(fields[1], `clear_reward[${row.key}].type`),
        }
        const id = parseOptionalInteger(fields[2], `clear_reward[${row.key}].id`)
        const count = parseOptionalInteger(fields[3], `clear_reward[${row.key}].count`)
        if (id !== undefined) reward.id = id
        if (count !== undefined) reward.count = count
        output[row.key] = reward
    }
    return output
}

function convertScoreRewards(groups: readonly NestedOrderedMapTextRows[]): Record<string, unknown[]> {
    const output: Record<string, unknown[]> = {}
    for (const group of sortedGroups(groups)) {
        requireId(group.key, "score_reward group key")
        output[group.key] = sortedRows(group.rows).map(row => {
            const fields = parseRow(row, `score_reward[${group.key}]`, 8)
            const type = parseInteger(fields[1], `score_reward[${group.key}][${row.key}].type`)
            if (type === 0) {
                const reward: Record<string, unknown> = {
                    name: "",
                    position: parsePositiveInteger(row.key, "score reward position"),
                    type,
                    reward_type: parseInteger(fields[2], `score_reward[${group.key}][${row.key}].reward_type`),
                    count: parseInteger(fields[4], `score_reward[${group.key}][${row.key}].count`),
                    field5: parseInteger(fields[5], `score_reward[${group.key}][${row.key}].field5`),
                }
                const id = parseOptionalInteger(fields[3], `score_reward[${group.key}][${row.key}].id`)
                if (id !== undefined) reward.id = id
                return reward
            }
            if (type === 1) {
                return {
                    name: "",
                    position: parsePositiveInteger(row.key, "score reward position"),
                    type,
                    id: parsePositiveInteger(fields[6], `score_reward[${group.key}][${row.key}].id`),
                    rarity: parseFiniteNumber(fields[7], `score_reward[${group.key}][${row.key}].rarity`),
                }
            }
            return invalidReward(`score_reward[${group.key}][${row.key}].type is unsupported: ${type}`)
        })
    }
    return output
}

function convertRareScoreRewards(groups: readonly NestedOrderedMapTextRows[]): Record<string, unknown[]> {
    const output: Record<string, unknown[]> = {}
    for (const group of sortedGroups(groups)) {
        requireId(group.key, "rare_score_reward group key")
        output[group.key] = sortedRows(group.rows).map(row => {
            const fields = parseRow(row, `rare_score_reward[${group.key}]`, 6)
            const reward: Record<string, unknown> = {
                name: "",
                position: parsePositiveInteger(row.key, "rare score reward position"),
                type: parseInteger(fields[1], `rare_score_reward[${group.key}][${row.key}].type`),
                rarity: parseFiniteNumber(fields[4], `rare_score_reward[${group.key}][${row.key}].rarity`),
            }
            const id = parseOptionalInteger(fields[2], `rare_score_reward[${group.key}][${row.key}].id`)
            const count = parseOptionalInteger(fields[3], `rare_score_reward[${group.key}][${row.key}].count`)
            if (id !== undefined) reward.id = id
            if (count !== undefined) reward.count = count
            return reward
        })
    }
    return output
}

function convertBorderRewards(rows: readonly OrderedMapTextRow[]): Record<string, unknown[]> {
    const output: Record<string, Array<Record<string, unknown>>> = {}
    for (const row of sortedRows(rows)) {
        const fields = parseRow(row, "score_attack_border_reward", 24)
        const eventId = parsePositiveInteger(fields[1], `score_attack_border_reward[${row.key}].eventId`)
        const questId = parsePositiveInteger(fields[2], `score_attack_border_reward[${row.key}].questId`)
        const rewards: Array<Record<string, unknown>> = []
        for (let slot = 0; slot < 6; slot += 1) {
            const offset = 6 + slot * 3
            const kind = parseOptionalInteger(fields[offset], `score_attack_border_reward[${row.key}].rewards[${slot}].kind`)
            if (kind === undefined) continue
            const reward: Record<string, unknown> = {
                kind,
                amount: parseInteger(fields[offset + 2], `score_attack_border_reward[${row.key}].rewards[${slot}].amount`),
            }
            const id = parseOptionalInteger(fields[offset + 1], `score_attack_border_reward[${row.key}].rewards[${slot}].id`)
            if (id !== undefined) reward.id = id
            rewards.push(reward)
        }
        const key = `${eventId}_${questId}`
        const tiers = output[key] ?? []
        tiers.push({
            id: parsePositiveInteger(row.key, "score attack border reward id"),
            eventId,
            questId,
            score: parseFiniteNumber(fields[4], `score_attack_border_reward[${row.key}].score`),
            reasonId: parsePositiveInteger(fields[5], `score_attack_border_reward[${row.key}].reasonId`),
            rewards,
        })
        output[key] = tiers
    }
    for (const tiers of Object.values(output)) {
        tiers.sort((left, right) => (
            Number(left.score) - Number(right.score) || Number(left.id) - Number(right.id)
        ))
    }
    return output
}

function convertRushFolders(groups: readonly NestedOrderedMapTextRows[]): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const event of sortedGroups(groups)) {
        requireId(event.key, "rush_event_quest_folder event key")
        const folders: Record<string, unknown[]> = {}
        for (const row of sortedRows(event.rows)) {
            const fields = parseRow(row, `rush_event_quest_folder[${event.key}]`, 37)
            const rewards: Array<Record<string, unknown>> = []
            for (let slot = 0; slot < 10; slot += 1) {
                const offset = 7 + slot * 3
                const type = parseOptionalInteger(fields[offset], `rush_event_quest_folder[${event.key}][${row.key}].rewards[${slot}].type`)
                if (type === undefined) continue
                const reward: Record<string, unknown> = { type }
                const id = parseOptionalInteger(fields[offset + 1], `rush_event_quest_folder[${event.key}][${row.key}].rewards[${slot}].id`)
                const count = parseOptionalInteger(fields[offset + 2], `rush_event_quest_folder[${event.key}][${row.key}].rewards[${slot}].count`)
                if (id !== undefined) reward.id = id
                if (count !== undefined) reward.count = count
                rewards.push(reward)
            }
            folders[row.key] = rewards
        }
        output[event.key] = folders
    }
    return output
}

function convertRushRankingRewards(groups: readonly NestedOrderedMapTextRows[]): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const event of sortedGroups(groups)) {
        requireId(event.key, "rush_event_ranking_reward event key")
        const rankingGroups: Record<string, unknown[]> = {}
        for (const row of sortedRows(event.rows)) {
            const fields = parseRow(row, `rush_event_ranking_reward[${event.key}]`, 6)
            rankingGroups[row.key] = [{
                fromRank: parsePositiveInteger(fields[0], `rush_event_ranking_reward[${event.key}][${row.key}].fromRank`),
                toRank: parsePositiveInteger(fields[1], `rush_event_ranking_reward[${event.key}][${row.key}].toRank`),
                kind: parseInteger(fields[3], `rush_event_ranking_reward[${event.key}][${row.key}].kind`),
                kindId: parseInteger(fields[4], `rush_event_ranking_reward[${event.key}][${row.key}].kindId`),
                number: parseInteger(fields[5], `rush_event_ranking_reward[${event.key}][${row.key}].number`),
            }]
        }
        output[event.key] = rankingGroups
    }
    return output
}

export async function convertRewards(reader: RewardSourceReader): Promise<RewardConversionOutput> {
    const [clearRows, scoreGroups, rareGroups, borderRows, rushFolders, rushRanking] = await Promise.all([
        reader.read(CLEAR_REWARD_PATH),
        reader.readNested(SCORE_REWARD_PATH),
        reader.readNested(RARE_SCORE_REWARD_PATH),
        reader.read(SCORE_ATTACK_BORDER_PATH),
        reader.readNested(RUSH_QUEST_FOLDER_PATH),
        reader.readNested(RUSH_RANKING_REWARD_PATH),
    ])
    return deepFreeze({
        "clear_reward.json": convertClearRewards(clearRows),
        "score_reward.json": convertScoreRewards(scoreGroups),
        "rare_score_reward.json": convertRareScoreRewards(rareGroups),
        "score_attack_border_reward.json": convertBorderRewards(borderRows),
        "rush_event_quest_folder.json": convertRushFolders(rushFolders),
        "rush_event_ranking_reward.json": convertRushRankingRewards(rushRanking),
    })
}
