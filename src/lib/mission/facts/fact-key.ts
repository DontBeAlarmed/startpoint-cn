export type FactIdSelection = "all" | readonly number[]
type NonPassPeriodicKind = "daily" | "weekly"
export type PeriodicSnapshotKind = NonPassPeriodicKind | "passWeek"

const SINGLETON_KINDS = [
    "player",
    "characters",
    "characterManaNodes",
    "characterManaNodeAwakeLevels",
    "equipment",
    "items",
    "missionBattleCounters",
    "degreeBattleStats",
    "characterClearCounters",
    "partyCoClearCounters",
    "awakeEligibility",
] as const

type SingletonFactKind = typeof SINGLETON_KINDS[number]
type SingletonFactKey = {
    [Kind in SingletonFactKind]: Readonly<{ kind: Kind }>
}[SingletonFactKind]

type NonPassPeriodicFactKey = {
    [Kind in NonPassPeriodicKind]: Readonly<{
        kind: "periodicSnapshot"
        snapshotKind: Kind
    }>
}[NonPassPeriodicKind]

type PeriodicSnapshotFactKey =
    | NonPassPeriodicFactKey
    | Readonly<{ kind: "periodicSnapshot"; snapshotKind: "passWeek"; eventId: number }>

export type FactKey =
    | SingletonFactKey
    | Readonly<{ kind: "collectedItems"; itemIds: FactIdSelection }>
    | Readonly<{ kind: "questProgress"; sections: FactIdSelection }>
    | Readonly<{
        kind: "categoryMissionProgress"
        category: number
        missionIds: readonly number[]
    }>
    | Readonly<{ kind: "partyGroups"; category: number }>
    | Readonly<{ kind: "shopPurchases"; shopType: number }>
    | PeriodicSnapshotFactKey
    | Readonly<{ kind: "passState"; eventId: number }>

type Assert<T extends true> = T
type IsNever<T> = [T] extends [never] ? true : false
type PlayerFactKeyIsExtractable = Assert<IsNever<Extract<FactKey, { kind: "player" }>> extends false ? true : false>
type DailyPeriodicFactKeyIsExtractable = Assert<IsNever<Extract<FactKey, {
    kind: "periodicSnapshot"
    snapshotKind: "daily"
}>> extends false ? true : false>
type WeeklyPeriodicFactKeyIsExtractable = Assert<IsNever<Extract<FactKey, {
    kind: "periodicSnapshot"
    snapshotKind: "weekly"
}>> extends false ? true : false>
type PassWeekPeriodicFactKeyIsExtractable = Assert<IsNever<Extract<FactKey, {
    kind: "periodicSnapshot"
    snapshotKind: "passWeek"
}>> extends false ? true : false>

const SINGLETON_KIND_SET: ReadonlySet<string> = new Set(SINGLETON_KINDS)

function isSingletonFactKind(kind: string): kind is SingletonFactKind {
    return SINGLETON_KIND_SET.has(kind)
}

function positiveSafeInteger(value: unknown, kind: string, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${kind}.${field} must be a positive safe integer`)
    }
    return value
}

function normalizeSelection(
    value: unknown,
    kind: "collectedItems" | "questProgress" | "categoryMissionProgress",
    field: "itemIds" | "sections" | "missionIds",
): FactIdSelection {
    if (value === "all") return "all"
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${kind}.${field} must be all or a plain array`)
    }
    if (value.length === 0) {
        throw new TypeError(`${kind}.${field} array must not be empty`)
    }

    for (const ownKey of Reflect.ownKeys(value)) {
        if (ownKey === "length") continue
        const index = typeof ownKey === "string" ? Number(ownKey) : Number.NaN
        if (!Number.isInteger(index)
            || index < 0
            || index >= value.length
            || String(index) !== ownKey) {
            throw new TypeError(`${kind}.${field} has unexpected field ${String(ownKey)}`)
        }
    }

    const values: number[] = []
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined
            || !descriptor.enumerable
            || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
            throw new TypeError(`${kind}.${field}[${index}] must be an own enumerable data property`)
        }
        values.push(positiveSafeInteger(descriptor.value, kind, field))
    }
    return Object.freeze([...new Set(values)].sort((left, right) => left - right))
}

function runtimeKey(key: unknown): { candidate: object; kind: string } {
    if (key === null || typeof key !== "object" || Array.isArray(key)) {
        throw new TypeError("FactKey.kind is unknown")
    }
    const prototype = Object.getPrototypeOf(key)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("FactKey input must be a plain object")
    }
    const kindDescriptor = Object.getOwnPropertyDescriptor(key, "kind")
    if (kindDescriptor === undefined
        || !kindDescriptor.enumerable
        || typeof kindDescriptor.value !== "string") {
        throw new TypeError("FactKey.kind must be an own enumerable string property")
    }
    return { candidate: key, kind: kindDescriptor.value }
}

