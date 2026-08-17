export type AbortRequestValidationResult =
    | {
        ok: true
        viewerId: number
        playId: string | null
        questId: number | null
        category: number | null
    }
    | { ok: false, message: string }

type OptionalFieldResult<T> =
    | { ok: true, value: T | null }
    | { ok: false }

function parseOptionalPlayId(value: unknown): OptionalFieldResult<string> {
    if (value === undefined || value === null || value === "") {
        return { ok: true, value: null }
    }
    return typeof value === "string"
        ? { ok: true, value }
        : { ok: false }
}

function parseOptionalNonNegativeSafeInteger(value: unknown): OptionalFieldResult<number> {
    if (value === undefined || value === null) return { ok: true, value: null }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        return { ok: false }
    }
    return { ok: true, value }
}

export function validateAbortRequest(body: unknown): AbortRequestValidationResult {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { ok: false, message: "Invalid request body." }
    }
    const fields = body as Record<string, unknown>
    const playId = parseOptionalPlayId(fields.play_id)
    const questId = parseOptionalNonNegativeSafeInteger(fields.quest_id)
    const category = parseOptionalNonNegativeSafeInteger(fields.category)
    if (!playId.ok || !questId.ok || !category.ok) {
        return { ok: false, message: "Invalid request body." }
    }
    if (typeof fields.viewer_id !== "number") {
        return { ok: false, message: "Invalid viewer id." }
    }
    return {
        ok: true,
        viewerId: fields.viewer_id,
        playId: playId.value,
        questId: questId.value,
        category: category.value,
    }
}
