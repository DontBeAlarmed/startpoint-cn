function childPath(path: string, key: PropertyKey): string {
    if (typeof key === "symbol") return `${path}[${String(key)}]`
    const name = String(key)
    if (/^(?:0|[1-9]\d*)$/.test(name)) return `${path}[${name}]`
    return /^[A-Za-z_$][\w$]*$/.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`
}

function cloneSupported(
    value: unknown,
    path: string,
    clones: Map<object, unknown>,
    active: Set<object>,
): unknown {
    if (typeof value === "function") throw new TypeError(`Unsupported function at ${path}`)
    if (value === null || typeof value !== "object") return value
    const source = value as object
    if (active.has(source)) throw new TypeError(`Unsupported cyclic reference at ${path}`)
    const existing = clones.get(source)
    if (existing !== undefined) return existing
    const prototype = Object.getPrototypeOf(source)
    const array = Array.isArray(value)
    if ((!array && prototype !== Object.prototype && prototype !== null)
        || (array && prototype !== Array.prototype)) {
        const name = prototype?.constructor?.name ?? "null"
        throw new TypeError(`Unsupported object prototype ${name} at ${path}`)
    }
    const cloned = array ? [] : Object.create(prototype)
    clones.set(source, cloned)
    active.add(source)
    for (const key of Reflect.ownKeys(source)) {
        if (array && key === "length") continue
        const itemPath = childPath(path, key)
        const descriptor = Object.getOwnPropertyDescriptor(source, key)
        if (!descriptor || !("value" in descriptor)) {
            throw new TypeError(`Unsupported accessor at ${itemPath}`)
        }
        Object.defineProperty(cloned, key, {
            ...descriptor,
            value: cloneSupported(descriptor.value, itemPath, clones, active),
        })
    }
    active.delete(source)
    return Object.freeze(cloned)
}

export function cloneAndFreeze<T>(value: T): T {
    return cloneSupported(value, "$", new Map(), new Set()) as T
}

class ReadonlyMapView<Key, Value> implements ReadonlyMap<Key, Value> {
    readonly #values: Map<Key, Value>

    constructor(entries?: Iterable<readonly [Key, Value]>) {
        this.#values = new Map(entries)
        Object.freeze(this)
    }

    get size(): number { return this.#values.size }
    get(key: Key): Value | undefined { return this.#values.get(key) }
    has(key: Key): boolean { return this.#values.has(key) }
    entries(): IterableIterator<[Key, Value]> { return this.#values.entries() }
    keys(): IterableIterator<Key> { return this.#values.keys() }
    values(): IterableIterator<Value> { return this.#values.values() }
    [Symbol.iterator](): IterableIterator<[Key, Value]> { return this.#values[Symbol.iterator]() }
    forEach(
        callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
        thisArg?: unknown,
    ): void {
        for (const [key, value] of this.#values) callback.call(thisArg, value, key, this)
    }
}

class ReadonlySetView<Value> implements ReadonlySet<Value> {
    readonly #values: Set<Value>

    constructor(values?: Iterable<Value>) {
        this.#values = new Set(values)
        Object.freeze(this)
    }

    get size(): number { return this.#values.size }
    has(value: Value): boolean { return this.#values.has(value) }
    entries(): IterableIterator<[Value, Value]> { return this.#values.entries() }
    keys(): IterableIterator<Value> { return this.#values.keys() }
    values(): IterableIterator<Value> { return this.#values.values() }
    [Symbol.iterator](): IterableIterator<Value> { return this.#values[Symbol.iterator]() }
    forEach(
        callback: (value: Value, valueAgain: Value, set: ReadonlySet<Value>) => void,
        thisArg?: unknown,
    ): void {
        for (const value of this.#values) callback.call(thisArg, value, value, this)
    }
}

Object.freeze(ReadonlyMapView.prototype)
Object.freeze(ReadonlySetView.prototype)

export function readonlyMap<Key, Value>(
    entries?: Iterable<readonly [Key, Value]>,
): ReadonlyMap<Key, Value> {
    return new ReadonlyMapView(entries)
}

export function readonlySet<Value>(values?: Iterable<Value>): ReadonlySet<Value> {
    return new ReadonlySetView(values)
}
