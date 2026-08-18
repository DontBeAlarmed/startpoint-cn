export interface ActiveMissionTableRow {
    readonly id: number
    readonly row: readonly unknown[]
}

function isTable(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseRawId(rawId: string, tableName: string): number {
    if (!/^\d+$/.test(rawId)) {
        throw new TypeError(`Invalid ${tableName} ID ${rawId}.`)
    }
    const id = Number(rawId)
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw new TypeError(`Invalid ${tableName} ID ${rawId}.`)
    }
    return id
}

export function parseActiveMissionTableValues(
    table: unknown,
    tableName: string,
): ReadonlyMap<number, unknown> {
    if (!isTable(table)) throw new TypeError(`Invalid ${tableName} table.`)
    const values = new Map<number, unknown>()
    for (const [rawId, value] of Object.entries(table)) {
        const id = parseRawId(rawId, tableName)
        if (values.has(id)) throw new Error(`Duplicate ${tableName} ID ${id}.`)
        if (String(id) !== rawId) {
            throw new TypeError(`Invalid ${tableName} ID ${rawId}.`)
        }
        values.set(id, value)
    }
    return values
}

export function parseActiveMissionTableRows(
    table: unknown,
    tableName: string,
): readonly ActiveMissionTableRow[] {
    const values = parseActiveMissionTableValues(table, tableName)
    return [...values].map(([id, rawRows]) => {
        if (!Array.isArray(rawRows) || rawRows.length !== 1 || !Array.isArray(rawRows[0])) {
            throw new TypeError(`Invalid ${tableName} row for ID ${id}.`)
        }
        return { id, row: rawRows[0] as readonly unknown[] }
    })
}
