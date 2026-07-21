export type HttpByteRange =
    | { readonly kind: "full" }
    | { readonly kind: "partial"; readonly start: number; readonly end: number }
    | { readonly kind: "unsatisfiable" }

const UNSATISFIABLE = Object.freeze({ kind: "unsatisfiable" } as const)

function parseDecimal(value: string): number | null {
    if (!/^\d+$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

export function parseHttpByteRange(
    header: string | string[] | undefined,
    size: number,
): HttpByteRange {
    if (header === undefined) return { kind: "full" }
    if (Array.isArray(header)
        || !Number.isSafeInteger(size)
        || size <= 0
        || header.includes(",")) {
        return UNSATISFIABLE
    }

    const match = /^bytes=(\d*)-(\d*)$/i.exec(header)
    if (!match) return UNSATISFIABLE
    const [, rawStart, rawEnd] = match
    if (rawStart === "" && rawEnd === "") return UNSATISFIABLE

    if (rawStart === "") {
        const suffixLength = parseDecimal(rawEnd)
        if (suffixLength === null || suffixLength === 0) return UNSATISFIABLE
        return {
            kind: "partial",
            start: Math.max(size - suffixLength, 0),
            end: size - 1,
        }
    }

    const start = parseDecimal(rawStart)
    if (start === null || start >= size) return UNSATISFIABLE
    if (rawEnd === "") return { kind: "partial", start, end: size - 1 }

    const requestedEnd = parseDecimal(rawEnd)
    if (requestedEnd === null || requestedEnd < start) return UNSATISFIABLE
    return { kind: "partial", start, end: Math.min(requestedEnd, size - 1) }
}
