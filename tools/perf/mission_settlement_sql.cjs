"use strict"

const READ_KEYWORDS = new Set(["SELECT"])
const WRITE_KEYWORDS = new Set(["DELETE", "INSERT", "REPLACE", "UPDATE"])

function addTable(tables, candidate) {
    if (!candidate) return
    const normalized = candidate.replace(/^[`"[]|[`"\]]$/g, "").toLowerCase()
    if (/^[a-z_][a-z0-9_]*$/.test(normalized)) tables.add(normalized)
}

function findTables(sql, keyword) {
    const tables = new Set()
    if (keyword === "SELECT") {
        for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([`"\[]?[a-z_][a-z0-9_]*[`"\]]?)/gi)) {
            addTable(tables, match[1])
        }
    } else if (keyword === "INSERT" || keyword === "REPLACE") {
        addTable(tables, /\bINTO\s+([`"\[]?[a-z_][a-z0-9_]*[`"\]]?)/i.exec(sql)?.[1])
    } else if (keyword === "UPDATE") {
        addTable(tables, /\bUPDATE\s+([`"\[]?[a-z_][a-z0-9_]*[`"\]]?)/i.exec(sql)?.[1])
    } else if (keyword === "DELETE") {
        addTable(tables, /\bFROM\s+([`"\[]?[a-z_][a-z0-9_]*[`"\]]?)/i.exec(sql)?.[1])
    }
    return tables
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
    let other = 0
    const byTable = new Map()

    return {
        observe(sql) {
            const normalized = String(sql).trim()
            const keyword = /^([A-Z]+)/i.exec(normalized)?.[1]?.toUpperCase() ?? ""
            const isSelect = READ_KEYWORDS.has(keyword)
            const isWrite = WRITE_KEYWORDS.has(keyword)
            total++
            if (isSelect) select++
            else if (isWrite) writes++
            else other++

            for (const table of findTables(normalized, keyword)) {
                const counts = byTable.get(table) ?? { total: 0, select: 0, writes: 0 }
                counts.total++
                if (isSelect) counts.select++
                if (isWrite) counts.writes++
                byTable.set(table, counts)
            }
        },
        reset() {
            total = 0
            select = 0
            writes = 0
            other = 0
            byTable.clear()
        },
        snapshot() {
            return { total, select, writes, other, byTable: sortedTableStats(byTable) }
        },
    }
}

module.exports = { createSqlCounter }
