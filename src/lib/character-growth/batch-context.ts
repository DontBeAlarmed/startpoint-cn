import { getCharacterDataSync } from "../assets"
import { getCharacterGrowthContentFactsSync } from "./content-facts"
import { growthError } from "./errors"
import { validateAwakeLevel, validateBondTokenStatus, validateBoardIndex } from "./invariants"
import { CharacterGrowthRepository } from "./repository"
import type {
    BondTokenStatus,
    CharacterGrowthContentFacts,
    CharacterGrowthCoreFact,
    CharacterGrowthStoredCore,
} from "./model"

export interface CharacterGrowthBatchContext {
    character(characterId: number): CharacterGrowthCoreFact | null
    characters(): ReadonlyMap<number, CharacterGrowthCoreFact>
    bondTokens(characterId: number): ReadonlyMap<number, BondTokenStatus>
    normalManaNodes(characterId: number): ReadonlyMap<number, number>
    awakeUnlocks(characterId: number): ReadonlyMap<number, number>
    requiredItems(ids: readonly number[]): ReadonlyMap<number, number>
    contentFacts(characterId: number): CharacterGrowthContentFacts
}

export interface CharacterGrowthBatchContextOptions {
    readonly playerId: number
    readonly characterIds: readonly number[]
    readonly repository?: CharacterGrowthRepository
    readonly contentFactsLoader?: (characterId: number) => CharacterGrowthContentFacts
    readonly rarityLoader?: (characterId: number) => number | null
}

function positiveId(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw growthError("INVALID_GROWTH_STATE", `${field} must be a positive safe integer.`)
    }
    return value
}

function defaultRarityLoader(characterId: number): number | null {
    return getCharacterDataSync(characterId)?.rarity ?? null
}

function buildCore(
    stored: CharacterGrowthStoredCore,
    playerId: number,
    rarityLoader: (characterId: number) => number | null,
): CharacterGrowthCoreFact {
    const rarity = rarityLoader(stored.characterId)
    if (rarity === null || !Number.isSafeInteger(rarity) || rarity <= 0) {
        throw growthError("CONTENT_INVALID", `character ${stored.characterId} rarity is unavailable.`)
    }
    return {
        playerId,
        characterId: stored.characterId,
        rarity,
        exp: stored.exp,
        stack: stored.stack,
        overLimitStep: stored.overLimitStep,
        evolutionLevel: stored.evolutionLevel,
        manaBoardIndex: stored.manaBoardIndex,
    }
}

function validateTokenMap(tokens: ReadonlyMap<number, BondTokenStatus>): ReadonlyMap<number, BondTokenStatus> {
    for (const [boardIndex, status] of tokens) {
        validateBoardIndex(boardIndex)
        validateBondTokenStatus(status)
    }
    return tokens
}

function validateAwakeMap(unlocks: ReadonlyMap<number, number>): ReadonlyMap<number, number> {
    for (const [boardIndex, awakeLevel] of unlocks) {
        validateBoardIndex(boardIndex)
        validateAwakeLevel(awakeLevel)
    }
    return unlocks
}

export class CharacterGrowthBatchContextImpl implements CharacterGrowthBatchContext {
    private readonly playerId: number
    private readonly characterIds: readonly number[]
    private readonly repository: CharacterGrowthRepository
    private readonly contentFactsLoader: (characterId: number) => CharacterGrowthContentFacts
    private readonly rarityLoader: (characterId: number) => number | null
    private cachedCharacters: ReadonlyMap<number, CharacterGrowthCoreFact> | null = null
    private cachedBondTokens: ReadonlyMap<number, ReadonlyMap<number, BondTokenStatus>> | null = null
    private cachedNormalManaNodes: ReadonlyMap<number, ReadonlyMap<number, number>> | null = null
    private cachedAwakeUnlocks: ReadonlyMap<number, ReadonlyMap<number, number>> | null = null
    private readonly cachedItems = new Map<number, number>()
    private requiredItemsLoaded = false
    private requiredItemIds: ReadonlySet<number> | null = null
    private readonly contentCache = new Map<number, CharacterGrowthContentFacts>()

