import { getFactKeyId, normalizeFactKey, type FactIdSelection, type FactKey } from "./facts/fact-key"
import { buildFactLoadPlan } from "./facts/load-plan"
import {
    type MissionFactLoader,
    type MissionFactLoaderRegistry,
    type MissionFactValue,
} from "./fact-loaders"
import type { MissionFactLoadPlan } from "./facts/types"
import type { MissionCatalog } from "./mission-catalog"
import type {
    MissionFactRequirement,
    MissionFactRequirementRegistry,
    MissionRef,
} from "./requirements/types"

export interface MissionEvaluationCandidateRequirement extends MissionRef {
    readonly requirement: MissionFactRequirement
}

export interface MissionEvaluationObserver {
    readonly onPlan?: (plan: MissionFactLoadPlan) => void
    readonly onLoaderCall?: (key: FactKey) => void
    readonly onCacheHit?: (requestedKey: FactKey, loadedKey: FactKey) => void
}

export interface MissionEvaluationSessionOptions {
    readonly playerId: number
    readonly evaluationTime: Date
    readonly catalog: MissionCatalog
    readonly requirementRegistry: MissionFactRequirementRegistry
    readonly candidates: readonly MissionRef[]
    readonly orchestratorFacts?: readonly FactKey[]
    readonly loaders: MissionFactLoaderRegistry
    readonly observer?: MissionEvaluationObserver
}

type CachedFact =
    | Readonly<{ status: "loading" }>
    | Readonly<{ status: "loaded"; value: unknown }>
    | Readonly<{ status: "failed"; error: unknown }>

type ObserverInvocation =
    | readonly [event: "onPlan"]
    | readonly [event: "onLoaderCall", key: FactKey]
    | readonly [event: "onCacheHit", requestedKey: FactKey, loadedKey: FactKey]

function selectionCovers(planned: FactIdSelection, requested: FactIdSelection): boolean {
    if (planned === "all") return true
    if (requested === "all") return false
    const plannedValues = new Set(planned)
    return requested.every(value => plannedValues.has(value))
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return value !== null
        && (typeof value === "object" || typeof value === "function")
        && typeof (value as { then?: unknown }).then === "function"
}

function consumePromiseLike(value: PromiseLike<unknown>): void {
    void Promise.resolve(value).catch(() => undefined)
}

export class MissionEvaluationSession {
    readonly playerId: number
    readonly catalog: MissionCatalog
    readonly requirementRegistry: MissionFactRequirementRegistry
    readonly candidateRequirements: readonly MissionEvaluationCandidateRequirement[]
    readonly factLoadPlan: MissionFactLoadPlan

    readonly #evaluationTimeMs: number
    private readonly observer?: MissionEvaluationObserver
    readonly #plannedById: ReadonlyMap<string, FactKey>
    readonly #loadersByKind: ReadonlyMap<FactKey["kind"], MissionFactLoader | undefined>
    readonly #cachedById = new Map<string, CachedFact>()
    #observing = false

    constructor(options: MissionEvaluationSessionOptions) {
        const evaluationTimeMs = options.evaluationTime.getTime()
        if (!Number.isFinite(evaluationTimeMs)) {
            throw new TypeError("Mission evaluationTime must be a valid Date")
        }

        this.playerId = options.playerId
        this.#evaluationTimeMs = evaluationTimeMs
        this.catalog = options.catalog
        this.requirementRegistry = options.requirementRegistry
        this.observer = options.observer

        const facts: FactKey[] = [...(options.orchestratorFacts ?? [])]
        const candidates = options.candidates.map(candidate => {
            const requirement = options.requirementRegistry.getRequirement(
                candidate.category,
                candidate.missionId,
            )
            if (requirement === undefined) {
                throw new Error(
                    `Mission requirement not found for ${candidate.category}:${candidate.missionId}`,
                )
            }
            facts.push(...requirement.facts)
            return Object.freeze({
                category: candidate.category,
                missionId: candidate.missionId,
                requirement,
            })
        })

        this.candidateRequirements = Object.freeze(candidates)
        this.factLoadPlan = buildFactLoadPlan(facts)
        this.#plannedById = new Map(this.factLoadPlan.keys.map(key => [getFactKeyId(key), key]))
        const loadersByKind = new Map<FactKey["kind"], MissionFactLoader | undefined>()
        for (const key of this.factLoadPlan.keys) {
            if (!loadersByKind.has(key.kind)) loadersByKind.set(key.kind, options.loaders.get(key))
        }
        this.#loadersByKind = loadersByKind
        Object.freeze(this)
        this.observe("onPlan")
    }

