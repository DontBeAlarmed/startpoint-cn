"use strict"

const IDENTIFIER = "[`\"\\[]?[a-z_][a-z0-9_]*[`\"\\]]?"
const CONFLICT_ACTION = "(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE)"
const TRANSACTION_NAME = "(?:[a-z_][a-z0-9_]*|`[^`]+`|\"[^\"]+\"|\\[[^\\]]+\\])"

function normalizeIdentifier(candidate) {
    const normalized = candidate?.replace(/^[`"[]|[`"\]]$/g, "").toLowerCase()
    return normalized && /^[a-z_][a-z0-9_]*$/.test(normalized) ? normalized : null
}

function unsupported(sql) {
    const preview = String(sql).trim().replace(/\s+/g, " ").slice(0, 120)
    return new Error(`Unsupported SQL in mission settlement baseline: ${preview}`)
}

function maskStringsAndRejectComments(sql) {
    const maskedStrings = sql.replace(/'(?:''|[^'])*'/gs, match => " ".repeat(match.length))
    const masked = maskedStrings.replace(
        /\/\*\+[1-9][0-9]* bytes\*\//g,
        match => " ".repeat(match.length),
    )
    if (masked.includes("'") || /--|\/\*/.test(masked)) throw unsupported(sql)
    return masked
}

function findReadTables(sql) {
    const tables = new Set()
    const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+(${IDENTIFIER})`, "gi")
    for (const match of sql.matchAll(pattern)) {
        const table = normalizeIdentifier(match[1])
        if (!table) throw unsupported(sql)
        tables.add(table)
    }
    return tables
}

function matchWrite(sql, pattern) {
    const match = pattern.exec(sql)
    const target = normalizeIdentifier(match?.[1])
    if (!target) throw unsupported(sql)
    return { match, target }
}

function isTransaction(sql) {
    return new RegExp(
        `^(?:`
        + `BEGIN(?:\\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\\s+TRANSACTION)?`
        + `|(?:COMMIT|END)(?:\\s+TRANSACTION)?`
        + `|ROLLBACK(?:\\s+TRANSACTION)?(?:\\s+TO(?:\\s+SAVEPOINT)?\\s+${TRANSACTION_NAME})?`
        + `|SAVEPOINT\\s+${TRANSACTION_NAME}`
        + `|RELEASE(?:\\s+SAVEPOINT)?\\s+${TRANSACTION_NAME}`
        + `)\\s*;?$`,
        "i",
    ).test(sql)
}

function classifyStatement(rawSql) {
    const sql = String(rawSql).trim()
    if (!sql) throw unsupported(rawSql)
    const masked = maskStringsAndRejectComments(sql)

    if (/^SELECT\b/i.test(masked)) {
        return { type: "select", readTables: findReadTables(masked), writeTables: new Set() }
    }

    if (/^INSERT\b/i.test(masked)) {
        const { target } = matchWrite(masked, new RegExp(
            `^INSERT(?:\\s+OR\\s+${CONFLICT_ACTION})?\\s+INTO\\s+(${IDENTIFIER})`
            + `(?:\\s*\\([^)]*\\))?\\s+VALUES\\b`,
            "is",
        ))
        return { type: "write", readTables: new Set(), writeTables: new Set([target]) }
    }

    if (/^UPDATE\b/i.test(masked)) {
        const { target } = matchWrite(masked, new RegExp(
            `^UPDATE(?:\\s+OR\\s+${CONFLICT_ACTION})?\\s+(${IDENTIFIER})\\s+SET\\b`,
            "is",
        ))
        return {
            type: "write",
            readTables: findReadTables(masked),
            writeTables: new Set([target]),
        }
    }

    if (/^DELETE\b/i.test(masked)) {
        const { match, target } = matchWrite(masked, new RegExp(
            `^DELETE\\s+FROM\\s+(${IDENTIFIER})\\b`,
            "is",
        ))
        return {
            type: "write",
            readTables: findReadTables(masked.slice(match[0].length)),
            writeTables: new Set([target]),
        }
    }

    if (isTransaction(masked)) {
        return { type: "transaction", readTables: new Set(), writeTables: new Set() }
    }
    throw unsupported(rawSql)
}

function sortedTableStats(byTable) {
    return Object.fromEntries([...byTable.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([table, counts]) => [table, { ...counts }]))
}

function createSqlCounter() {
    let statements = 0
    let selectStatements = 0
    let writeStatements = 0
    let transactionStatements = 0
    const byTable = new Map()

    return {
        observe(sql) {
            const statement = classifyStatement(sql)
            statements++
            if (statement.type === "select") selectStatements++
            else if (statement.type === "write") writeStatements++
            else transactionStatements++

            const tables = new Set([...statement.readTables, ...statement.writeTables])
            for (const table of tables) {
                const counts = byTable.get(table) ?? { statements: 0, reads: 0, writes: 0 }
                counts.statements++
                if (statement.readTables.has(table)) counts.reads++
                if (statement.writeTables.has(table)) counts.writes++
                byTable.set(table, counts)
            }
        },
        reset() {
            statements = 0
            selectStatements = 0
            writeStatements = 0
            transactionStatements = 0
            byTable.clear()
        },
        snapshot() {
            return {
                statements,
                selectStatements,
                writeStatements,
                transactionStatements,
                byTable: sortedTableStats(byTable),
            }
        },
    }
}

module.exports = { createSqlCounter }