    constructor(options: CharacterGrowthBatchContextOptions) {
        this.playerId = positiveId(options.playerId, "playerId")
        this.characterIds = [...new Set(options.characterIds)].map(id => positiveId(id, "characterId"))
        this.repository = options.repository ?? new CharacterGrowthRepository()
        this.contentFactsLoader = options.contentFactsLoader ?? getCharacterGrowthContentFactsSync
        this.rarityLoader = options.rarityLoader ?? defaultRarityLoader
    }

    characters(): ReadonlyMap<number, CharacterGrowthCoreFact> {
        if (this.cachedCharacters === null) {
            const stored = this.repository.getCharactersByIdsSync(this.playerId, this.characterIds)
            this.cachedCharacters = new Map(Object.values(stored).map(value => [
                value.characterId,
                buildCore(value, this.playerId, this.rarityLoader),
            ]))
        }
        return this.cachedCharacters
    }

    character(characterId: number): CharacterGrowthCoreFact | null {
        positiveId(characterId, "characterId")
        return this.characters().get(characterId) ?? null
    }

    bondTokens(characterId: number): ReadonlyMap<number, BondTokenStatus> {
        positiveId(characterId, "characterId")
        if (this.cachedBondTokens === null) {
            this.cachedBondTokens = new Map(Object.entries(
                this.repository.getBondTokensByCharacterIdsSync(this.playerId, this.characterIds),
            ).map(([id, value]) => [Number(id), validateTokenMap(value)]))
        }
        return this.cachedBondTokens.get(characterId) ?? new Map()
    }

    normalManaNodes(characterId: number): ReadonlyMap<number, number> {
        positiveId(characterId, "characterId")
        if (this.cachedNormalManaNodes === null) {
            this.cachedNormalManaNodes = new Map(Object.entries(
                this.repository.getNormalManaNodesByCharacterIdsSync(this.playerId, this.characterIds),
            ).map(([id, value]) => [Number(id), value]))
        }
        return this.cachedNormalManaNodes.get(characterId) ?? new Map()
    }

    awakeUnlocks(characterId: number): ReadonlyMap<number, number> {
        positiveId(characterId, "characterId")
        if (this.cachedAwakeUnlocks === null) {
            this.cachedAwakeUnlocks = new Map(Object.entries(
                this.repository.getAwakeUnlocksByCharacterIdsSync(this.playerId, this.characterIds),
            ).map(([id, value]) => [Number(id), validateAwakeMap(value)]))
        }
        return this.cachedAwakeUnlocks.get(characterId) ?? new Map()
    }

    requiredItems(ids: readonly number[]): ReadonlyMap<number, number> {
        const requestedIds = [...new Set(ids)]
        for (const id of requestedIds) positiveId(id, "itemId")
        if (this.requiredItemsLoaded) {
            const hasNewId = requestedIds.some(id => !this.requiredItemIds?.has(id))
            if (hasNewId) {
                throw growthError(
                    "INVALID_GROWTH_STATE",
                    "requiredItems section was already loaded with a different ID set.",
                )
            }
        } else {
            const loaded = this.repository.getRequiredItemsSync(this.playerId, requestedIds)
            this.requiredItemIds = new Set(requestedIds)
            for (const id of requestedIds) this.cachedItems.set(id, loaded.get(id) ?? 0)
            this.requiredItemsLoaded = true
        }
        return new Map(requestedIds.map(id => [id, this.cachedItems.get(id) ?? 0]))
    }

    contentFacts(characterId: number): CharacterGrowthContentFacts {
        positiveId(characterId, "characterId")
        const cached = this.contentCache.get(characterId)
        if (cached !== undefined) return cached
        const facts = this.contentFactsLoader(characterId)
        this.contentCache.set(characterId, facts)
        return facts
    }
}

export function createCharacterGrowthBatchContext(
    options: CharacterGrowthBatchContextOptions,
): CharacterGrowthBatchContext {
    return new CharacterGrowthBatchContextImpl(options)
}
