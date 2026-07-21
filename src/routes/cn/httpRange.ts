export type HttpByteRange =
    | { readonly kind: "full" }
    | { readonly kind: "partial"; readonly start: number; readonly end: number }
    | { readonly kind: "unsatisfiable" }

const UNSATISFIABLE = Object.freeze({ kind: "unsatisfiable" } as const)
const MAX_RANGE_HEADER_LENGTH = 256

function parseSaturatedDecimal(value: string, maximum: number): number {
    let parsed = 0
    for (let index = 0; index < value.length; index++) {
        const digit = value.charCodeAt(index) - 0x30
        if (parsed > Math.floor((maximum - digit) / 10)) return maximum
        parsed = parsed * 10 + digit
    }
    return parsed
}

export function parseHttpByteRange(
    header: string | string[] | undefined,
    size: number,
): HttpByteRange {
    if (header === undefined) return { kind: "full" }
    if (Array.isArray(header)
        || !Number.isSafeInteger(size)
        || size <= 0
        || header.length > MAX_RANGE_HEADER_LENGTH
        || header.includes(",")) {
        return UNSATISFIABLE
    }

    const match = /^bytes=(\d*)-(\d*)$/i.exec(header)
    if (!match) return UNSATISFIABLE
    const [, rawStart, rawEnd] = match
    if (rawStart === "" && rawEnd === "") return UNSATISFIABLE

    if (rawStart === "") {
        const suffixLength = parseSaturatedDecimal(rawEnd, size)
        if (suffixLength === 0) return UNSATISFIABLE
        return {
            kind: "partial",
            start: Math.max(size - suffixLength, 0),
            end: size - 1,
        }
    }

    const start = parseSaturatedDecimal(rawStart, size)
    if (start >= size) return UNSATISFIABLE
    if (rawEnd === "") return { kind: "partial", start, end: size - 1 }

    const requestedEnd = parseSaturatedDecimal(rawEnd, size - 1)
    if (requestedEnd < start) return UNSATISFIABLE
    return { kind: "partial", start, end: requestedEnd }
}
