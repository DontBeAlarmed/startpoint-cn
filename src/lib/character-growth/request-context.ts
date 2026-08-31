import { getCharacterDataSync } from "../assets"
import { getCharacterGrowthContentFactsSync } from "./content-facts"
import { CharacterGrowthError, growthError } from "./errors"
import { validateAwakeLevel, validateBondTokenStatus, validateBoardIndex } from "./invariants"
import { CharacterGrowthRepository } from "./repository"
import type {
    BondTokenStatus,
    CharacterGrowthContentFacts,
    CharacterGrowthCoreFact,
    CharacterGrowthStoredCore,
} from "./model"

export interface CharacterGrowthRequestContext {
    character(): CharacterGrowthCoreFact
    bondTokens(): ReadonlyMap<number, BondTokenStatus>
    normalManaNodes(): ReadonlyMap<number, number>
    awakeUnlocks(): ReadonlyMap<number, number>
    requiredItems(ids: readonly number[]): ReadonlyMap<number, number>
    contentFacts(): CharacterGrowthContentFacts
}

export interface CharacterGrowthRequestContextOptions {
    readonly playerId: number
    readonly characterId: number
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

export class CharacterGrowthRequestContextImpl implements CharacterGrowthRequestContext {
    private readonly playerId: number
    private readonly characterId: number
    private readonly repository: CharacterGrowthRepository
    private readonly contentFactsLoader: (characterId: number) => CharacterGrowthContentFacts
    private readonly rarityLoader: (characterId: number) => number | null
    private cachedCharacter: CharacterGrowthCoreFact | null = null
    private cachedBondTokens: ReadonlyMap<number, BondTokenStatus> | null = null
    private cachedNormalManaNodes: ReadonlyMap<number, number> | null = null
    private cachedAwakeUnlocks: ReadonlyMap<number, number> | null = null
    private cachedContentFacts: CharacterGrowthContentFacts | null = null
    private readonly cachedItems = new Map<number, number>()
    private requiredItemsLoaded = false
    private requiredItemIds: ReadonlySet<number> | null = null

    constructor(options: CharacterGrowthRequestContextOptions) {
        this.playerId = positiveId(options.playerId, "playerId")
        this.characterId = positiveId(options.characterId, "characterId")
        this.repository = options.repository ?? new CharacterGrowthRepository()
        this.contentFactsLoader = options.contentFactsLoader ?? getCharacterGrowthContentFactsSync
        this.rarityLoader = options.rarityLoader ?? defaultRarityLoader
    }

    character(): CharacterGrowthCoreFact {
        if (this.cachedCharacter !== null) return this.cachedCharacter
        const stored = this.repository.getCharacterSync(this.playerId, this.characterId)
        if (stored === null) {
            throw new CharacterGrowthError(
                "CHARACTER_NOT_OWNED",
                `character ${this.characterId} is not owned by player ${this.playerId}.`,
            )
        }
        this.cachedCharacter = buildCore(stored, this.playerId, this.rarityLoader)
        return this.cachedCharacter
    }

    bondTokens(): ReadonlyMap<number, BondTokenStatus> {
        if (this.cachedBondTokens === null) {
            this.cachedBondTokens = validateTokenMap(
                this.repository.getBondTokensSync(this.playerId, this.characterId),
            )
        }
        return this.cachedBondTokens
    }

    normalManaNodes(): ReadonlyMap<number, number> {
        if (this.cachedNormalManaNodes === null) {
            this.cachedNormalManaNodes = this.repository.getNormalManaNodesSync(this.playerId, this.characterId)
        }
        return this.cachedNormalManaNodes
    }

    awakeUnlocks(): ReadonlyMap<number, number> {
        if (this.cachedAwakeUnlocks === null) {
            this.cachedAwakeUnlocks = validateAwakeMap(
                this.repository.getAwakeUnlocksSync(this.playerId, this.characterId),
            )
        }
        return this.cachedAwakeUnlocks
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

    contentFacts(): CharacterGrowthContentFacts {
        if (this.cachedContentFacts === null) {
            this.cachedContentFacts = this.contentFactsLoader(this.characterId)
        }
        return this.cachedContentFacts
    }
}

export function createCharacterGrowthRequestContext(
    options: CharacterGrowthRequestContextOptions,
): CharacterGrowthRequestContext {
    return new CharacterGrowthRequestContextImpl(options)
}
