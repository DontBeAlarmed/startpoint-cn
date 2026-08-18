import {
    getManaNodeRequiredLevel,
    parseLevelRequiredManaNodeTable,
} from "../content/character-mana-admission"
import type {
    BaseManaNodeMutationInput,
    CharacterManaMutationSnapshot,
    ManaNodeMutationCost,
    ManaNodeMutationErrorCode,
    ManaNodeMutationNode,
} from "./character-mana-mutation-types"
import { ManaNodeMutationValidationError } from "./character-mana-mutation-types"

const POSITIVE_INTEGER = /^[1-9]\d*$/

function fail(
    code: ConstructorParameters<typeof ManaNodeMutationValidationError>[0],
    message: string,
): never {
    throw new ManaNodeMutationValidationError(code, message)
}

function record(value: unknown, subject: string, code: "CONTENT_INVALID" | "SNAPSHOT_INVALID"):
Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(code, `${subject} must be an object`)
    }
    return value as Record<string, unknown>
}

function positiveNumber(
    value: unknown,
    subject: string,
    code: ManaNodeMutationErrorCode = "CONTENT_INVALID",
): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        fail(code, `${subject} must be a positive safe integer`)
    }
    return value
}

function canonicalKey(
    value: string,
    subject: string,
    code: "CONTENT_INVALID" | "SNAPSHOT_INVALID" = "CONTENT_INVALID",
): number {
    if (!POSITIVE_INTEGER.test(value)) fail(code, `${subject} must be canonical`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) fail(code, `${subject} must be safe`)
    return parsed
}

function nonNegative(value: unknown, subject: string, code: "CONTENT_INVALID" | "SNAPSHOT_INVALID"):
number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        fail(code, `${subject} must be a non-negative safe integer`)
    }
    return value
}

export function validateRequestedNodeIds(value: unknown): readonly number[] {
    if (!Array.isArray(value) || value.length === 0) fail("INVALID_REQUEST", "node ids must not be empty")
    const result: number[] = []
    const seen = new Set<number>()
    for (const rawId of value) {
        if (typeof rawId !== "number" || !Number.isSafeInteger(rawId) || rawId <= 0) {
            fail("INVALID_REQUEST", "node ids must be positive safe integers")
        }
        if (seen.has(rawId)) fail("DUPLICATE_NODE", `node ${rawId} is duplicated`)
        seen.add(rawId)
        result.push(rawId)
    }
    return result
}

function parseCost(value: unknown, subject: string): ManaNodeMutationCost {
    const source = record(value, subject, "CONTENT_INVALID")
    const manaCost = nonNegative(source.manaCost, `${subject}.manaCost`, "CONTENT_INVALID")
    const rawItems = record(source.items, `${subject}.items`, "CONTENT_INVALID")
    const items: Record<string, number> = {}
    for (const [itemKey, rawAmount] of Object.entries(rawItems)) {
        const itemId = canonicalKey(itemKey, `${subject} item id`)
        const amount = positiveNumber(rawAmount, `${subject} item ${itemId} amount`)
        items[String(itemId)] = amount
    }
    return { manaCost, items }
}

export interface ValidatedMutationInput {
    readonly requestedNodeIds: readonly number[]
    readonly nodes: Readonly<Record<string, ManaNodeMutationNode>>
    readonly parents: Readonly<Record<string, number | null>>
    readonly snapshot: CharacterManaMutationSnapshot
}

