"use strict"

let nextFaultId = 1

function quoteIdentifier(value) {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new TypeError("fault injection identifiers must be simple SQL identifiers")
    }
    return `"${value}"`
}

function quoteLiteral(value) {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError("fault injection message must be a non-empty string")
    }
    return `'${value.replaceAll("'", "''")}'`
}

function requireEvent(value) {
    if (!/^(?:BEFORE|AFTER) (?:INSERT|DELETE|UPDATE(?: OF [A-Za-z_][A-Za-z0-9_]*)?)$/.test(value)) {
        throw new TypeError("unsupported fault injection event")
    }
    return value
}

function installSqliteFaultInjection(db, {
    name,
    table,
    event,
    when = "1",
    message,
    observations = [],
}) {
    if (db === null || typeof db !== "object" || typeof db.exec !== "function") {
        throw new TypeError("db must provide exec")
    }
    if (!Array.isArray(observations)) throw new TypeError("observations must be an array")
    const observationNames = observations.map(observation => {
        if (typeof observation?.name !== "string" || observation.name.length === 0) {
            throw new TypeError("observation name must be a non-empty string")
        }
        if (typeof observation.sql !== "string" || observation.sql.length === 0) {
            throw new TypeError("observation SQL must be a non-empty string")
        }
        return observation.name
    })
    const triggerName = quoteIdentifier(name)
    const functionName = `non_multi_fault_${process.pid}_${nextFaultId++}`
    const hits = []
    db.function(functionName, { varargs: true }, (...values) => {
        hits.push(Object.fromEntries(observationNames.map((key, index) => [key, values[index]])))
        return 0
    })
    const observationSql = observations.map(observation => observation.sql).join(", ")
    db.exec(`
        CREATE TEMP TRIGGER ${triggerName}
        ${requireEvent(event)} ON ${quoteIdentifier(table)}
        WHEN ${when}
        BEGIN
            SELECT ${quoteIdentifier(functionName)}(${observationSql});
            SELECT RAISE(ABORT, ${quoteLiteral(message)});
        END;
    `)
    let installed = true
    return {
        hits,
        uninstall() {
            if (!installed) return
            installed = false
            if (db.open === false) return
            db.exec(`DROP TRIGGER IF EXISTS temp.${triggerName}`)
        },
    }
}

module.exports = { installSqliteFaultInjection }
