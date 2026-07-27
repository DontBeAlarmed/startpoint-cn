import { deepFreeze } from "../deep-freeze"
import {
    parseNestedOrderedMapRows,
    parseTextOrderedMap,
} from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

const MANA_NODE_PATH = "master/mana_board/mana_node.orderedmap"
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/

export interface ManaNodeSourceReader {
    readBytes(logicalPath: string): Promise<Buffer>
}

export interface ManaNodeConversionOutput {
    readonly "mana_node.json": Readonly<Record<string, unknown>>
}

function invalidManaNode(reason: string): never {
    throw new Error(`invalid mana node content: ${reason}`)
}

function compareIds(left: string, right: string): number {
    return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
}

function requireId(value: string, subject: string): string {
    if (!POSITIVE_INTEGER_PATTERN.test(value) || !Number.isSafeInteger(Number(value))) {
        invalidManaNode(`${subject} must be a canonical positive integer: ${value}`)
    }
    return value
}

function parseNonNegativeInteger(value: string, subject: string): number {
    if (!NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
        invalidManaNode(`${subject} must be a non-negative integer: ${value}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidManaNode(`${subject} must be a safe integer: ${value}`)
    return parsed
}

function parsePositiveInteger(value: string, subject: string): number {
    const parsed = parseNonNegativeInteger(value, subject)
    if (parsed === 0) invalidManaNode(`${subject} must be a positive integer: ${value}`)
    return parsed
}

function parseList(value: string): string[] {
    return value.split(",").map(entry => entry.trim())
}

export async function convertManaNodes(
    reader: ManaNodeSourceReader,
): Promise<ManaNodeConversionOutput> {
    const output: Record<string, unknown> = {}
    const characters = [...parseNestedOrderedMapRows(await reader.readBytes(MANA_NODE_PATH))]
        .sort((left, right) => compareIds(left.key, right.key))
    for (const character of characters) {
        const characterId = requireId(character.key, "mana_node character key")
        const convertedBoards: Record<string, unknown> = {}
        const boards = [...parseNestedOrderedMapRows(character.value)]
            .sort((left, right) => compareIds(left.key, right.key))
        for (const board of boards) {
            const boardId = requireId(board.key, `mana_node[${characterId}] board key`)
            const convertedNodes: Record<string, unknown> = {}
            const rows = [...parseTextOrderedMap(board.value)]
                .sort((left, right) => compareIds(left.key, right.key))
            for (const row of rows) {
                requireId(row.key, `mana_node[${characterId}][${boardId}] row key`)
                const fields = parseCsvLine(
                    row.text,
                    `mana_node[${characterId}][${boardId}][${row.key}]`,
                    invalidManaNode,
                )
                if (fields.length !== 7) {
                    invalidManaNode(
                        `mana_node[${characterId}][${boardId}][${row.key}] must have 7 columns`,
                    )
                }
                const nodeId = requireId(
                    fields[0],
                    `mana_node[${characterId}][${boardId}][${row.key}].nodeId`,
                )
                if (Object.prototype.hasOwnProperty.call(convertedNodes, nodeId)) {
                    invalidManaNode(`mana_node[${characterId}][${boardId}] has duplicate node ${nodeId}`)
                }
                const itemIds = parseList(fields[2])
                const itemCounts = parseList(fields[3])
                if (itemIds.length !== itemCounts.length) {
                    invalidManaNode(
                        `mana_node[${characterId}][${boardId}][${nodeId}] item and count list lengths differ`,
                    )
                }
                const items: Record<string, number> = {}
                for (let index = 0; index < itemIds.length; index += 1) {
                    const itemId = requireId(
                        itemIds[index],
                        `mana_node[${characterId}][${boardId}][${nodeId}].item[${index}].id`,
                    )
                    if (Object.prototype.hasOwnProperty.call(items, itemId)) {
                        invalidManaNode(
                            `mana_node[${characterId}][${boardId}][${nodeId}] has duplicate item ${itemId}`,
                        )
                    }
                    items[itemId] = parsePositiveInteger(
                        itemCounts[index],
                        `mana_node[${characterId}][${boardId}][${nodeId}].item[${index}].count`,
                    )
                }
                convertedNodes[nodeId] = {
                    items,
                    manaCost: parseNonNegativeInteger(
                        fields[4],
                        `mana_node[${characterId}][${boardId}][${nodeId}].manaCost`,
                    ),
                    field1: fields[1],
                    field5: fields[5],
                    field6: fields[6],
                }
            }
            convertedBoards[boardId] = convertedNodes
        }
        output[characterId] = convertedBoards
    }
    return deepFreeze({ "mana_node.json": output })
}