export function validateMutationInput(input: BaseManaNodeMutationInput): ValidatedMutationInput {
    if (input.content === null
        || typeof input.content !== "object"
        || Array.isArray(input.content)) {
        fail("INVALID_REQUEST", "content is required")
    }
    if (input.snapshot === null
        || typeof input.snapshot !== "object"
        || Array.isArray(input.snapshot)) {
        fail("INVALID_REQUEST", "snapshot is required")
    }
    for (const [subject, value] of [
        ["character id", input.characterId],
        ["board id", input.boardId],
        ["character level", input.characterLevel],
    ] as const) positiveNumber(value, subject, "INVALID_REQUEST")
    if (!Number.isSafeInteger(input.characterRarity)
        || input.characterRarity < 1 || input.characterRarity > 5) {
        fail("INVALID_REQUEST", "character rarity must be 1 through 5")
    }
    if (input.content.characterId !== input.characterId
        || input.content.boardId !== input.boardId) {
        fail("CONTENT_SCOPE_MISMATCH", "content does not match character and board")
    }
    const requestedNodeIds = validateRequestedNodeIds(input.requestedNodeIds)
    const rawNodes = record(input.content.nodes, "content nodes", "CONTENT_INVALID")
    const rawParents = record(input.content.parents, "content parents", "CONTENT_INVALID")
    if (Object.keys(rawNodes).sort().join(",") !== Object.keys(rawParents).sort().join(",")) {
        fail("CONTENT_INVALID", "node and parent keys differ")
    }
    const nodes: Record<string, ManaNodeMutationNode> = {}
    const parents: Record<string, number | null> = {}
    for (const [nodeKey, rawNode] of Object.entries(rawNodes)) {
        const nodeId = canonicalKey(nodeKey, "content node id")
        const source = record(rawNode, `node ${nodeId}`, "CONTENT_INVALID")
        const cost = parseCost(source, `node ${nodeId}`)
        if (typeof source.field1 !== "string"
            || typeof source.field5 !== "string"
            || typeof source.field6 !== "string") {
            fail("CONTENT_INVALID", `node ${nodeId} semantic fields are invalid`)
        }
        nodes[nodeKey] = { ...cost, field1: source.field1, field5: source.field5, field6: source.field6 }
        const rawParent = rawParents[nodeKey]
        parents[nodeKey] = rawParent === null
            ? null
            : positiveNumber(rawParent, `node ${nodeId} parent`)
    }
    for (const [nodeKey, parent] of Object.entries(parents)) {
        if (parent === Number(nodeKey) || (parent !== null && !nodes[String(parent)])) {
            fail("CONTENT_INVALID", `node ${nodeKey} parent is invalid`)
        }
    }
    let requirements
    try {
        requirements = parseLevelRequiredManaNodeTable(input.content.levelRequirements)
    } catch (error) {
        fail("CONTENT_INVALID", error instanceof Error ? error.message : String(error))
    }
    for (const nodeId of requestedNodeIds) {
        const node = nodes[String(nodeId)]
        if (!node) fail("UNKNOWN_NODE", `node ${nodeId} is not on the current board`)
        let requiredLevel: number | null
        try {
            requiredLevel = getManaNodeRequiredLevel(requirements, input.characterRarity, node)
        } catch (error) {
            fail("CONTENT_INVALID", error instanceof Error ? error.message : String(error))
        }
        if (requiredLevel !== null && input.characterLevel < requiredLevel) {
            fail("LEVEL_REQUIRED", `node ${nodeId} requires level ${requiredLevel}`)
        }
    }
    const snapshotItems = record(input.snapshot.items, "snapshot items", "SNAPSHOT_INVALID")
    const snapshotLevels = record(
        input.snapshot.nodeAwakeLevels,
        "snapshot node awake levels",
        "SNAPSHOT_INVALID",
    )
    const items: Record<string, number> = {}
    const levels: Record<string, number> = {}
    for (const [itemKey, amount] of Object.entries(snapshotItems)) {
        const itemId = canonicalKey(itemKey, "snapshot item id", "SNAPSHOT_INVALID")
        items[String(itemId)] = nonNegative(amount, `snapshot item ${itemId}`, "SNAPSHOT_INVALID")
    }
    for (const [nodeKey, level] of Object.entries(snapshotLevels)) {
        const nodeId = canonicalKey(nodeKey, "snapshot node id", "SNAPSHOT_INVALID")
        levels[String(nodeId)] = nonNegative(level, `snapshot node ${nodeId}`, "SNAPSHOT_INVALID")
    }
    return {
        requestedNodeIds,
        nodes,
        parents,
        snapshot: {
            mana: nonNegative(input.snapshot.mana, "snapshot mana", "SNAPSHOT_INVALID"),
            items,
            nodeAwakeLevels: levels,
        },
    }
}

export function validateAwakeCost(value: unknown, nodeId: number): ManaNodeMutationCost {
    if (value === undefined) fail("AWAKE_COST_MISSING", `node ${nodeId} has no awake cost`)
    return parseCost(value, `node ${nodeId} awake cost`)
}

export function safeAdd(left: number, right: number, subject: string): number {
    const result = left + right
    if (!Number.isSafeInteger(result)) fail("COST_OVERFLOW", `${subject} exceeds safe integer range`)
    return result
}