    get evaluationTime(): Date {
        return new Date(this.#evaluationTimeMs)
    }

    getFact<Key extends FactKey>(key: Key): MissionFactValue<Key> {
        const requestedKey = normalizeFactKey(key)
        const plannedKey = this.resolvePlannedKey(requestedKey)
        return this.loadFact(requestedKey, plannedKey)
    }

    getFactFromPlan<Key extends FactKey>(
        key: Key,
        plan: MissionFactLoadPlan,
    ): MissionFactValue<Key> {
        const requestedKey = normalizeFactKey(key)
        const plannedKey = this.resolvePlannedKey(requestedKey, plan)
        this.resolvePlannedKey(plannedKey)
        return this.loadFact(requestedKey, plannedKey)
    }

    private loadFact<Key extends FactKey>(
        requestedKey: FactKey,
        plannedKey: FactKey,
    ): MissionFactValue<Key> {
        const plannedId = getFactKeyId(plannedKey)
        const cached = this.#cachedById.get(plannedId)
        if (cached !== undefined) {
            if (cached.status === "loading") {
                throw new Error(`Reentrant mission fact load for ${plannedId}`)
            }
            this.observe("onCacheHit", requestedKey, plannedKey)
            if (cached.status === "failed") throw cached.error
            return cached.value as MissionFactValue<Key>
        }

        const loader = this.#loadersByKind.get(plannedKey.kind)
        if (loader === undefined) {
            throw new Error(`No mission fact loader registered for kind ${plannedKey.kind}`)
        }

        this.#cachedById.set(plannedId, Object.freeze({ status: "loading" }))
        this.observe("onLoaderCall", plannedKey)
        try {
            const value = loader({
                playerId: this.playerId,
                evaluationTime: this.evaluationTime,
                catalog: this.catalog,
                requirementRegistry: this.requirementRegistry,
                key: plannedKey,
            })
            if (isPromiseLike(value)) {
                consumePromiseLike(value)
                throw new TypeError(`Mission fact loader for ${plannedId} must be synchronous`)
            }
            this.#cachedById.set(plannedId, Object.freeze({ status: "loaded", value }))
            return value as MissionFactValue<Key>
        } catch (error) {
            this.#cachedById.set(plannedId, Object.freeze({ status: "failed", error }))
            throw error
        }
    }

    private resolvePlannedKey(
        requestedKey: FactKey,
        plan: MissionFactLoadPlan = this.factLoadPlan,
    ): FactKey {
        if (requestedKey.kind === "questProgress") {
            return this.resolveSelectionKey(requestedKey, "sections", plan)
        }
        if (requestedKey.kind === "collectedItems") {
            return this.resolveSelectionKey(requestedKey, "itemIds", plan)
        }

        const planned = plan === this.factLoadPlan
            ? this.#plannedById.get(getFactKeyId(requestedKey))
            : plan.keys.find(key => getFactKeyId(key) === getFactKeyId(requestedKey))
        if (planned === undefined) {
            throw new Error(`Mission fact ${getFactKeyId(requestedKey)} was not declared`)
        }
        return planned
    }

    private resolveSelectionKey<
        Key extends Extract<FactKey, { kind: "questProgress" | "collectedItems" }>,
        Field extends Key["kind"] extends "questProgress" ? "sections" : "itemIds",
    >(requestedKey: Key, field: Field, plan: MissionFactLoadPlan): FactKey {
        const planned = plan.keys.find(key => key.kind === requestedKey.kind)
        if (planned === undefined) {
            throw new Error(`Mission fact ${getFactKeyId(requestedKey)} was not declared`)
        }

        const plannedSelection = planned.kind === "questProgress"
            ? planned.sections
            : planned.kind === "collectedItems"
                ? planned.itemIds
                : undefined
        const requestedSelection = requestedKey.kind === "questProgress"
            ? requestedKey.sections
            : requestedKey.itemIds
        if (plannedSelection === undefined || !selectionCovers(plannedSelection, requestedSelection)) {
            throw new Error(
                `Mission fact ${getFactKeyId(requestedKey)} is outside declared ${String(field)} selection`,
            )
        }
        return planned
    }

    private observe(...invocation: ObserverInvocation): void {
        if (this.observer === undefined || this.#observing) return
        this.#observing = true
        try {
            let result: unknown
            switch (invocation[0]) {
                case "onPlan": {
                    const callback = this.observer.onPlan
                    result = callback?.(this.factLoadPlan)
                    break
                }
                case "onLoaderCall": {
                    const callback = this.observer.onLoaderCall
                    result = callback?.(invocation[1])
                    break
                }
                case "onCacheHit": {
                    const callback = this.observer.onCacheHit
                    result = callback?.(invocation[1], invocation[2])
                    break
                }
            }
            if (isPromiseLike(result)) consumePromiseLike(result)
        } catch {
            // Observability must never change mission evaluation behavior.
        } finally {
            this.#observing = false
        }
    }
}
