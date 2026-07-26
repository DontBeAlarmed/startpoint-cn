/**
 * Mode seam registry (fork/dev-base).
 *
 * The base server carries no gameplay-mode logic. Modes ship as separately
 * installed modules (see loader.ts) and register handlers here. With no
 * modules installed every dispatch is a no-op, keeping base behaviour
 * byte-identical to upstream.
 *
 * Contract for handlers: activation is content-keyed — a handler must read
 * its activation table from the content snapshot (via ModeHost.table) as its
 * first step and return null/undefined when the table is absent or disabled.
 */

export interface ModeHostServerApi {
    readonly getCharacterElement: (characterId: number) => number | null
    readonly updatePlayerEquipment: (
        playerId: number, equipmentId: number, patch: { level: number },
    ) => void
    readonly givePlayerCharactersExp: (
        playerId: number, characterIds: number[], amount: number,
    ) => unknown
}

export interface ModeHost {
    /** Reads a table from the process content snapshot (throws if missing). */
    readonly table: <T>(tableName: string) => T
    readonly log: (message: string) => void
    /** Curated server primitives for mode modules (assembled by the loader). */
    readonly server: ModeHostServerApi
}

export interface ModeRewardEntry {
    readonly kind: number
    readonly kind_id: number
    readonly number: number
}

export interface RushFinishExtension {
    readonly rush_battle_reward_list?: readonly ModeRewardEntry[]
}

export interface QuestStartContext {
    readonly playerId: number
    readonly questId: number
    readonly questCategory: number | null
}

export interface RushPartiesContext {
    readonly playerId: number
    readonly eventId: number
    /** Serialized played-party records, keyed by round. Mutated in place. */
    readonly folderParties: Record<number, Record<string, unknown>>
    readonly endlessParties: Record<number, Record<string, unknown>>
}

export interface ModeDefinition {
    readonly name: string
    readonly capability: string
    /**
     * Runs inside the same request as handleRushEventFinish, after it, and
     * receives the exact dependency-injected params object the base handler
     * received (domain primitives included). Side effects go through those
     * injected primitives; the returned reward list is appended to the
     * client-visible rush_battle_reward_list.
     */
    readonly onRushFinish?: (
        params: unknown,
        host: ModeHost,
    ) => RushFinishExtension | null | undefined
    /** May throw to reject the quest start; the message reaches the client. */
    readonly onQuestStart?: (context: QuestStartContext, host: ModeHost) => void
    /**
     * Runs just before played parties are returned to the client, and may
     * mutate the records in place. Client-side character locking is derived
     * purely from these lists, so a mode can release the lock here while
     * keeping the entry count (and therefore round progression) intact.
     */
    readonly onRushPartiesSerialized?: (
        context: RushPartiesContext,
        host: ModeHost,
    ) => void
}

const modes: ModeDefinition[] = []

export function registerMode(mode: ModeDefinition): void {
    if (!mode || typeof mode.name !== "string" || !mode.name
        || typeof mode.capability !== "string" || !mode.capability) {
        throw new Error("mode definition requires a name and a capability")
    }
    if (modes.some(existing => existing.name === mode.name)) {
        throw new Error(`mode is already registered: ${mode.name}`)
    }
    modes.push(mode)
}

export function resetModesForTest(): void {
    modes.length = 0
}

export function listModeCapabilities(): readonly string[] {
    return modes.map(mode => mode.capability)
}

export function dispatchModeRushFinish(
    params: unknown,
    host: ModeHost,
): RushFinishExtension | null {
    const rewards: ModeRewardEntry[] = []
    for (const mode of modes) {
        if (!mode.onRushFinish) continue
        const extension = mode.onRushFinish(params, host)
        if (extension?.rush_battle_reward_list?.length) {
            rewards.push(...extension.rush_battle_reward_list)
        }
    }
    return rewards.length > 0 ? { rush_battle_reward_list: rewards } : null
}

export function dispatchModeQuestStart(context: QuestStartContext, host: ModeHost): void {
    for (const mode of modes) {
        mode.onQuestStart?.(context, host)
    }
}

export function dispatchModeRushParties(context: RushPartiesContext, host: ModeHost): void {
    for (const mode of modes) {
        mode.onRushPartiesSerialized?.(context, host)
    }
}
