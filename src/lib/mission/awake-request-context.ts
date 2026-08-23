import {
    getPlayerCharactersManaNodeAwakeLevelsSync,
    getPlayerCharactersManaNodesSync,
} from "../../data/domains/character"
import {
    getPlayerCharacterAwakeUnlocksSync,
    type CharacterAwakeUnlockMap,
} from "../../data/domains/character_awake"
import { getPlayerCategoryMissionsByIdsSync } from "../../data/domains/mission"
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
import type { MissionFactRequirementRegistry } from "./requirements/types"
import { getComputer } from "./registry"
import type { AwakeUnlockProgress } from "./awake-unlock"
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
const INTERNAL_STATE = Symbol("AwakeRequestContextState")

interface AwakeRequestContextState {
    readonly categoryMissions: Readonly<Record<string, PlayerActiveMission>>
}

interface InternalAwakeRequestContext extends AwakeRequestContext {
    readonly [INTERNAL_STATE]: AwakeRequestContextState
}

function normalizePlayerId(playerId: number): number {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw new TypeError("Awake context playerId must be a positive safe integer")
    }
    return playerId
}

function normalizeCandidateCharacterIds(
    candidateCharacterIds: readonly number[] | undefined,
): readonly number[] | undefined {
    if (candidateCharacterIds === undefined) return undefined
    if (!Array.isArray(candidateCharacterIds)) {
        throw new TypeError("Awake candidateCharacterIds must be an array")
    }
    for (let index = 0; index < candidateCharacterIds.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(candidateCharacterIds, index)) {
            throw new TypeError("Awake candidateCharacterIds array must be complete")
        }
    }
    const normalized = candidateCharacterIds.map(characterId => {
        if (!Number.isSafeInteger(characterId) || characterId <= 0) {
            throw new TypeError("Awake candidate character IDs must be positive safe integers")
        }
        return characterId
    })
    return Object.freeze([...new Set(normalized)].sort((left, right) => left - right))
}

function collectSupportedMissionIds(
    missionIds: readonly number[],
    requirementRegistry: MissionFactRequirementRegistry,
): { readonly candidates: readonly number[]; readonly closure: readonly number[] } {
    const supported = new Map<number, boolean>()
    const closure = new Set<number>()
    const visit = (missionId: number, visiting: Set<number>): boolean => {
        const cached = supported.get(missionId)
        if (cached !== undefined) return cached
        if (visiting.has(missionId)) return false
        const requirement = requirementRegistry.getRequirement(CATEGORY, missionId)
        if (!requirement || requirement.mode === "unsupported") {
            supported.set(missionId, false)
            return false
        }
        const nextVisiting = new Set(visiting).add(missionId)
        let valid = true
        for (const dependency of requirement.missionDependencies) {
            if (dependency.category !== CATEGORY || !visit(dependency.missionId, nextVisiting)) {
                valid = false
            }
        }
        for (const fact of requirement.facts) {
            if (fact.kind !== "categoryMissionProgress") continue
            if (fact.category !== CATEGORY) valid = false
            else for (const dependencyId of fact.missionIds) closure.add(dependencyId)
        }
        supported.set(missionId, valid)
        if (valid) closure.add(missionId)
        return valid
    }
    const candidates = missionIds.filter(missionId => visit(missionId, new Set()))
    return {
        candidates: Object.freeze(candidates),
        closure: Object.freeze([...closure].sort((left, right) => left - right)),
    }
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

class DefaultAwakeRequestContext implements InternalAwakeRequestContext {
    readonly playerId: number
    readonly resolver: CharacterAwakeEligibilityResolver
    readonly [INTERNAL_STATE]: AwakeRequestContextState

    readonly #evaluationTimeMs: number
    readonly #scopeCharacterIds: readonly number[] | undefined
    readonly #supportedMissionIds: ReadonlySet<number>
    readonly #missionIdsByCharacter: ReadonlyMap<number, readonly number[]>
    readonly #categoryContext: CategoryContext | null
    readonly #unlocks: CharacterAwakeUnlockMap
    readonly #evaluations = new Map<string, readonly AwakeUnlockProgress[]>()

    constructor(
        playerId: number,
        evaluationTime: Date,
        scopeCharacterIds: readonly number[] | undefined,
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
        this.#supportedMissionIds = new Set(supportedMissionIds)
        this.#missionIdsByCharacter = missionIdsByCharacter
        this.#categoryContext = categoryContext
        this.resolver = resolver
        this[INTERNAL_STATE] = Object.freeze({ categoryMissions })
        this.#unlocks = unlocks
        Object.freeze(this)
    }

    get evaluationTime(): Date {
        return new Date(this.#evaluationTimeMs)
    }

    evaluate(candidateCharacterIds?: readonly number[]): readonly AwakeUnlockProgress[] {
        const requested = normalizeCandidateCharacterIds(candidateCharacterIds)
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
            if (!this.resolver.characters[String(characterId)]
                || !this.resolver.isNewUnlockEligible(characterId, missionId)) return []
            const dbProgress = this[INTERNAL_STATE]
                .categoryMissions[String(missionId)]?.progress ?? 0
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
        return this.#unlocks
    }
}

export function assertAwakeRequestContext(
    context: AwakeRequestContext,
    playerId: number,
): asserts context is AwakeRequestContext {
    if (!(context instanceof DefaultAwakeRequestContext)) {
        throw new TypeError("Awake context is invalid; use createAwakeRequestContext factory")
    }
    if (context.playerId !== playerId) {
        throw new Error(
            `Awake context player mismatch: expected ${playerId}, received ${context.playerId}`,
        )
    }
}

export function readAwakeRequestContextCategoryMissions(
    context: AwakeRequestContext,
): Readonly<Record<string, PlayerActiveMission>> {
    assertAwakeRequestContext(context, context.playerId)
    return (context as InternalAwakeRequestContext)[INTERNAL_STATE].categoryMissions
}

export function createAwakeRequestContext(
    options: CreateAwakeRequestContextOptions,
): AwakeRequestContext {
    const playerId = normalizePlayerId(options.playerId)
    const evaluationTime = new Date(options.evaluationTime ?? getServerDate())
    if (!Number.isFinite(evaluationTime.getTime())) {
        throw new TypeError("Awake context evaluationTime must be a valid Date")
    }
    const scopeCharacterIds = normalizeCandidateCharacterIds(options.candidateCharacterIds)
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
    const collected = collectSupportedMissionIds(normalizedMissionIds, requirementRegistry)
    const categoryMissions = cloneCategoryMissions(
        getPlayerCategoryMissionsByIdsSync(playerId, CATEGORY, collected.closure),
    )
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry,
        candidates: collected.candidates.map(missionId => ({ category: CATEGORY, missionId })),
        orchestratorFacts: [{ kind: "player" }, { kind: "characters" }],
        loaders: createProductionMissionFactLoaderRegistry(undefined, {
            categoryMissions: new Map([[CATEGORY, categoryMissions]]),
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
    const resolver = createCharacterAwakeEligibilityResolverFromSnapshot({
        characters,
        manaNodes: getPlayerCharactersManaNodesSync(playerId),
        manaNodeAwakeLevels: getPlayerCharactersManaNodeAwakeLevelsSync(playerId),
        evaluationTime,
    })
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
        collected.candidates,
        missionIdsByCharacter,
        categoryContext,
        resolver,
        categoryMissions,
        getPlayerCharacterAwakeUnlocksSync(playerId),
    )
}
