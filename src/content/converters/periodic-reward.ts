import { deepFreeze } from "../deep-freeze"
import {
    convertOrderedMapJson,
    type CsvOrderedMapTree,
} from "./ordered-map-json"

export const PERIODIC_REWARD_TABLE_SOURCES = Object.freeze({
    "hard_multi_event.json": {
        logicalPath: "master/quest/event/hard_multi_event.orderedmap",
        nestingDepth: 1,
    },
    "periodic_reward.json": {
        logicalPath: "master/reward/periodic_reward.orderedmap",
        nestingDepth: 2,
    },
    "periodic_reward_point.json": {
        logicalPath: "master/reward/periodic_reward_point.orderedmap",
        nestingDepth: 1,
    },
} as const)

export interface PeriodicRewardSourceReader {
    readDynamic(logicalPath: string): Promise<Buffer>
}

export interface PeriodicRewardConversionOutput {
    readonly "hard_multi_event.json": Readonly<Record<string, unknown>>
    readonly "periodic_reward.json": Readonly<Record<string, unknown>>
    readonly "periodic_reward_point.json": Readonly<Record<string, unknown>>
}

export interface PeriodicRewardTrees {
    readonly hardMultiEvents: CsvOrderedMapTree
    readonly periodicRewards: CsvOrderedMapTree
    readonly periodicRewardPoints: CsvOrderedMapTree
}

const INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

function invalidPeriodicReward(reason: string): never {
    throw new Error(`invalid periodic reward content: ${reason}`)
}

function parseInteger(value: string | undefined, subject: string): number {
    if (value === undefined || !INTEGER_PATTERN.test(value)) {
        invalidPeriodicReward(`${subject} must be an integer: ${String(value)}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidPeriodicReward(`${subject} must be a safe integer`)
    return parsed
}

function parsePositiveInteger(value: string | undefined, subject: string): number {
    const parsed = parseInteger(value, subject)
    if (parsed <= 0) invalidPeriodicReward(`${subject} must be positive`)
    return parsed
}

function parseNonNegativeInteger(value: string | undefined, subject: string): number {
    const parsed = parseInteger(value, subject)
    if (parsed < 0) invalidPeriodicReward(`${subject} must not be negative`)
    return parsed
}

function parseOptionalPositiveInteger(value: string | undefined, subject: string): number | undefined {
    if (value === undefined || value === "" || value === "(None)") return undefined
    return parsePositiveInteger(value, subject)
}

function parseProbability(value: string | undefined, subject: string): number {
    if (value === undefined || value === "" || value.trim() !== value) {
        invalidPeriodicReward(`${subject} must be a probability`)
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        invalidPeriodicReward(`${subject} must be between 0 and 1`)
    }
    return parsed
}

function requireSingleRow(
    tableName: string,
    key: string,
    node: CsvOrderedMapTree[string],
    columns: number,
): readonly string[] {
    if (!Array.isArray(node) || node.length !== 1 || !Array.isArray(node[0])) {
        invalidPeriodicReward(`${tableName}[${key}] must contain exactly one row`)
    }
    const fields = node[0] as readonly string[]
    if (fields.length !== columns) {
        invalidPeriodicReward(`${tableName}[${key}] must have ${columns} columns, got ${fields.length}`)
    }
    return fields
}

function sortedIds(tree: CsvOrderedMapTree, tableName: string): string[] {
    const ids = Object.keys(tree)
    for (const id of ids) {
        if (!POSITIVE_INTEGER_PATTERN.test(id)) {
            invalidPeriodicReward(`${tableName} key must be a positive integer: ${id}`)
        }
    }
    return ids.sort((left, right) => left.length - right.length || left.localeCompare(right))
}

function requireNestedTree(
    tableName: string,
    key: string,
    node: CsvOrderedMapTree[string],
): CsvOrderedMapTree {
    if (Array.isArray(node)) {
        invalidPeriodicReward(`${tableName}[${key}] must contain indexed rewards`)
    }
    return node as CsvOrderedMapTree
}

function convertHardMultiEvents(tree: CsvOrderedMapTree): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const eventId of sortedIds(tree, "hard_multi_event")) {
        const fields = requireSingleRow("hard_multi_event", eventId, tree[eventId], 26)
        const periodicPointId = parseOptionalPositiveInteger(
            fields[14],
            `hard_multi_event[${eventId}].periodicPointId`,
        )
        output[eventId] = periodicPointId === undefined ? {} : { periodicPointId }
    }
    return output
}

function convertPeriodicRewardPoints(tree: CsvOrderedMapTree): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const pointId of sortedIds(tree, "periodic_reward_point")) {
        const fields = requireSingleRow("periodic_reward_point", pointId, tree[pointId], 9)
        output[pointId] = {
            maxPoint: parsePositiveInteger(fields[1], `periodic_reward_point[${pointId}].maxPoint`),
            recoveryPoint: parseNonNegativeInteger(
                fields[2],
                `periodic_reward_point[${pointId}].recoveryPoint`,
            ),
            recoveryCycle: parseNonNegativeInteger(
                fields[3],
                `periodic_reward_point[${pointId}].recoveryCycle`,
            ),
        }
    }
    return output
}

function convertPeriodicRewardTable(tree: CsvOrderedMapTree): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const groupId of sortedIds(tree, "periodic_reward")) {
        const group = requireNestedTree("periodic_reward", groupId, tree[groupId])
        const rewards: Record<string, unknown> = {}
        for (const index of sortedIds(group, `periodic_reward[${groupId}]`)) {
            const fields = requireSingleRow(
                `periodic_reward[${groupId}]`,
                index,
                group[index],
                5,
            )
            rewards[index] = {
                kind: parseNonNegativeInteger(
                    fields[1],
                    `periodic_reward[${groupId}][${index}].kind`,
                ),
                itemId: parsePositiveInteger(
                    fields[2],
                    `periodic_reward[${groupId}][${index}].itemId`,
                ),
                count: parsePositiveInteger(
                    fields[3],
                    `periodic_reward[${groupId}][${index}].count`,
                ),
                probability: parseProbability(
                    fields[4],
                    `periodic_reward[${groupId}][${index}].probability`,
                ),
            }
        }
        output[groupId] = rewards
    }
    return output
}

export function convertPeriodicRewardTrees(
    trees: PeriodicRewardTrees,
): PeriodicRewardConversionOutput {
    return deepFreeze({
        "hard_multi_event.json": convertHardMultiEvents(trees.hardMultiEvents),
        "periodic_reward.json": convertPeriodicRewardTable(trees.periodicRewards),
        "periodic_reward_point.json": convertPeriodicRewardPoints(trees.periodicRewardPoints),
    })
}

export async function convertPeriodicRewards(
    reader: PeriodicRewardSourceReader,
): Promise<PeriodicRewardConversionOutput> {
    const [hardMultiEvents, periodicRewards, periodicRewardPoints] = await Promise.all([
        reader.readDynamic(PERIODIC_REWARD_TABLE_SOURCES["hard_multi_event.json"].logicalPath),
        reader.readDynamic(PERIODIC_REWARD_TABLE_SOURCES["periodic_reward.json"].logicalPath),
        reader.readDynamic(PERIODIC_REWARD_TABLE_SOURCES["periodic_reward_point.json"].logicalPath),
    ])
    return convertPeriodicRewardTrees({
        hardMultiEvents: convertOrderedMapJson(hardMultiEvents, 1),
        periodicRewards: convertOrderedMapJson(periodicRewards, 2),
        periodicRewardPoints: convertOrderedMapJson(periodicRewardPoints, 1),
    })
}
