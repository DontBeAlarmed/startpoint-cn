"use strict"

function isNonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0
}

function deepFreeze(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const nested of Object.values(value)) deepFreeze(nested)
    return Object.freeze(value)
}

function createActiveMissionObserver() {
    let definitionVisits = 0
    let staticComputes = 0
    let dependencyComputes = 0
    const factLoaders = new Map()

    return Object.freeze({
        definitionVisited() {
            definitionVisits++
        },
        factLoaded(name, rows) {
            if (typeof name !== "string" || name.length === 0) {
                throw new TypeError("fact loader name must be a non-empty string")
            }
            if (!isNonNegativeSafeInteger(rows)) {
                throw new TypeError("fact loader rows must be a non-negative safe integer")
            }
            const previous = factLoaders.get(name) ?? { calls: 0, rows: 0 }
            factLoaders.set(name, {
                calls: previous.calls + 1,
                rows: previous.rows + rows,
            })
        },
        staticComputed() {
            staticComputes++
        },
        dependencyComputed() {
            dependencyComputes++
        },
        snapshot() {
            const sortedFactLoaders = Object.fromEntries(
                [...factLoaders.keys()].sort().map(name => [name, { ...factLoaders.get(name) }]),
            )
            return deepFreeze({
                definitionVisits,
                factLoaders: sortedFactLoaders,
                staticComputes,
                dependencyComputes,
            })
        },
    })
}

module.exports = { createActiveMissionObserver }
