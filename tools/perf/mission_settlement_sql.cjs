"use strict"

const READ_KEYWORDS = new Set(["SELECT"])
const WRITE_KEYWORDS = new Set(["DELETE", "INSERT", "REPLACE", "UPDATE"])
const TRANSACTION_KEYWORDS = new Set([
    "BEGIN", "COMMIT", "END", "RELEASE", "ROLLBACK", "SAVEPOINT",
])
const IDENTIFIER = "[`\"\\[]?[a-z_][a-z0-9_]*[`\"\\]]?"

function normalizeIdentifier(candidate) {
    if (!candidate) return null
    const normalized = candidate.replace(/^[`"[]|[`"\]]$/g, "").toLowerCase()
    return /^[a-z_][a-z0-9_]*$/.test(normalized) ? normalized : null
}

function skipWhitespace(sql, start) {
    let index = start
    while (/\s/.test(sql[index] ?? "")) index++
    return index
}

function readIdentifier(sql, start) {
    const index = skipWhitespace(sql, start)
    const opener = sql[index]
    if (opener === "[" || opener === "\"" || opener === "`") {
        const closer = opener === "[" ? "]" : opener
        const end = sql.indexOf(closer, index + 1)
        if (end < 0) return null
        return {
            name: normalizeIdentifier(sql.slice(index, end + 1)),
            end: end + 1,
        }
    }
    const match = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(index))
    return match ? { name: match[0].toLowerCase(), end: index + match[0].length } : null
}

function readWord(sql, start) {
    const index = skipWhitespace(sql, start)
    const match = /^[a-z_]+/i.exec(sql.slice(index))
    return match ? { word: match[0].toUpperCase(), end: index + match[0].length } : null
}

function skipParenthesized(sql, start) {
    if (sql[start] !== "(") return -1
    let depth = 0
    let quote = null
    for (let index = start; index < sql.length; index++) {
        const character = sql[index]
        if (quote !== null) {
            if (quote === "]" && character === "]") quote = null
            else if (quote !== "]" && character === quote) {
                if (sql[index + 1] === quote) index++
                else quote = null
            }
            continue
        }
        if (character === "'" || character === "\"" || character === "`") quote = character
        else if (character === "[") quote = "]"
        else if (character === "-" && sql[index + 1] === "-") {
            const newline = sql.indexOf("\n", index + 2)
            if (newline < 0) return sql.length
            index = newline
        } else if (character === "/" && sql[index + 1] === "*") {
            const end = sql.indexOf("*/", index + 2)
            if (end < 0) return sql.length
            index = end + 1
        } else if (character === "(") depth++
        else if (character === ")" && --depth === 0) return index + 1
    }
    return -1
}

// Covers the CTE form emitted or inspected by this project, not arbitrary SQLite grammar.
function unwrapSupportedCtes(sql) {
    let index = skipWhitespace(sql, 0)
    const withWord = readWord(sql, index)
    if (withWord?.word !== "WITH") return { aliases: new Set(), mainSql: sql }
    index = withWord.end
    const recursive = readWord(sql, index)
    if (recursive?.word === "RECURSIVE") index = recursive.end

    const aliases = new Set()
    while (index < sql.length) {
        const identifier = readIdentifier(sql, index)
        if (!identifier?.name) return { aliases: new Set(), mainSql: sql }
        aliases.add(identifier.name)
        index = skipWhitespace(sql, identifier.end)
        if (sql[index] === "(") {
            index = skipParenthesized(sql, index)
            if (index < 0) return { aliases: new Set(), mainSql: sql }
        }
        const asWord = readWord(sql, index)
        if (asWord?.word !== "AS") return { aliases: new Set(), mainSql: sql }
        index = asWord.end
        const modifier = readWord(sql, index)
        if (modifier?.word === "NOT") {
            const materialized = readWord(sql, modifier.end)
            if (materialized?.word !== "MATERIALIZED") {
                return { aliases: new Set(), mainSql: sql }
            }
            index = materialized.end
        } else if (modifier?.word === "MATERIALIZED") index = modifier.end
        index = skipWhitespace(sql, index)
        if (sql[index] !== "(") return { aliases: new Set(), mainSql: sql }
        index = skipParenthesized(sql, index)
        if (index < 0) return { aliases: new Set(), mainSql: sql }
        index = skipWhitespace(sql, index)
        if (sql[index] !== ",") break
        index++
    }
    return { aliases, mainSql: sql.slice(index) }
}

function findReadTables(sql, cteAliases) {
    const tables = new Set()
    const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+(${IDENTIFIER})`, "gi")
    for (const match of sql.matchAll(pattern)) {
        const table = normalizeIdentifier(match[1])
        if (table && !cteAliases.has(table)) tables.add(table)
    }
    return tables
}

function findWriteTarget(mainSql, keyword) {
    let pattern
    if (keyword === "UPDATE") pattern = new RegExp(`^\\s*UPDATE\\s+(${IDENTIFIER})`, "i")
    else if (keyword === "DELETE") pattern = new RegExp(`^\\s*DELETE\\s+FROM\\s+(${IDENTIFIER})`, "i")
    else if (keyword === "INSERT") {
        pattern = new RegExp(`^\\s*INSERT(?:\\s+OR\\s+[A-Z_]+)?\\s+INTO\\s+(${IDENTIFIER})`, "i")
    } else if (keyword === "REPLACE") {
        pattern = new RegExp(`^\\s*REPLACE\\s+INTO\\s+(${IDENTIFIER})`, "i")
    }
    return normalizeIdentifier(pattern?.exec(mainSql)?.[1])
}

function classifyStatement(sql) {
    const normalized = String(sql).trim()
    const { aliases, mainSql } = unwrapSupportedCtes(normalized)
    const keyword = readWord(mainSql, 0)?.word ?? ""
    const transaction = TRANSACTION_KEYWORDS.has(keyword)
    const select = READ_KEYWORDS.has(keyword)
    const write = WRITE_KEYWORDS.has(keyword)
    const readTables = select || write ? findReadTables(normalized, aliases) : new Set()
    const writeTarget = write ? findWriteTarget(mainSql, keyword) : null
    if (keyword === "DELETE" && writeTarget) readTables.delete(writeTarget)
    return {
        select,
        write,
        transaction,
        readTables,
        writeTables: new Set(writeTarget ? [writeTarget] : []),
    }
}

function sortedTableStats(byTable) {
    return Object.fromEntries([...byTable.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([table, counts]) => [table, { ...counts }]))
}

function createSqlCounter() {
    let total = 0
    let select = 0
    let writes = 0
    let transactions = 0
    let other = 0
    const byTable = new Map()

    return {
        observe(sql) {
            const statement = classifyStatement(sql)
            total++
            if (statement.select) select++
            else if (statement.write) writes++
            else if (statement.transaction) transactions++
            else other++

            const tables = new Set([...statement.readTables, ...statement.writeTables])
            for (const table of tables) {
                const counts = byTable.get(table) ?? { total: 0, select: 0, writes: 0 }
                counts.total++
                if (statement.readTables.has(table)) counts.select++
                if (statement.writeTables.has(table)) counts.writes++
                byTable.set(table, counts)
            }
        },
        reset() {
            total = 0
            select = 0
            writes = 0
            transactions = 0
            other = 0
            byTable.clear()
        },
        snapshot() {
            return {
                total,
                select,
                writes,
                transactions,
                other,
                byTable: sortedTableStats(byTable),
            }
        },
    }
}

module.exports = { createSqlCounter }
