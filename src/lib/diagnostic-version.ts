const MAX_DIAGNOSTIC_VERSION_LENGTH = 32
const MAX_PRERELEASE_SUFFIX_LENGTH = 16
const DOTTED_NUMERIC_VERSION_PATTERN = /^(\d+(?:\.\d+)+)(?:-([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*))?$/

export function sanitizeDiagnosticVersion(value: unknown): string | null {
    if (typeof value !== "string"
        || value.length === 0
        || value.length > MAX_DIAGNOSTIC_VERSION_LENGTH) return null
    const match = DOTTED_NUMERIC_VERSION_PATTERN.exec(value)
    if (match === null) return null
    const prereleaseSuffix = match[2]
    return prereleaseSuffix === undefined
        || prereleaseSuffix.length <= MAX_PRERELEASE_SUFFIX_LENGTH
        ? value
        : null
}

export function isDiagnosticVersion(value: unknown): value is string {
    return sanitizeDiagnosticVersion(value) !== null
}
