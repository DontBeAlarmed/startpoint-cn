import { deepFreeze } from "../content/deep-freeze"
import { getContentSnapshot, type ReadonlyContentRepository } from "../content/runtime/content-snapshot"
import type {
    BoxGacha,
    BoxGachaBoxSettings,
    BoxGachaIdReward,
    RawBoxGachas,
    RawBoxGachaSettings,
    RawBoxRewards,
} from "./types/box-gacha"

export class BoxGachaContentError extends Error {}

export interface BoxGachaRewardSource {
    readonly boxGachaId: number
    readonly boxId: number
    readonly availableFromMs: number
    readonly availableUntilMs: number
}

export interface BoxGachaContentCatalog {
    readonly entries: Readonly<Record<string, Readonly<BoxGacha>>>
    readonly rewardSourcesByKey: Readonly<Record<string, readonly BoxGachaRewardSource[]>>
}

function positiveInteger(value: unknown, subject: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new BoxGachaContentError(`${subject} must be a positive safe integer.`)
    }
    return value as number
}

function canonicalPositiveKey(value: string, subject: string): number {
    if (!/^[1-9]\d*$/.test(value)) {
        throw new BoxGachaContentError(`${subject} must be canonical.`)
    }
    return positiveInteger(Number(value), subject)
}

function nonNegativeInteger(value: unknown, subject: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new BoxGachaContentError(`${subject} must be a non-negative safe integer.`)
    }
    return value as number
}

function sameKeys(left: object, right: object): boolean {
    return Object.keys(left).sort().join(",") === Object.keys(right).sort().join(",")
}

