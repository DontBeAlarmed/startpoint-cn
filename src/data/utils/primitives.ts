/**
 * Serializes a boolean into a number, which is storable by the database.
 * 
 * @param toSerialize The boolean to serialize.
 * @returns A number that represents the boolean.
 */
export function serializeBoolean(
    toSerialize: boolean
): number {
    return toSerialize ? 1 : 0
}


/**
 * Converts a number into a boolean.
 * 
 * @param toDeserialize The number to deserialize into a boolean.
 * @returns The deserialized boolean
 */
export function deserializeBoolean(
    toDeserialize: number
): boolean {
    return toDeserialize === 1 ? true : false
}


/**
 * Converts a list of numbers into a string.
 * 
 * @param toSerialize The list of numbers to serialize.
 * @returns A serialized string.
 */
export function serializeNumberList(
    toSerialize: (number | null)[]
): string {
    return toSerialize.join(',')
}


/**
 * Converts a serialized string into a list of numbers.
 * 
 * @param toDeserialize The serialized string to deserialize.
 * @returns A list of numbers.
 */
export function deserializeNumberList(
    toDeserialize: string
): number[] {
    if (toDeserialize.length === 0) return []
    try {
        return toDeserialize.split(",").map(str => Number(str))
    } catch (error) {
        return []
    }
}
