import { parseCsvLine } from "./csv"
import {
    parseNestedOrderedMapRows,
    parseTextOrderedMap,
} from "../sync/ordered-map"

export interface CsvOrderedMapTree {
    readonly [key: string]: readonly (readonly string[])[] | CsvOrderedMapTree
}

function invalidOrderedMapJson(reason: string): never {
    throw new Error(`invalid orderedmap JSON: ${reason}`)
}

function convertLevel(
    raw: Buffer,
    nestingDepth: number,
    logicalPath: string,
): CsvOrderedMapTree {
    const output: Record<string, readonly (readonly string[])[] | CsvOrderedMapTree> = {}
    if (nestingDepth === 1) {
        for (const row of parseTextOrderedMap(raw)) {
            const fields = Object.freeze(parseCsvLine(
                row.text,
                `${logicalPath}[${row.key}]`,
                reason => invalidOrderedMapJson(reason),
            ))
            output[row.key] = Object.freeze([fields])
        }
        return Object.freeze(output)
    }

    for (const row of parseNestedOrderedMapRows(raw)) {
        try {
            output[row.key] = convertLevel(
                row.value,
                nestingDepth - 1,
                `${logicalPath}[${row.key}]`,
            )
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            invalidOrderedMapJson(`nested row ${row.key} is invalid: ${reason}`)
        }
    }
    return Object.freeze(output)
}

/** Restores the JSON shape emitted by the official OrderedMap extractor. */
export function convertOrderedMapJson(raw: Buffer, nestingDepth: number): CsvOrderedMapTree {
    if (!Number.isSafeInteger(nestingDepth) || nestingDepth <= 0) {
        invalidOrderedMapJson("nesting depth must be a positive integer")
    }
    return convertLevel(raw, nestingDepth, "orderedmap")
}