function parseCnTimestamp(value: string, subject: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (match === null) throw new BoxGachaContentError(`${subject} is invalid.`)
    const parts = match.slice(1).map(Number)
    const [year, month, day, hour, minute, second] = parts
    const normalized = new Date(0)
    normalized.setUTCFullYear(year, month - 1, day)
    normalized.setUTCHours(hour, minute, second, 0)
    if (parts.some((part, index) => part !== [
        normalized.getUTCFullYear(),
        normalized.getUTCMonth() + 1,
        normalized.getUTCDate(),
        normalized.getUTCHours(),
        normalized.getUTCMinutes(),
        normalized.getUTCSeconds(),
    ][index])) throw new BoxGachaContentError(`${subject} is invalid.`)
    return normalized.getTime() - 8 * 60 * 60 * 1000
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validateSettings(
    rawSettings: unknown,
    boxIds: ReadonlySet<number>,
    subject: string,
): { availableFromMs: number; availableUntilMs: number } {
    if (!isRecord(rawSettings)) throw new BoxGachaContentError(`${subject} settings are invalid.`)
    const settings = rawSettings as unknown as BoxGachaBoxSettings
    const from = parseCnTimestamp(settings.availableFrom, `${subject} start`)
    const until = settings.availableUntil === null
        ? Infinity
        : parseCnTimestamp(settings.availableUntil, `${subject} end`)
    if (until < from) throw new BoxGachaContentError(`${subject} period is reversed.`)
    if (settings.requiredBoxId !== null
        && (!Number.isSafeInteger(settings.requiredBoxId) || !boxIds.has(settings.requiredBoxId))) {
        throw new BoxGachaContentError(`${subject} required box does not exist.`)
    }
    if (settings.resetKind !== 0 && settings.resetKind !== 2) {
        throw new BoxGachaContentError(`${subject} reset kind is invalid.`)
    }
    if (settings.closeKind !== 0 && settings.closeKind !== 1) {
        throw new BoxGachaContentError(`${subject} close kind is invalid.`)
    }
    if (settings.resetLimit !== null) nonNegativeInteger(settings.resetLimit, `${subject} reset limit`)
    return { availableFromMs: from, availableUntilMs: until }
}

export function buildBoxGachaContentCatalog(
    repository: ReadonlyContentRepository,
): BoxGachaContentCatalog {
    const definitions = repository.table<RawBoxGachas>("box_gacha.json")
    const rewards = repository.table<RawBoxRewards>("box_reward.json")
    const settings = repository.table<RawBoxGachaSettings>("box_gacha_box_settings.json")
    if (!isRecord(definitions) || !isRecord(rewards) || !isRecord(settings)) {
        throw new BoxGachaContentError("Box Gacha table root is invalid.")
    }
    if (!sameKeys(definitions, rewards) || !sameKeys(definitions, settings)) {
        throw new BoxGachaContentError("Box Gacha table ids do not match.")
    }

    const entries: Record<string, BoxGacha> = {}
    const rewardSourcesByKey: Record<string, BoxGachaRewardSource[]> = {}
    for (const [gachaIdText, definition] of Object.entries(definitions)) {
        const gachaId = canonicalPositiveKey(gachaIdText, "Box Gacha id")
        if (!isRecord(definition)) {
            throw new BoxGachaContentError(`Box Gacha ${gachaId} definition is invalid.`)
        }
        positiveInteger(definition.itemId, `Box Gacha ${gachaId} redeem item`)
        positiveInteger(definition.count, `Box Gacha ${gachaId} redeem count`)
        const boxes = rewards[gachaIdText]
        const boxSettings = settings[gachaIdText]
        if (!isRecord(definition.availableCounts)
            || !isRecord(boxes) || !isRecord(boxSettings)
            || !sameKeys(definition.availableCounts, boxes)
            || !sameKeys(definition.availableCounts, boxSettings)) {
            throw new BoxGachaContentError(`Box Gacha ${gachaId} box ids do not match.`)
        }
        const boxIds = new Set(Object.keys(boxes).map(boxIdText => (
            canonicalPositiveKey(boxIdText, `Box Gacha ${gachaId} box id`)
        )))
        for (const [boxIdText, box] of Object.entries(boxes)) {
            const boxId = canonicalPositiveKey(boxIdText, `Box Gacha ${gachaId} box id`)
            if (!isRecord(box)) {
                throw new BoxGachaContentError(`Box Gacha ${gachaId}/${boxId} rewards are invalid.`)
            }
            const availableCount = positiveInteger(
                definition.availableCounts[boxIdText],
                `Box Gacha ${gachaId}/${boxId} available count`,
            )
            const period = validateSettings(
                boxSettings[boxIdText],
                boxIds,
                `Box Gacha ${gachaId}/${boxId}`,
            )
            let summedAvailable = 0
            for (const [rewardIdText, reward] of Object.entries(box)) {
                canonicalPositiveKey(rewardIdText, `Box Gacha ${gachaId}/${boxId} reward id`)
                if (!isRecord(reward)) {
                    throw new BoxGachaContentError(`Box Gacha ${gachaId}/${boxId} reward is invalid.`)
                }
                if (!Number.isSafeInteger(reward.type) || reward.type < 0 || reward.type > 6
                    || !Number.isSafeInteger(reward.tier) || reward.tier < 0 || reward.tier > 2) {
                    throw new BoxGachaContentError(`Box Gacha ${gachaId}/${boxId} reward is invalid.`)
                }
                positiveInteger(reward.count, `Box Gacha ${gachaId}/${boxId} reward count`)
                const available = positiveInteger(
                    reward.available,
                    `Box Gacha ${gachaId}/${boxId} reward available`,
                )
                summedAvailable += available
                if (!Number.isSafeInteger(summedAvailable)) {
                    throw new BoxGachaContentError(`Box Gacha ${gachaId}/${boxId} count overflow.`)
                }
                if ([0, 1, 5, 6].includes(reward.type)) {
                    const rewardWithId = reward as unknown as BoxGachaIdReward
                    positiveInteger(rewardWithId.id, `Box Gacha ${gachaId}/${boxId} reward item id`)
                    if (reward.type === 0 || reward.type === 1) {
                        const key = `${reward.type}:${rewardWithId.id}`
                        ;(rewardSourcesByKey[key] ??= []).push({
                            boxGachaId: gachaId,
                            boxId,
                            ...period,
                        })
                    }
                }
            }
            if (summedAvailable !== availableCount) {
                throw new BoxGachaContentError(`Box Gacha ${gachaId}/${boxId} available count mismatch.`)
            }
        }
        entries[gachaIdText] = {
            redeemItemId: definition.itemId,
            redeemItemCount: definition.count,
            boxes,
            availableCounts: definition.availableCounts,
            boxSettings,
        }
    }
    return deepFreeze({ entries, rewardSourcesByKey })
}

const catalogs = new WeakMap<ReadonlyContentRepository, BoxGachaContentCatalog>()

export function getBoxGachaContentCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): BoxGachaContentCatalog {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const catalog = buildBoxGachaContentCatalog(repository)
    catalogs.set(repository, catalog)
    return catalog
}

export function getBoxGachaContent(
    catalog: BoxGachaContentCatalog,
    boxGachaId: string | number,
): Readonly<BoxGacha> | null {
    return catalog.entries[String(boxGachaId)] ?? null
}

export function findAvailableBoxGachaIdsForReward(
    catalog: BoxGachaContentCatalog,
    rewardType: 0 | 1,
    rewardId: number,
    nowMs: number,
): readonly number[] {
    if (!Number.isSafeInteger(rewardId) || rewardId <= 0 || !Number.isFinite(nowMs)) return []
    return [...new Set((catalog.rewardSourcesByKey[`${rewardType}:${rewardId}`] ?? [])
        .filter(source => nowMs >= source.availableFromMs && nowMs <= source.availableUntilMs)
        .map(source => source.boxGachaId))]
        .sort((left, right) => left - right)
}