function assertExactOwnKeys(candidate: object, kind: string, allowed: readonly string[]): void {
    for (const field of Reflect.ownKeys(candidate)) {
        if (typeof field !== "string" || !allowed.includes(field)) {
            throw new TypeError(`${kind} has unexpected field ${String(field)}`)
        }
    }
}

function getOwnEnumerableDataValue(candidate: object, kind: string, field: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, field)
    if (descriptor === undefined
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")
        || Object.prototype.hasOwnProperty.call(descriptor, "get")
        || Object.prototype.hasOwnProperty.call(descriptor, "set")) {
        throw new TypeError(`${kind}.${field} must be an own enumerable data property`)
    }
    return descriptor.value
}

export function normalizeFactKey(key: FactKey): FactKey {
    const { candidate, kind } = runtimeKey(key)

    if (isSingletonFactKind(kind)) {
        assertExactOwnKeys(candidate, kind, ["kind"])
        return Object.freeze({ kind })
    }

    switch (kind) {
        case "collectedItems":
            assertExactOwnKeys(candidate, kind, ["kind", "itemIds"])
            return Object.freeze({
                kind,
                itemIds: normalizeSelection(
                    getOwnEnumerableDataValue(candidate, kind, "itemIds"),
                    kind,
                    "itemIds",
                ),
            })
        case "questProgress":
            assertExactOwnKeys(candidate, kind, ["kind", "sections"])
            return Object.freeze({
                kind,
                sections: normalizeSelection(
                    getOwnEnumerableDataValue(candidate, kind, "sections"),
                    kind,
                    "sections",
                ),
            })
        case "categoryMissionProgress":
            assertExactOwnKeys(candidate, kind, ["kind", "category", "missionIds"])
            const missionIds = normalizeSelection(
                getOwnEnumerableDataValue(candidate, kind, "missionIds"),
                kind,
                "missionIds",
            )
            if (missionIds === "all") {
                throw new TypeError(`${kind}.missionIds must be a plain array`)
            }
            return Object.freeze({
                kind,
                category: positiveSafeInteger(
                    getOwnEnumerableDataValue(candidate, kind, "category"),
                    kind,
                    "category",
                ),
                missionIds,
            })
        case "partyGroups":
            assertExactOwnKeys(candidate, kind, ["kind", "category"])
            return Object.freeze({
                kind,
                category: positiveSafeInteger(
                    getOwnEnumerableDataValue(candidate, kind, "category"),
                    kind,
                    "category",
                ),
            })
        case "shopPurchases":
            assertExactOwnKeys(candidate, kind, ["kind", "shopType"])
            return Object.freeze({
                kind,
                shopType: positiveSafeInteger(
                    getOwnEnumerableDataValue(candidate, kind, "shopType"),
                    kind,
                    "shopType",
                ),
            })
        case "periodicSnapshot": {
            assertExactOwnKeys(candidate, kind, ["kind", "snapshotKind", "eventId"])
            const snapshotKind = getOwnEnumerableDataValue(candidate, kind, "snapshotKind")
            if (snapshotKind !== "daily" && snapshotKind !== "weekly" && snapshotKind !== "passWeek") {
                throw new TypeError(`${kind}.snapshotKind must be daily, weekly, or passWeek`)
            }
            if (snapshotKind === "passWeek") {
                return Object.freeze({
                    kind,
                    snapshotKind,
                    eventId: positiveSafeInteger(
                        getOwnEnumerableDataValue(candidate, kind, "eventId"),
                        kind,
                        "eventId",
                    ),
                })
            }
            assertExactOwnKeys(candidate, kind, ["kind", "snapshotKind"])
            return Object.freeze({ kind, snapshotKind })
        }
        case "passState":
            assertExactOwnKeys(candidate, kind, ["kind", "eventId"])
            return Object.freeze({
                kind,
                eventId: positiveSafeInteger(
                    getOwnEnumerableDataValue(candidate, kind, "eventId"),
                    kind,
                    "eventId",
                ),
            })
        default:
            throw new TypeError(`unknown FactKey kind: ${String(kind)}`)
    }
}

export function getFactKeyId(key: FactKey): string {
    const normalized = normalizeFactKey(key)
    switch (normalized.kind) {
        case "collectedItems":
            return `${normalized.kind}:${normalized.itemIds === "all" ? "all" : normalized.itemIds.join(",")}`
        case "questProgress":
            return `${normalized.kind}:${normalized.sections === "all" ? "all" : normalized.sections.join(",")}`
        case "categoryMissionProgress":
            return `${normalized.kind}:${normalized.category}:${normalized.missionIds.join(",")}`
        case "partyGroups":
            return `${normalized.kind}:${normalized.category}`
        case "shopPurchases":
            return `${normalized.kind}:${normalized.shopType}`
        case "periodicSnapshot":
            return normalized.snapshotKind === "passWeek"
                ? `${normalized.kind}:${normalized.snapshotKind}:${normalized.eventId}`
                : `${normalized.kind}:${normalized.snapshotKind}`
        case "passState":
            return `${normalized.kind}:${normalized.eventId}`
        default:
            return normalized.kind
    }
}
