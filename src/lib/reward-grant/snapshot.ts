import {
    RewardGrantContractValidationError,
    type RewardGrantObjectSnapshot,
    type RewardGrantSnapshot,
} from "./execution-contract"

function invalidSnapshot(entryIndex: number, message?: string): never {
    throw new RewardGrantContractValidationError(entryIndex, "snapshot", message)
}

function isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function copyDenseArray(
    value: readonly unknown[],
    entryIndex: number,
    active: WeakSet<object>,
): readonly RewardGrantSnapshot[] {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.includes("length")) {
        invalidSnapshot(entryIndex, "RewardGrant arrays must contain only dense indices")
    }
    const copied: RewardGrantSnapshot[] = []
    for (let index = 0; index < value.length; index++) {
        const key = String(index)
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            invalidSnapshot(entryIndex, "RewardGrant arrays must be dense")
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            invalidSnapshot(entryIndex, "RewardGrant array entries must be enumerable data properties")
        }
        copied.push(copySnapshot(descriptor.value, entryIndex, active))
    }
    return Object.freeze(copied)
}

function copyPlainObject(
    value: object,
    entryIndex: number,
    active: WeakSet<object>,
): RewardGrantObjectSnapshot {
    if (!isPlainObject(value)) invalidSnapshot(entryIndex)
    const copied: Record<string, RewardGrantSnapshot> = {}
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
            invalidSnapshot(entryIndex, "RewardGrant snapshots do not support symbol keys")
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            invalidSnapshot(entryIndex, "RewardGrant snapshots require enumerable data properties")
        }
        Object.defineProperty(copied, key, {
            configurable: false,
            enumerable: true,
            writable: false,
            value: copySnapshot(descriptor.value, entryIndex, active),
        })
    }
    return Object.freeze(copied)
}

function copySnapshot(
    value: unknown,
    entryIndex: number,
    active: WeakSet<object>,
): RewardGrantSnapshot {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") {
        if (!Number.isFinite(value)) invalidSnapshot(entryIndex)
        return value
    }
    if (typeof value !== "object") invalidSnapshot(entryIndex)
    if (active.has(value)) invalidSnapshot(entryIndex, "Circular RewardGrant snapshot")
    active.add(value)
    try {
        return Array.isArray(value)
            ? copyDenseArray(value, entryIndex, active)
            : copyPlainObject(value, entryIndex, active)
    } finally {
        active.delete(value)
    }
}

export function copyRewardGrantSnapshot(
    value: unknown,
    entryIndex: number,
): RewardGrantSnapshot {
    try {
        return copySnapshot(value, entryIndex, new WeakSet())
    } catch (error) {
        if (error instanceof RewardGrantContractValidationError) throw error
        invalidSnapshot(entryIndex)
    }
}

export function copyRewardGrantObjectSnapshot(
    value: unknown,
    entryIndex: number,
): RewardGrantObjectSnapshot {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            invalidSnapshot(entryIndex, "RewardGrant asset after-state must be a plain object")
        }
        return copyRewardGrantSnapshot(value, entryIndex) as RewardGrantObjectSnapshot
    } catch (error) {
        if (error instanceof RewardGrantContractValidationError) throw error
        invalidSnapshot(entryIndex)
    }
}

function hasDenseArrayShape(value: readonly unknown[]): boolean {
    try {
        const keys = Reflect.ownKeys(value)
        if (keys.length !== value.length + 1 || !keys.includes("length")) return false
        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false
        }
        return true
    } catch {
        return false
    }
}

export function rewardGrantSnapshotsEqual(left: unknown, right: unknown): boolean {
    try {
        if (Object.is(left, right)) return true
        if (Array.isArray(left) || Array.isArray(right)) {
            if (!Array.isArray(left) || !Array.isArray(right)
                || left.length !== right.length
                || !hasDenseArrayShape(left)
                || !hasDenseArrayShape(right)) return false
            for (let index = 0; index < left.length; index++) {
                const leftValue = Object.getOwnPropertyDescriptor(left, String(index))!.value
                const rightValue = Object.getOwnPropertyDescriptor(right, String(index))!.value
                if (!rewardGrantSnapshotsEqual(leftValue, rightValue)) return false
            }
            return true
        }
        if (!left || !right || typeof left !== "object" || typeof right !== "object"
            || !isPlainObject(left) || !isPlainObject(right)) return false
        const leftKeys = Reflect.ownKeys(left)
        const rightKeys = Reflect.ownKeys(right)
        if (leftKeys.length !== rightKeys.length
            || leftKeys.some(key => typeof key !== "string")
            || rightKeys.some(key => typeof key !== "string")) return false
        const sortedLeft = (leftKeys as string[]).sort()
        const sortedRight = (rightKeys as string[]).sort()
        for (let index = 0; index < sortedLeft.length; index++) {
            if (sortedLeft[index] !== sortedRight[index]) return false
            const leftDescriptor = Object.getOwnPropertyDescriptor(left, sortedLeft[index])
            const rightDescriptor = Object.getOwnPropertyDescriptor(right, sortedRight[index])
            if (!leftDescriptor || !rightDescriptor
                || !("value" in leftDescriptor) || !("value" in rightDescriptor)
                || !leftDescriptor.enumerable || !rightDescriptor.enumerable
                || !rewardGrantSnapshotsEqual(leftDescriptor.value, rightDescriptor.value)) return false
        }
        return true
    } catch {
        return false
    }
}
