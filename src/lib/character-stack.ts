export function validateCharacterStackConversion(
    currentStack: number,
    convertCount: number,
    protectedCharacter: boolean
): string | null {
    if (!Number.isInteger(convertCount) || convertCount <= 0) {
        return "Invalid conversion count."
    }
    if (protectedCharacter) return "Protected character cannot be converted."
    if (convertCount > currentStack) return "Not enough stack."
    return null
}
