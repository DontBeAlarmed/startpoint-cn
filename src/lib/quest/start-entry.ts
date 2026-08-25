export interface StartEntryCost {
    itemId: number
    itemCount: number
    stamina: number
}

export interface StartEntryPlayer {
    id: number
    stamina: number
    staminaHealTime: Date
    rankPoint: number
    totalStaminaUsed: number
    partySlot: number
}

export interface StartEntryInput<TActiveQuest> {
    playerId: number
    entryCost?: StartEntryCost
    staminaCost: number
    partyId: number
    updatePartySlot: boolean
    activeQuest: TActiveQuest
    now: Date
}

export interface StartEntryDependencies<TActiveQuest> {
    transaction<T>(operation: () => T): T
    getActiveQuest?(playerId: number): unknown | null
    getPlayer(playerId: number): StartEntryPlayer | null
    computeStamina(player: StartEntryPlayer): number
    getItemCount(playerId: number, itemId: number): number | null
    updateItemCount(playerId: number, itemId: number, amount: number): void
    updatePlayer(update: Partial<StartEntryPlayer> & Pick<StartEntryPlayer, "id">): void
    persistActiveQuest(playerId: number, activeQuest: TActiveQuest): void
    beforePersist?(playerId: number): void
    afterPersist?(playerId: number): void
    publishActiveQuest(playerId: number, activeQuest: TActiveQuest): void
}

export interface StartEntryResult {
    beforeStamina: number
    afterStamina: number
    entryItemId: number | null
    entryItemCount: number | null
}

export class PlayerNotFoundError extends Error {
    constructor(playerId: number) {
        super(`Player ${playerId} does not exist.`)
        this.name = "PlayerNotFoundError"
    }
}

export class ActiveQuestAlreadyExistsError extends Error {
    constructor(playerId: number) {
        super(`Player ${playerId} already has an active quest.`)
        this.name = "ActiveQuestAlreadyExistsError"
    }
}

export class InsufficientEntryItemError extends Error {
    constructor(
        public readonly itemId: number,
        public readonly required: number,
        public readonly current: number,
    ) {
        super(`Not enough entry items (need ${required} of ${itemId}, have ${current}).`)
        this.name = "InsufficientEntryItemError"
    }
}

export class InsufficientStaminaError extends Error {
    constructor(
        public readonly required: number,
        public readonly current: number,
    ) {
        super(`Insufficient stamina (need ${required}, have ${current}).`)
        this.name = "InsufficientStaminaError"
    }
}

export function buildStartEntryItemList(
    result: Pick<StartEntryResult, "entryItemId" | "entryItemCount">,
): Record<string, number> {
    if (result.entryItemId === null || result.entryItemCount === null) return {}
    return { [result.entryItemId]: result.entryItemCount }
}

export function runStartEntryTransaction<TActiveQuest>(
    input: StartEntryInput<TActiveQuest>,
    dependencies: StartEntryDependencies<TActiveQuest>,
): StartEntryResult {
    const result = dependencies.transaction(() => {
        if (dependencies.getActiveQuest?.(input.playerId) != null) {
            throw new ActiveQuestAlreadyExistsError(input.playerId)
        }
        const player = dependencies.getPlayer(input.playerId)
        if (!player) throw new PlayerNotFoundError(input.playerId)

        dependencies.beforePersist?.(input.playerId)

        const entryItemCost = input.entryCost
            && input.entryCost.itemId > 0
            && input.entryCost.itemCount > 0
            ? input.entryCost
            : null
        const entryItemId = entryItemCost?.itemId ?? null
        const currentItemCount = entryItemCost
            ? dependencies.getItemCount(input.playerId, entryItemCost.itemId) ?? 0
            : null
        const currentStamina = dependencies.computeStamina(player)

        if (entryItemCost && (currentItemCount ?? 0) < entryItemCost.itemCount) {
            throw new InsufficientEntryItemError(
                entryItemCost.itemId,
                entryItemCost.itemCount,
                currentItemCount ?? 0,
            )
        }
        if (currentStamina < input.staminaCost) {
            throw new InsufficientStaminaError(input.staminaCost, currentStamina)
        }

        const entryItemCount = entryItemCost
            ? (currentItemCount ?? 0) - entryItemCost.itemCount
            : null
        if (entryItemId !== null) {
            dependencies.updateItemCount(input.playerId, entryItemId, entryItemCount ?? 0)
        }

        const afterStamina = currentStamina - input.staminaCost
        const playerUpdate: Partial<StartEntryPlayer> & Pick<StartEntryPlayer, "id"> = {
            id: input.playerId,
        }
        if (input.staminaCost > 0) {
            playerUpdate.stamina = afterStamina
            playerUpdate.staminaHealTime = input.now
            playerUpdate.totalStaminaUsed = (player.totalStaminaUsed ?? 0) + input.staminaCost
        }
        if (input.updatePartySlot) playerUpdate.partySlot = input.partyId
        if (Object.keys(playerUpdate).length > 1) dependencies.updatePlayer(playerUpdate)

        dependencies.persistActiveQuest(input.playerId, input.activeQuest)
        dependencies.afterPersist?.(input.playerId)

        return {
            beforeStamina: currentStamina,
            afterStamina,
            entryItemId,
            entryItemCount,
        }
    })
    dependencies.publishActiveQuest(input.playerId, input.activeQuest)
    return result
}
