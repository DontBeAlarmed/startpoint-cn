import { TextDecoder } from "node:util"
import { inflateSync } from "node:zlib"

export interface OrderedMapRow {
    readonly key: string
    /** Fresh caller-owned bytes; parsing the same source again returns an independent copy. */
    readonly value: Buffer
}

export interface OrderedMapTextRow {
    readonly key: string
    readonly text: string
}

export interface NestedOrderedMapTextRows {
    readonly key: string
    readonly rows: readonly OrderedMapTextRow[]
}

interface OrderedMapPair {
    readonly keyEnd: number
    readonly rowEnd: number
}

interface InflateResult {
    readonly buffer: Buffer
    readonly engine: {
        readonly bytesWritten: number
    }
}

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true })
const inflateWithInfo = inflateSync as unknown as (
    bytes: Buffer,
    options: { readonly info: true },
) => InflateResult

function invalidOrderedMap(reason: string): never {
    throw new Error(`invalid orderedmap: ${reason}`)
}

function requireBuffer(raw: unknown): asserts raw is Buffer {
    if (!Buffer.isBuffer(raw)) invalidOrderedMap("source must be a Buffer")
}

function decodeUtf8(bytes: Buffer, subject: string): string {
    try {
        return UTF8_FATAL.decode(bytes)
    } catch {
        return invalidOrderedMap(`${subject} is not valid UTF-8`)
    }
}

function inflate(bytes: Buffer, subject: string): Buffer {
    let result: InflateResult
    try {
        result = inflateWithInfo(bytes, { info: true })
    } catch {
        invalidOrderedMap(`${subject} is not valid zlib data`)
    }
    if (result.engine.bytesWritten !== bytes.length) {
        invalidOrderedMap(`${subject} has trailing zlib data`)
    }
    return Buffer.from(result.buffer)
}

function parseIndex(raw: Buffer): { readonly body: Buffer; readonly pairs: readonly OrderedMapPair[]; readonly keys: readonly string[] } {
    if (raw.length < 4) invalidOrderedMap("source is shorter than the index length")

    const indexLength = raw.readUInt32LE(0)
    if (indexLength === 0) invalidOrderedMap("index length must be positive")
    if (indexLength > raw.length - 4) invalidOrderedMap("index length exceeds source")

    const indexEnd = 4 + indexLength
    const index = inflate(raw.subarray(4, indexEnd), "index")
    if (index.length < 4) invalidOrderedMap("index is missing its row count")

    const count = index.readUInt32LE(0)
    const pairsLength = count * 8
    const keysOffset = 4 + pairsLength
    if (keysOffset > index.length) invalidOrderedMap("index is missing row pairs")

    const keyBlob = index.subarray(keysOffset)
    const pairs: OrderedMapPair[] = []
    const keys: string[] = []
    const seenKeys = new Set<string>()
    let previousKeyEnd = 0
    let previousRowEnd = 0

    for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
        const pairOffset = 4 + rowIndex * 8
        const keyEnd = index.readUInt32LE(pairOffset)
        const rowEnd = index.readUInt32LE(pairOffset + 4)

        if (keyEnd < previousKeyEnd || keyEnd > keyBlob.length) {
            invalidOrderedMap(`key boundary is invalid for row ${rowIndex}`)
        }
        if (rowEnd < previousRowEnd) {
            invalidOrderedMap(`row boundary is invalid for row ${rowIndex}`)
        }

        const key = decodeUtf8(keyBlob.subarray(previousKeyEnd, keyEnd), `key ${rowIndex}`)
        if (seenKeys.has(key)) invalidOrderedMap(`duplicate key: ${key}`)

        seenKeys.add(key)
        keys.push(key)
        pairs.push({ keyEnd, rowEnd })
        previousKeyEnd = keyEnd
        previousRowEnd = rowEnd
    }

    const body = raw.subarray(indexEnd)
    if (previousKeyEnd !== keyBlob.length) invalidOrderedMap("key boundaries do not consume the key blob")
    if (previousRowEnd !== body.length) invalidOrderedMap("row boundaries do not consume the body")

    return { body, pairs, keys }
}

export function parseOrderedMap(raw: Buffer): readonly OrderedMapRow[] {
    requireBuffer(raw)

    const { body, keys, pairs } = parseIndex(raw)
    const rows: OrderedMapRow[] = []
    let previousRowEnd = 0

    for (let rowIndex = 0; rowIndex < pairs.length; rowIndex += 1) {
        const rowEnd = pairs[rowIndex].rowEnd
        const compressed = body.subarray(previousRowEnd, rowEnd)
        const value = compressed.length === 0
            ? Buffer.alloc(0)
            : inflate(compressed, `row ${rowIndex}`)

        rows.push(Object.freeze({ key: keys[rowIndex], value }))
        previousRowEnd = rowEnd
    }

    return Object.freeze(rows)
}

export function parseTextOrderedMap(raw: Buffer): readonly OrderedMapTextRow[] {
    const rows = parseOrderedMap(raw)
    return Object.freeze(rows.map((row, rowIndex) => Object.freeze({
        key: row.key,
        text: decodeUtf8(row.value, `row ${rowIndex} text`),
    })))
}

export function parseNestedTextOrderedMaps(
    raw: Buffer,
): readonly NestedOrderedMapTextRows[] {
    const outerRows = parseOrderedMap(raw)
    return Object.freeze(outerRows.map(outerRow => Object.freeze({
        key: outerRow.key,
        rows: parseTextOrderedMap(outerRow.value),
    })))
}

export function parseNestedTextOrderedMap(
    raw: Buffer,
    expectedOuterKey?: string,
): readonly OrderedMapTextRow[] {
    const outerRows = parseNestedTextOrderedMaps(raw)
    if (outerRows.length !== 1) invalidOrderedMap("nested source must contain exactly one outer row")
    if (expectedOuterKey !== undefined && outerRows[0].key !== expectedOuterKey) {
        invalidOrderedMap(`nested outer key must be ${expectedOuterKey}`)
    }
    return outerRows[0].rows
}
