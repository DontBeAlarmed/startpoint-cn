import {
    getPlayerCharacterManaNodesByIdsSync,
    getPlayerCharactersByIdsSync,
    getPlayerCharactersManaNodeAwakeLevelsByIdsSync,
    getPlayerCharactersManaNodeAwakeLevelsSync,
    getPlayerCharactersManaNodesSync,
} from "../../data/domains/character"
import {
    getPlayerCharacterAwakeUnlocksSync,
    type CharacterAwakeUnlockMap,
} from "../../data/domains/character_awake"
import {
    getPlayerCharacterClearsByIdsSync,
} from "../../data/domains/character_clear"
import { getPlayerCategoryMissionsByIdsSync } from "../../data/domains/mission"
import {
    getPlayerPartyCoClearCountersByCharacterIdsSync,
} from "../../data/domains/party_co_clear"
import type { PlayerActiveMission } from "../../data/types"
import { getServerDate } from "../../utils"
import {
    createCharacterAwakeEligibilityResolverFromSnapshot,
    type CharacterAwakeEligibilityResolver,
} from "./awake-eligibility"
import { getCharacterIdFromMission } from "./character-queries"
import { MissionEvaluationSession } from "./evaluation-session"
import { getMissionCatalog } from "./mission-catalog"
import { createProductionMissionFactLoaderRegistry } from "./production-fact-loaders"
import { getMissionFactRequirementRegistry } from "./requirements/registry"
import { getComputer } from "./registry"
import type { AwakeUnlockProgress } from "./awake-unlock"
import {
    collectSupportedAwakeMissionIds,
    mergeAwakeScopedCharacterIds,
    normalizeAwakeCandidateCharacterIds,
} from "./awake-request-context-scope"
import {
    assertAwakeRequestContext,
    isAwakeRequestContext,
    readAwakeRequestContextCategoryMissions,
    registerAwakeRequestContext,
} from "./awake-request-context-state"
import type { CategoryContext } from "./types"

export interface AwakeRequestContext {
    readonly playerId: number
    readonly evaluationTime: Date
    readonly resolver: CharacterAwakeEligibilityResolver
    evaluate(candidateCharacterIds?: readonly number[]): readonly AwakeUnlockProgress[]
    readUnlocks(): CharacterAwakeUnlockMap
}

export interface CreateAwakeRequestContextOptions {
    readonly playerId: number
    readonly evaluationTime?: Date
    readonly candidateCharacterIds?: readonly number[]
}

const CATEGORY = 9

function cloneAwakeUnlocks(unlocks: CharacterAwakeUnlockMap): CharacterAwakeUnlockMap {
    return new Map(
        [...unlocks].map(([characterId, levels]) => [characterId, { ...levels }]),
    )
}

function normalizePlayerId(playerId: number): number {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw new TypeError("Awake context playerId must be a positive safe integer")
    }
    return playerId
}

function cloneCategoryMissions(
    missions: Record<string, PlayerActiveMission>,
): Readonly<Record<string, PlayerActiveMission>> {
    const cloned = Object.fromEntries(Object.entries(missions).map(([missionId, mission]) => [
        missionId,
        Object.freeze({
            progress: mission.progress,
            stages: Array.isArray(mission.stages)
                ? Object.freeze([]) as unknown as never[]
                : Object.freeze({ ...mission.stages }) as Record<string, boolean>,
        }),
    ]))
    return Object.freeze(cloned)
}

class DefaultAwakeRequestContext implements AwakeRequestContext {
    readonly playerId: number
    readonly resolver: CharacterAwakeEligibilityResolver

    readonly #evaluationTimeMs: number
    readonly #scopeCharacterIds: readonly number[] | undefined
    readonly #ownedCharacterIds: ReadonlySet<number>
    readonly #supportedMissionIds: ReadonlySet<number>
    readonly #missionIdsByCharacter: ReadonlyMap<number, readonly number[]>
    readonly #categoryContext: CategoryContext | null
    readonly #unlocks: CharacterAwakeUnlockMap
    readonly #evaluations = new Map<string, readonly AwakeUnlockProgress[]>()

