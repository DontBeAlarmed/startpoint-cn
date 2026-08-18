import { deepFreeze } from "./deep-freeze"

export type ManaBoardParentIndex = Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, number | null>>>>>
>

const POSITIVE_INTEGER = /^[1-9]\d*$/

function invalid(reason: string): never {
    throw new Error(`invalid mana board parent content: ${reason}`)
}

function asRecord(value: unknown, subject: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        invalid(`${subject} must be an object`)
    }
    return value as Record<string, unknown>
}

function id(value: unknown, subject: string): number {
    if (typeof value !== "string" || !POSITIVE_INTEGER.test(value)) {
        invalid(`${subject} must be a canonical positive integer`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalid(`${subject} must be a safe integer`)
    return parsed
}

function parent(value: unknown, subject: string): number | null {
    return value === "(None)" ? null : id(value, subject)
}

function rejectParentCycles(
    characterKey: string,
    boardKey: string,
    nodes: Readonly<Record<string, number | null>>,
): void {
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (nodeKey: string): void => {
        if (visited.has(nodeKey)) return
        if (visiting.has(nodeKey)) {
            invalid(`character ${characterKey} board ${boardKey} contains a parent cycle at node ${nodeKey}`)
        }
        visiting.add(nodeKey)
        const parentId = nodes[nodeKey]
        if (parentId !== null) visit(String(parentId))
        visiting.delete(nodeKey)
        visited.add(nodeKey)
    }
    for (const nodeKey of Object.keys(nodes)) visit(nodeKey)
}

export function buildManaBoardParentIndex(value: unknown): ManaBoardParentIndex {
    const source = asRecord(value, "table")
    const result: Record<string, Record<string, Record<string, number | null>>> = {}
    for (const [characterKey, rawCharacter] of Object.entries(source)) {
        id(characterKey, "character key")
        const character = asRecord(rawCharacter, `character ${characterKey}`)
        const resultBoards: Record<string, Record<string, number | null>> = {}
        for (const [boardKey, rawBoard] of Object.entries(character)) {
            id(boardKey, `character ${characterKey} board key`)
            const board = asRecord(rawBoard, `character ${characterKey} board ${boardKey}`)
            const resultNodes: Record<string, number | null> = {}
            for (const [slotKey, rawRows] of Object.entries(board)) {
                id(slotKey, `character ${characterKey} board ${boardKey} slot key`)
                if (!Array.isArray(rawRows) || rawRows.length !== 1
                    || !Array.isArray(rawRows[0]) || rawRows[0].length !== 6) {
                    invalid(`character ${characterKey} board ${boardKey} slot ${slotKey} is malformed`)
                }
                const nodeId = id(rawRows[0][0], `slot ${slotKey} node id`)
                const nodeKey = String(nodeId)
                if (Object.prototype.hasOwnProperty.call(resultNodes, nodeKey)) {
                    invalid(`character ${characterKey} board ${boardKey} duplicates node ${nodeId}`)
                }
                resultNodes[nodeKey] = parent(rawRows[0][5], `node ${nodeId} parent`)
            }
            for (const [nodeKey, parentId] of Object.entries(resultNodes)) {
                if (parentId === Number(nodeKey)) invalid(`node ${nodeKey} must not reference itself`)
                if (parentId !== null
                    && !Object.prototype.hasOwnProperty.call(resultNodes, String(parentId))) {
                    invalid(`node ${nodeKey} parent ${parentId} must exist on the same board`)
                }
            }
            rejectParentCycles(characterKey, boardKey, resultNodes)
            resultBoards[boardKey] = resultNodes
        }
        result[characterKey] = resultBoards
    }
    return deepFreeze(result)
}
