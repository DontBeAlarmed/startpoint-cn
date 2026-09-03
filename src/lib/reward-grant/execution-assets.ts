import {
    RewardGrantContractValidationError,
    type RewardGrantAssetResult,
    type RewardGrantCurrencyKind,
    type RewardGrantExecutionEntryResult,
    type RewardGrantFinalCharacter,
    type RewardGrantFinalCurrency,
    type RewardGrantFinalEquipment,
    type RewardGrantItemOutcome,
} from "./execution-contract"
import { addRewardGrantAmount } from "./execution-outcome"

export function aggregateRewardGrantAssets(
    entries: readonly RewardGrantExecutionEntryResult[],
): RewardGrantAssetResult {
    const items: RewardGrantItemOutcome[] = []
    const itemIndices = new Map<number, number>()
    const characters: RewardGrantFinalCharacter[] = []
    const characterIndices = new Map<number, number>()
    const equipment: RewardGrantFinalEquipment[] = []
    const equipmentIndices = new Map<number, number>()
    const currencies: RewardGrantFinalCurrency[] = []
    const currencyIndices = new Map<RewardGrantCurrencyKind, number>()

    const observeCurrency = (
        currency: RewardGrantCurrencyKind,
        requestedAmount: number,
        beforeAmount: number,
        afterAmount: number,
        entryIndex: number,
    ) => {
        if (requestedAmount === 0) return
        const existingIndex = currencyIndices.get(currency)
        if (existingIndex === undefined) {
            currencyIndices.set(currency, currencies.length)
            currencies.push(Object.freeze({ currency, requestedAmount, beforeAmount, afterAmount }))
            return
        }
        const previous = currencies[existingIndex]
        if (beforeAmount !== previous.afterAmount) {
            throw new RewardGrantContractValidationError(entryIndex, "beforeAmount")
        }
        currencies[existingIndex] = Object.freeze({
            currency,
            requestedAmount: addRewardGrantAmount(
                previous.requestedAmount,
                requestedAmount,
                entryIndex,
                "requestedAmount",
            ),
            beforeAmount: previous.beforeAmount,
            afterAmount,
        })
    }

    const observeItemDispositionCurrencies = (
        item: RewardGrantItemOutcome,
        entryIndex: number,
    ) => {
        for (const disposition of item.overflowDispositions ?? []) {
            if (disposition.kind !== "sold") continue
            observeCurrency(
                "freeMana",
                disposition.acceptedMana,
                disposition.manaBefore,
                disposition.manaAfter,
                entryIndex,
            )
        }
    }

    const observeItem = (item: RewardGrantItemOutcome, entryIndex: number) => {
        const existingIndex = itemIndices.get(item.itemId)
        if (existingIndex === undefined) {
            itemIndices.set(item.itemId, items.length)
            items.push(item)
            return
        }
        const previous = items[existingIndex]
        if (item.beforeAmount !== previous.afterAmount) {
            throw new RewardGrantContractValidationError(entryIndex, "beforeAmount")
        }
        const overflowDispositions = [
            ...(previous.overflowDispositions ?? []),
            ...(item.overflowDispositions ?? []),
        ]
        items[existingIndex] = Object.freeze({
            itemId: item.itemId,
            requestedAmount: addRewardGrantAmount(
                previous.requestedAmount, item.requestedAmount, entryIndex, "requestedAmount",
            ),
            acceptedAmount: addRewardGrantAmount(
                previous.acceptedAmount, item.acceptedAmount, entryIndex, "acceptedAmount",
            ),
            overflowAmount: addRewardGrantAmount(
                previous.overflowAmount, item.overflowAmount, entryIndex, "overflowAmount",
            ),
            beforeAmount: previous.beforeAmount,
            afterAmount: item.afterAmount,
            ...(overflowDispositions.length > 0
                ? { overflowDispositions: Object.freeze(overflowDispositions) }
                : {}),
        })
    }

    for (const entry of entries) {
        const outcome = entry.outcome
        if (outcome.kind === "item") {
            observeItem(outcome.item, entry.index)
            observeItemDispositionCurrencies(outcome.item, entry.index)
        } else if (outcome.kind === "character") {
            const existingIndex = characterIndices.get(outcome.characterId)
            if (existingIndex !== undefined && outcome.isNew) {
                throw new RewardGrantContractValidationError(entry.index, "outcome")
            }
            const final = Object.freeze({
                characterId: outcome.characterId,
                joined: existingIndex === undefined ? outcome.isNew : characters[existingIndex].joined,
                after: outcome.after,
            })
            if (existingIndex === undefined) {
                characterIndices.set(outcome.characterId, characters.length)
                characters.push(final)
            } else {
                characters[existingIndex] = final
            }
            if (outcome.compensationItem !== null) {
                observeItem(outcome.compensationItem, entry.index)
                observeItemDispositionCurrencies(outcome.compensationItem, entry.index)
            }
        } else if (outcome.kind === "equipment") {
            const existingIndex = equipmentIndices.get(outcome.equipmentId)
            const previousRequested = existingIndex === undefined
                ? 0
                : equipment[existingIndex].requestedAmount
            const final = Object.freeze({
                equipmentId: outcome.equipmentId,
                requestedAmount: addRewardGrantAmount(
                    previousRequested, outcome.requestedAmount, entry.index, "requestedAmount",
                ),
                after: outcome.after,
            })
            if (existingIndex === undefined) {
                equipmentIndices.set(outcome.equipmentId, equipment.length)
                equipment.push(final)
            } else {
                equipment[existingIndex] = final
            }
        } else {
            observeCurrency(
                outcome.currency,
                outcome.requestedAmount,
                outcome.beforeAmount,
                outcome.afterAmount,
                entry.index,
            )
        }
    }
    return Object.freeze({
        items: Object.freeze(items),
        characters: Object.freeze(characters),
        equipment: Object.freeze(equipment),
        currencies: Object.freeze(currencies),
    })
}
