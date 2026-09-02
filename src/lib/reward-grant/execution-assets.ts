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
        })
    }

    for (const entry of entries) {
        const outcome = entry.outcome
        if (outcome.kind === "item") {
            observeItem(outcome.item, entry.index)
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
            const existingIndex = currencyIndices.get(outcome.currency)
            if (existingIndex === undefined) {
                currencyIndices.set(outcome.currency, currencies.length)
                currencies.push(Object.freeze({
                    currency: outcome.currency,
                    requestedAmount: outcome.requestedAmount,
                    beforeAmount: outcome.beforeAmount,
                    afterAmount: outcome.afterAmount,
                }))
            } else {
                const previous = currencies[existingIndex]
                if (outcome.beforeAmount !== previous.afterAmount) {
                    throw new RewardGrantContractValidationError(entry.index, "beforeAmount")
                }
                currencies[existingIndex] = Object.freeze({
                    currency: outcome.currency,
                    requestedAmount: addRewardGrantAmount(
                        previous.requestedAmount,
                        outcome.requestedAmount,
                        entry.index,
                        "requestedAmount",
                    ),
                    beforeAmount: previous.beforeAmount,
                    afterAmount: outcome.afterAmount,
                })
            }
        }
    }
    return Object.freeze({
        items: Object.freeze(items),
        characters: Object.freeze(characters),
        equipment: Object.freeze(equipment),
        currencies: Object.freeze(currencies),
    })
}