    constructor(
        playerId: number,
        evaluationTime: Date,
        scopeCharacterIds: readonly number[] | undefined,
        ownedCharacterIds: readonly number[],
        supportedMissionIds: readonly number[],
        missionIdsByCharacter: ReadonlyMap<number, readonly number[]>,
        categoryContext: CategoryContext | null,
        resolver: CharacterAwakeEligibilityResolver,
        categoryMissions: Readonly<Record<string, PlayerActiveMission>>,
        unlocks: CharacterAwakeUnlockMap,
    ) {
        this.playerId = playerId
        this.#evaluationTimeMs = evaluationTime.getTime()
        this.#scopeCharacterIds = scopeCharacterIds
        this.#ownedCharacterIds = new Set(ownedCharacterIds)
        this.#supportedMissionIds = new Set(supportedMissionIds)
        this.#missionIdsByCharacter = missionIdsByCharacter
        this.#categoryContext = categoryContext
        this.resolver = resolver
        this.#unlocks = cloneAwakeUnlocks(unlocks)
        registerAwakeRequestContext(this, {
            playerId,
            supportedMissionIds: this.#supportedMissionIds,
            categoryMissions,
        })
        Object.freeze(this)
    }

    get evaluationTime(): Date {
        return new Date(this.#evaluationTimeMs)
    }

    evaluate(candidateCharacterIds?: readonly number[]): readonly AwakeUnlockProgress[] {
        const requested = normalizeAwakeCandidateCharacterIds(candidateCharacterIds)
            ?? this.#scopeCharacterIds
        if (this.#scopeCharacterIds !== undefined && requested !== undefined) {
            const scope = new Set(this.#scopeCharacterIds)
            if (requested.some(characterId => !scope.has(characterId))) {
                throw new Error("Awake candidate character is outside the frozen context scope")
            }
        }

        const cacheKey = requested === undefined ? "all" : requested.join(",")
        const cached = this.#evaluations.get(cacheKey)
        if (cached) return cached

        const missionIds = requested === undefined
            ? [...this.#supportedMissionIds]
            : requested.flatMap(characterId => this.#missionIdsByCharacter.get(characterId) ?? [])
                .filter(missionId => this.#supportedMissionIds.has(missionId))
        if (missionIds.length === 0) {
            const empty = Object.freeze([]) as readonly AwakeUnlockProgress[]
            this.#evaluations.set(cacheKey, empty)
            return empty
        }

        const computer = getComputer(CATEGORY)
        const categoryContext = this.#categoryContext
        if (categoryContext === null) {
            throw new Error("Awake context is missing its frozen Session snapshot")
        }
        const progress = missionIds.flatMap(missionId => {
            const characterId = Number(getCharacterIdFromMission(missionId))
            if (!this.#ownedCharacterIds.has(characterId)
                || !this.resolver.isNewUnlockEligible(characterId, missionId)) return []
            const dbProgress = readAwakeRequestContextCategoryMissions(this)
                [String(missionId)]?.progress ?? 0
            return [Object.freeze({
                missionId,
                progress: computer.compute(missionId, categoryContext, dbProgress),
            })]
        })
        const frozen = Object.freeze(progress)
        this.#evaluations.set(cacheKey, frozen)
        return frozen
    }

    readUnlocks(): CharacterAwakeUnlockMap {
        return cloneAwakeUnlocks(this.#unlocks)
    }
}

export {
    assertAwakeRequestContext,
    collectSupportedAwakeMissionIds,
    isAwakeRequestContext,
    readAwakeRequestContextCategoryMissions,
}

export function createAwakeRequestContext(
    options: CreateAwakeRequestContextOptions,
): AwakeRequestContext {
    const playerId = normalizePlayerId(options.playerId)
    const evaluationTime = new Date(options.evaluationTime ?? getServerDate())
    if (!Number.isFinite(evaluationTime.getTime())) {
        throw new TypeError("Awake context evaluationTime must be a valid Date")
    }
    const scopeCharacterIds = normalizeAwakeCandidateCharacterIds(options.candidateCharacterIds)
    const unlocks = getPlayerCharacterAwakeUnlocksSync(playerId)
    const scopedFactCharacterIds = scopeCharacterIds === undefined
        ? undefined
        : mergeAwakeScopedCharacterIds(scopeCharacterIds, [...unlocks.keys()].map(Number))
    const catalog = getMissionCatalog()
    const requirementRegistry = getMissionFactRequirementRegistry(catalog)
    const requestedMissionIds = scopeCharacterIds === undefined
        ? [...catalog.getMissionIds(CATEGORY)]
        : scopeCharacterIds.flatMap(characterId => {
            const missionIds = catalog.getAwakeMissionIdsByCharacter(characterId)
            for (const missionId of missionIds) {
                if (getCharacterIdFromMission(missionId) !== String(characterId)) {
                    throw new Error(`Conflicting Awake Catalog index for character ${characterId}`)
                }
            }
            return missionIds
        })
    const normalizedMissionIds = [...new Set(requestedMissionIds)].sort((left, right) => left - right)
    const collected = collectSupportedAwakeMissionIds(normalizedMissionIds, requirementRegistry)
    const categoryMissions = cloneCategoryMissions(
        getPlayerCategoryMissionsByIdsSync(playerId, CATEGORY, collected.closure),
    )
    const scopedCharacters = scopedFactCharacterIds === undefined
        ? undefined
        : getPlayerCharactersByIdsSync(playerId, scopedFactCharacterIds)
    const usesFact = (kind: "characterClearCounters" | "partyCoClearCounters") => (
        collected.closure.some(missionId => (
            requirementRegistry.getRequirement(CATEGORY, missionId)?.facts
                .some(fact => fact.kind === kind) === true
        ))
    )
    const scopedCharacterClears = scopedFactCharacterIds === undefined
        || !usesFact("characterClearCounters")
        ? undefined
        : getPlayerCharacterClearsByIdsSync(playerId, scopedFactCharacterIds)
    const scopedPartyCoClears = scopedFactCharacterIds === undefined
        || !usesFact("partyCoClearCounters")
        ? undefined
        : getPlayerPartyCoClearCountersByCharacterIdsSync(playerId, scopedFactCharacterIds)
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry,
        candidates: collected.candidates.map(missionId => ({ category: CATEGORY, missionId })),
        orchestratorFacts: [{ kind: "player" }, { kind: "characters" }],
        loaders: createProductionMissionFactLoaderRegistry(undefined, {
            categoryMissions: new Map([[CATEGORY, categoryMissions]]),
            ...(scopedCharacters === undefined ? {} : { characters: scopedCharacters }),
            ...(scopedCharacterClears === undefined ? {} : {
                characterClears: scopedCharacterClears,
            }),
            ...(scopedPartyCoClears === undefined ? {} : {
                partyCoClearCounters: scopedPartyCoClears,
            }),
        }),
    })
    let categoryContext: CategoryContext | null = null
    if (collected.candidates.length > 0) {
        const computer = getComputer(CATEGORY)
        if (!computer.buildContextFromSession) {
            throw new Error("Awake computer does not support MissionEvaluationSession")
        }
        categoryContext = computer.buildContextFromSession(
            session,
            CATEGORY,
            collected.candidates,
        )
    }
    const characters = session.getFact({ kind: "characters" })
    const manaNodes = scopedFactCharacterIds === undefined
        ? getPlayerCharactersManaNodesSync(playerId)
        : getPlayerCharacterManaNodesByIdsSync(playerId, scopedFactCharacterIds)
    const manaNodeAwakeLevels = scopedFactCharacterIds === undefined
        ? getPlayerCharactersManaNodeAwakeLevelsSync(playerId)
        : getPlayerCharactersManaNodeAwakeLevelsByIdsSync(playerId, scopedFactCharacterIds)
    const resolver = createCharacterAwakeEligibilityResolverFromSnapshot({
        characters,
        manaNodes,
        manaNodeAwakeLevels,
        evaluationTime,
    })
    const readinessCharacterIds = new Set([
        ...Object.keys(characters).map(Number),
        ...[...unlocks.keys()].map(Number),
    ])
    for (const characterId of readinessCharacterIds) resolver.getBaseReadiness(characterId)
    const missionIdsByCharacter = new Map<number, readonly number[]>()
    for (const missionId of collected.candidates) {
        const characterId = Number(getCharacterIdFromMission(missionId))
        const missionIds = missionIdsByCharacter.get(characterId) ?? []
        missionIdsByCharacter.set(characterId, Object.freeze([...missionIds, missionId]))
    }

    return new DefaultAwakeRequestContext(
        playerId,
        evaluationTime,
        scopeCharacterIds,
        Object.keys(characters).map(Number),
        collected.candidates,
        missionIdsByCharacter,
        categoryContext,
        resolver,
        categoryMissions,
        unlocks,
    )
}
