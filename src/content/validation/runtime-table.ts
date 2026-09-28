export type UnknownRecord = Readonly<Record<string, unknown>>

export function invalidRuntimeTable(tableName: string, reason: string): never {
    throw new TypeError(`invalid ${tableName} content: ${reason}`)
}

export function requireRecord(
    value: unknown,
    tableName: string,
    subject: string = "root",
): UnknownRecord {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        invalidRuntimeTable(tableName, `${subject} must be an object`)
    }
    return value as UnknownRecord
}

export function requireArray(
    value: unknown,
    tableName: string,
    subject: string,
): readonly unknown[] {
    if (!Array.isArray(value)) invalidRuntimeTable(tableName, `${subject} must be an array`)
    return value
}

export function requireCanonicalPositiveIntegerKey(
    value: string,
    tableName: string,
    subject: string = "key",
): number {
    if (!/^[1-9]\d*$/.test(value)) {
        invalidRuntimeTable(tableName, `${subject} must be a canonical positive integer: ${value}`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
        invalidRuntimeTable(tableName, `${subject} must be a safe integer: ${value}`)
    }
    return parsed
}

export function requirePositiveSafeInteger(
    value: unknown,
    tableName: string,
    subject: string,
): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        invalidRuntimeTable(tableName, `${subject} must be a positive safe integer`)
    }
    return value as number
}

export function requireNonNegativeSafeInteger(
    value: unknown,
    tableName: string,
    subject: string,
): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        invalidRuntimeTable(tableName, `${subject} must be a non-negative safe integer`)
    }
    return value as number
}

export function requireFiniteNumber(
    value: unknown,
    tableName: string,
    subject: string,
): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        invalidRuntimeTable(tableName, `${subject} must be finite`)
    }
    return value
}

export function requireBoolean(
    value: unknown,
    tableName: string,
    subject: string,
): boolean {
    if (typeof value !== "boolean") {
        invalidRuntimeTable(tableName, `${subject} must be boolean`)
    }
    return value
}

export function requireNonEmptyString(
    value: unknown,
    tableName: string,
    subject: string,
): string {
    if (typeof value !== "string" || value.length === 0) {
        invalidRuntimeTable(tableName, `${subject} must be a non-empty string`)
    }
    return value
}

export function requireCanonicalPositiveIntegerArray(
    value: unknown,
    tableName: string,
    subject: string,
): readonly number[] {
    const values = requireArray(value, tableName, subject).map((entry, index) => (
        requirePositiveSafeInteger(entry, tableName, `${subject}[${index}]`)
    ))
    if (new Set(values).size !== values.length) {
        invalidRuntimeTable(tableName, `${subject} must not contain duplicates`)
    }
    return values
}
