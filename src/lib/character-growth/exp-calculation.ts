import { characterExpCaps } from "./exp-caps"
import { addSafeInteger } from "./mutation-support"
import { growthError } from "./errors"

export interface CharacterExpCalculation {
    readonly beforeExp: number
    readonly afterExp: number
    readonly characterExpAdded: number
    readonly overflowExp: number
    readonly cap: number
}

export function calculateCharacterExpAfter(
    rarity: number,
    overLimitStep: number,
    beforeExp: number,
    addExp: number,
): CharacterExpCalculation {
    if (!Number.isSafeInteger(addExp) || addExp < 0) {
        throw growthError("INVALID_REQUEST", "exp must be a non-negative safe integer.")
    }
    const caps = characterExpCaps[rarity]
    const cap = caps?.[overLimitStep] ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(beforeExp) || beforeExp < 0 || beforeExp > cap) {
        throw growthError("INVALID_GROWTH_STATE", "character.exp is outside its current cap.")
    }
    const requestedAfter = addSafeInteger(beforeExp, addExp, "character.exp")
    const afterExp = Math.min(cap, requestedAfter)
    const overflowExp = requestedAfter - afterExp
    return {
        beforeExp,
        afterExp,
        characterExpAdded: afterExp - beforeExp,
        overflowExp,
        cap,
    }
}
