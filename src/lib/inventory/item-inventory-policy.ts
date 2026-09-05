import { deepFreeze } from "../../content/deep-freeze"
import { getStrictRuntimeContentTableSync } from "../../content/runtime/table-access"

export type ItemEffectKindCode =
    | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
    | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17
    | 18 | 19 | 20 | 21 | 22

export interface ItemInventoryPolicy {
    readonly effectKind: ItemEffectKindCode
    readonly category: number
    readonly salePrice: number
    readonly maxCount: number
    readonly sellable: boolean
    readonly startTimeMs: number
    readonly endTimeMs: number | null
}

export interface ItemInventoryPolicyCatalog {
    readonly byItemId: Readonly<Record<string, ItemInventoryPolicy>>
    readonly eventTradeItemIds: readonly number[]
}

const POLICY_FIELDS = [
    "category",
    "effectKind",
    "endTimeMs",
    "maxCount",
    "salePrice",
    "sellable",
    "startTimeMs",
] as const
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const CN_CONTENT_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
const CN_CONTENT_MAX_EPOCH_MS = Date.UTC(9999, 11, 31, 23, 59, 59)
    - CN_CONTENT_UTC_OFFSET_MS
const parsedCatalogs = new WeakMap<object, ItemInventoryPolicyCatalog>()

function invalidCatalog(reason: string): never {
    throw new TypeError(`invalid item inventory policy catalog: ${reason}`)
}

function requireObject(value: unknown, subject: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        invalidCatalog(`${subject} must be an object`)
    }
    return value as Record<string, unknown>
}

function requireNonNegativeSafeInteger(value: unknown, subject: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        invalidCatalog(`${subject} must be a non-negative safe integer`)
    }
    return value as number
}

function requireRuntimeEpochMs(value: unknown, subject: string): number {
    const epochMs = requireNonNegativeSafeInteger(value, subject)
    if (epochMs % 1000 !== 0) {
        invalidCatalog(`${subject} must have second precision`)
    }
    if (epochMs > CN_CONTENT_MAX_EPOCH_MS) {
        invalidCatalog(`${subject} exceeds the UTC+8 four-digit year range`)
    }
    return epochMs
}

function parsePolicy(itemId: string, value: unknown): ItemInventoryPolicy {
    const policy = requireObject(value, `byItemId[${itemId}]`)
    const fields = Object.keys(policy).sort()
    if (fields.length !== POLICY_FIELDS.length
        || fields.some((field, index) => field !== POLICY_FIELDS[index])) {
        invalidCatalog(`byItemId[${itemId}] has an invalid shape`)
    }
    const effectKind = requireNonNegativeSafeInteger(
        policy.effectKind,
        `byItemId[${itemId}].effectKind`,
    )
    if (effectKind > 22) {
        invalidCatalog(`byItemId[${itemId}].effectKind must be an integer from 0 through 22`)
    }
    const category = requireNonNegativeSafeInteger(
        policy.category,
        `byItemId[${itemId}].category`,
    )
    const salePrice = requireNonNegativeSafeInteger(
        policy.salePrice,
        `byItemId[${itemId}].salePrice`,
    )
    const maxCount = requireNonNegativeSafeInteger(
        policy.maxCount,
        `byItemId[${itemId}].maxCount`,
    )
    if (maxCount <= 0) invalidCatalog(`byItemId[${itemId}].maxCount must be positive`)
    if (typeof policy.sellable !== "boolean") {
        invalidCatalog(`byItemId[${itemId}].sellable must be a boolean`)
    }
    const startTimeMs = requireRuntimeEpochMs(
        policy.startTimeMs,
        `byItemId[${itemId}].startTimeMs`,
    )
    const endTimeMs = policy.endTimeMs === null
        ? null
        : requireRuntimeEpochMs(
            policy.endTimeMs,
            `byItemId[${itemId}].endTimeMs`,
        )
    if (endTimeMs !== null && endTimeMs < startTimeMs) {
        invalidCatalog(`byItemId[${itemId}] has an inverted time window`)
    }
    if (effectKind === 9 && salePrice <= 0) {
        invalidCatalog(`byItemId[${itemId}].salePrice must be positive for EventTrade`)
    }
    return {
        effectKind: effectKind as ItemEffectKindCode,
        category,
        salePrice,
        maxCount,
        sellable: policy.sellable,
        startTimeMs,
        endTimeMs,
    }
}

export function parseItemInventoryPolicyCatalog(raw: unknown): ItemInventoryPolicyCatalog {
    const root = requireObject(raw, "root")
    const cached = parsedCatalogs.get(root)
    if (cached) return cached
    const rootFields = Object.keys(root).sort()
    if (rootFields.length !== 2
        || rootFields[0] !== "byItemId"
        || rootFields[1] !== "eventTradeItemIds") {
        invalidCatalog("root must contain only byItemId and eventTradeItemIds")
    }
    const rawByItemId = requireObject(root.byItemId, "byItemId")
    const byItemId: Record<string, ItemInventoryPolicy> = {}
    const expectedEventTradeIds: number[] = []
    for (const itemId of Object.keys(rawByItemId).sort((left, right) => (
        left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
    ))) {
        if (!POSITIVE_INTEGER_PATTERN.test(itemId) || !Number.isSafeInteger(Number(itemId))) {
            invalidCatalog(`byItemId key must be a canonical positive safe integer: ${itemId}`)
        }
        const policy = parsePolicy(itemId, rawByItemId[itemId])
        byItemId[itemId] = policy
        if (policy.effectKind === 9) expectedEventTradeIds.push(Number(itemId))
    }
    if (!Array.isArray(root.eventTradeItemIds)) {
        invalidCatalog("eventTradeItemIds must be an array")
    }
    const eventTradeItemIds = root.eventTradeItemIds.map((value, index) => {
        if (!Number.isSafeInteger(value) || (value as number) <= 0) {
            invalidCatalog(`eventTradeItemIds[${index}] must be a positive safe integer`)
        }
        return value as number
    })
    if (eventTradeItemIds.length !== expectedEventTradeIds.length
        || eventTradeItemIds.some((itemId, index) => itemId !== expectedEventTradeIds[index])) {
        invalidCatalog("eventTradeItemIds must exactly match EventTrade policies in ascending order")
    }
    const catalog = deepFreeze({ byItemId, eventTradeItemIds })
    parsedCatalogs.set(root, catalog)
    return catalog
}

export function getItemInventoryPolicyCatalog(): ItemInventoryPolicyCatalog {
    const raw = getStrictRuntimeContentTableSync<unknown>("item_inventory_policy.json")
    return parseItemInventoryPolicyCatalog(raw)
}

export function findItemInventoryPolicy(
    catalog: ItemInventoryPolicyCatalog,
    itemId: number,
): ItemInventoryPolicy | null {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
        throw new TypeError("itemId must be a positive safe integer")
    }
    return catalog.byItemId[String(itemId)] ?? null
}
