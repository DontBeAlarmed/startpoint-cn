"use strict"

function quoteSqlIdentifier(identifier) {
    if (typeof identifier !== "string") throw new TypeError("SQL identifier must be a string")
    return `"${identifier.replaceAll('"', '""')}"`
}

function ownerColumns(tableName, columns) {
    const accountOwnerColumns = columns.includes("account_id") ? ["account_id"] : []
    const playerOwnerColumns = columns.includes("player_id") ? ["player_id"] : []
    if (tableName === "accounts" && columns.includes("id")) accountOwnerColumns.push("id")
    if (tableName === "players" && columns.includes("id")) playerOwnerColumns.push("id")
    return { accountOwnerColumns, playerOwnerColumns }
}

function snapshotNonMultiMixedOwnerState(db) {
    if (db === null || typeof db !== "object" || typeof db.prepare !== "function") {
        throw new TypeError("db must provide prepare")
    }
    const schemaTables = db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all()
    const tables = []
    for (const { name } of schemaTables) {
        const quotedName = quoteSqlIdentifier(name)
        const columns = db.prepare(`PRAGMA table_info(${quotedName})`)
            .all()
            .map(column => column.name)
        const owners = ownerColumns(name, columns)
        if (owners.accountOwnerColumns.length === 0 && owners.playerOwnerColumns.length === 0) {
            continue
        }
        const orderBy = columns.map(quoteSqlIdentifier).join(", ")
        tables.push({
            name,
            ...owners,
            rows: db.prepare(`SELECT * FROM ${quotedName} ORDER BY ${orderBy}`).all(),
        })
    }
    return { tables }
}

function projectNonMultiMixedOwnerState(state, identity) {
    return {
        tables: state.tables.map(table => ({
            name: table.name,
            accountOwnerColumns: [...table.accountOwnerColumns],
            playerOwnerColumns: [...table.playerOwnerColumns],
            rows: table.rows.filter(row => (
                !table.accountOwnerColumns.some(column => row[column] === identity.accountId)
                && !table.playerOwnerColumns.some(column => row[column] === identity.playerId)
            )),
        })),
    }
}

module.exports = {
    projectNonMultiMixedOwnerState,
    quoteSqlIdentifier,
    snapshotNonMultiMixedOwnerState,
}
