export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
    if (!value || typeof value !== "object") return value

    const object = value as object
    if (seen.has(object)) return value
    seen.add(object)

    for (const key of Reflect.ownKeys(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen)
    }
    if (!Object.isFrozen(object)) Object.freeze(object)
    return value
}
