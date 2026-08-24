"use strict"

require("ts-node/register/transpile-only")

const { isDeepStrictEqual } = require("node:util")

function normalizedIds(values) {
    return [...new Set((values ?? []).filter(value => (
        Number.isSafeInteger(value) && value > 0
    )))].sort((left, right) => left - right)
}

function characterListIds(characterLists) {
    return normalizedIds((characterLists ?? []).flatMap(characterList => (
        (characterList ?? []).map(character => character?.character_id)
    )))
}

function normalizedFactIds(keys) {
    const { getFactKeyId } = require("../../src/lib/mission/facts/fact-key")
    return [...new Set((keys ?? []).map(getFactKeyId))].sort()
}

function observation(kind, {
    explicitCharacterIds = [],
    characterLists = [],
    candidateCharacterIds = [],
    scope = {},
} = {}) {
    const explicitCharacterSeeds = normalizedIds(explicitCharacterIds)
    const characterListSeeds = characterListIds(characterLists)
    const contextCandidateCharacterSeeds = normalizedIds(candidateCharacterIds)
    return Object.freeze({
        kind,
        explicitCharacterSeeds,
        characterListSeeds,
        contextCandidateCharacterSeeds,
        characterSeeds: normalizedIds([
            ...explicitCharacterSeeds,
            ...characterListSeeds,
            ...contextCandidateCharacterSeeds,
        ]),
        factSeeds: normalizedFactIds(scope.invalidatedFactKeys),
        directMissionSeeds: normalizedIds(scope.directMissionIds),
    })
}

function installAwakeOwnerFocusedObserver() {
    const bestEffort = require("../../src/lib/mission/awake-best-effort-context")
    const strictContext = require("../../src/lib/mission/awake-request-context")
    const originals = {
        publish: bestEffort.publishAwakeCharacterListBestEffort,
        bestEffortContext: bestEffort.createAwakeRequestContextBestEffort,
        strictContext: strictContext.createAwakeRequestContext,
    }
    let active = null
    let nestedHelperDepth = 0

    bestEffort.publishAwakeCharacterListBestEffort = function observedPublish(
        playerId,
        explicitCharacterIds,
        characterLists,
        scope = {},
    ) {
        if (nestedHelperDepth === 0) active?.push(observation("publish-wrapper", {
            explicitCharacterIds, characterLists, scope,
        }))
        nestedHelperDepth++
        try {
            return originals.publish.call(this, playerId, explicitCharacterIds, characterLists, scope)
        } finally {
            nestedHelperDepth--
        }
    }
    bestEffort.createAwakeRequestContextBestEffort = function observedBestEffortContext(
        playerId,
        candidateCharacterIds,
        scope = {},
    ) {
        if (nestedHelperDepth === 0) active?.push(observation(
            "best-effort-context", { candidateCharacterIds, scope },
        ))
        nestedHelperDepth++
        try {
            return originals.bestEffortContext.call(this, playerId, candidateCharacterIds, scope)
        } finally {
            nestedHelperDepth--
        }
    }
    strictContext.createAwakeRequestContext = function observedStrictContext(options) {
        if (nestedHelperDepth === 0) active?.push(observation("strict-context", {
            candidateCharacterIds: options?.candidateCharacterIds,
            scope: options,
        }))
        return originals.strictContext.call(this, options)
    }

    return {
        begin() {
            if (active !== null) throw new Error("Awake owner observer capture is already active")
            active = []
        },
        end() {
            if (active === null) throw new Error("Awake owner observer capture is not active")
            const captured = active
            active = null
            if (captured.length !== 1) {
                throw new Error(`Awake owner scenario must observe exactly one publication, got ${captured.length}`)
            }
            return captured[0]
        },
        cancel() { active = null },
        restore() {
            active = null
            bestEffort.publishAwakeCharacterListBestEffort = originals.publish
            bestEffort.createAwakeRequestContextBestEffort = originals.bestEffortContext
            strictContext.createAwakeRequestContext = originals.strictContext
        },
    }
}

function assertObservedPublication(expected, observed, owner) {
    for (const field of [
        "kind",
        "explicitCharacterSeeds",
        "characterListSeeds",
        "contextCandidateCharacterSeeds",
        "characterSeeds",
        "factSeeds",
        "directMissionSeeds",
    ]) {
        if (!isDeepStrictEqual(expected[field], observed[field])) {
            throw new Error(
                `${owner} declared ${field} differs from runtime observation: `
                    + `expected=${JSON.stringify(expected[field])} `
                    + `observed=${JSON.stringify(observed[field])}`,
            )
        }
    }
}

module.exports = {
    assertObservedPublication,
    installAwakeOwnerFocusedObserver,
}
