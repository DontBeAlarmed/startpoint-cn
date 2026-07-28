import { PlayerBoxGacha } from "../data/types"
import { BoxGachaBoxSettings } from "./types/box-gacha"

export interface BoxGachaResetInput {
    playerId: number
    boxGachaId: number
    boxId: number
    availableCount: number
    settings: BoxGachaBoxSettings
    nowMs: number
}

export interface BoxGachaResetDependencies {
    transaction<T>(operation: () => T): T
    getBox(playerId: number, boxGachaId: number, boxId: number): PlayerBoxGacha | null
    updateBox(playerId: number, boxGachaId: number, box: PlayerBoxGacha): void
    deleteDrawnRewards(playerId: number, boxGachaId: number, boxId: number): void
}

export class BoxGachaResetError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "BoxGachaResetError"
    }
}

export class BoxGachaInvalidPeriodError extends BoxGachaResetError {
    readonly errorCode = 4608

    constructor() {
        super("Box gacha is outside its available period.")
        this.name = "BoxGachaInvalidPeriodError"
    }
}

export class BoxGachaStateNotFoundError extends BoxGachaResetError {
    constructor(boxGachaId: number, boxId: number) {
        super(`Box gacha ${boxGachaId} box ${boxId} does not exist for this player.`)
        this.name = "BoxGachaStateNotFoundError"
    }
}

export class BoxGachaLockedError extends BoxGachaResetError {
    constructor(boxId: number) {
        super(`Box ${boxId} is locked.`)
        this.name = "BoxGachaLockedError"
    }
}

export class BoxGachaResetUnavailableError extends BoxGachaResetError {
    constructor(boxId: number) {
        super(`Box ${boxId} cannot be reset.`)
        this.name = "BoxGachaResetUnavailableError"
    }
}

export class BoxGachaResetLimitReachedError extends BoxGachaResetError {
    constructor(boxId: number) {
        super(`Box ${boxId} has reached its reset limit.`)
        this.name = "BoxGachaResetLimitReachedError"
    }
}

export class BoxGachaNotEmptyError extends BoxGachaResetError {
    constructor(boxId: number) {
        super(`Box ${boxId} must be empty before it can be reset.`)
        this.name = "BoxGachaNotEmptyError"
    }
}

function parseCnTimestamp(value: string): number {
    const timestamp = Date.parse(`${value.replace(" ", "T")}+08:00`)
    if (!Number.isFinite(timestamp)) {
        throw new BoxGachaResetError(`Invalid box gacha period: ${value}.`)
    }
    return timestamp
}

function validatePeriod(settings: BoxGachaBoxSettings, nowMs: number): void {
    const availableFromMs = parseCnTimestamp(settings.availableFrom)
    const availableUntilMs = settings.availableUntil === null
        ? Infinity
        : parseCnTimestamp(settings.availableUntil)
    if (nowMs < availableFromMs || nowMs > availableUntilMs) {
        throw new BoxGachaInvalidPeriodError()
    }
}

export function resetBoxGachaSync(
    input: BoxGachaResetInput,
    dependencies: BoxGachaResetDependencies,
): PlayerBoxGacha {
    validatePeriod(input.settings, input.nowMs)

    return dependencies.transaction(() => {
        const currentBox = dependencies.getBox(input.playerId, input.boxGachaId, input.boxId)
        if (currentBox === null) {
            throw new BoxGachaStateNotFoundError(input.boxGachaId, input.boxId)
        }

        if (input.settings.requiredBoxId !== null) {
            const requiredBox = dependencies.getBox(
                input.playerId,
                input.boxGachaId,
                input.settings.requiredBoxId,
            )
            const isUnlocked = requiredBox !== null
                && (requiredBox.remainingNumber === 0 || requiredBox.isClosed)
            if (!isUnlocked) throw new BoxGachaLockedError(input.boxId)
        }

        if (input.settings.resetKind !== 2) {
            throw new BoxGachaResetUnavailableError(input.boxId)
        }
        if (
            input.settings.resetLimit !== null
            && currentBox.resetTimes >= input.settings.resetLimit
        ) {
            throw new BoxGachaResetLimitReachedError(input.boxId)
        }
        if (currentBox.remainingNumber !== 0) {
            throw new BoxGachaNotEmptyError(input.boxId)
        }

        const resetBox: PlayerBoxGacha = {
            boxId: input.boxId,
            resetTimes: currentBox.resetTimes + 1,
            remainingNumber: input.availableCount,
            isClosed: false,
        }
        dependencies.updateBox(input.playerId, input.boxGachaId, resetBox)
        dependencies.deleteDrawnRewards(input.playerId, input.boxGachaId, input.boxId)
        return resetBox
    })
}
