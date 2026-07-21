import { createHash } from "node:crypto"

function invalidJson(path: string, reason: string): never {
    throw new TypeError(`${path} is not a JSON value: ${reason}`)
}

function encodeJson(value: unknown, path: string, ancestors: WeakSet<object>): string {
    if (value === null) return "null"

    switch (typeof value) {
        case "string":
        case "boolean":
            return JSON.stringify(value)
        case "number":
            if (!Number.isFinite(value)) invalidJson(path, "number must be finite")
            if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
                invalidJson(path, "integer must be safe")
            }
            return JSON.stringify(value)
        case "undefined":
        case "bigint":
        case "function":
        case "symbol":
            return invalidJson(path, `unsupported ${typeof value}`)
        case "object":
            break
        default:
            return invalidJson(path, "unsupported value")
    }

    if (ancestors.has(value)) invalidJson(path, "cyclic reference")
    ancestors.add(value)

    try {
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype) {
                invalidJson(path, "array subclasses are not supported")
            }

            const ownKeys = Reflect.ownKeys(value)
            for (const key of ownKeys) {
                if (key === "length") continue
                if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)) {
                    invalidJson(path, "array has a non-index property")
                }
                const index = Number(key)
                if (!Number.isSafeInteger(index) || index >= value.length) {
                    invalidJson(path, "array has an invalid index")
                }
            }

            const items: string[] = []
            for (let index = 0; index < value.length; index++) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) {
                    invalidJson(`${path}[${index}]`, "sparse arrays are not supported")
                }
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
                if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                    invalidJson(`${path}[${index}]`, "array index must be enumerable data")
                }
                items.push(encodeJson(descriptor.value, `${path}[${index}]`, ancestors))
            }
            return `[${items.join(",")}]`
        }

        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
            invalidJson(path, "object must be plain")
        }

        const keys = Reflect.ownKeys(value)
        if (keys.some(key => typeof key !== "string")) {
            invalidJson(path, "symbol properties are not supported")
        }

        const stringKeys = keys as string[]
        stringKeys.sort()
        const properties = stringKeys.map(key => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                invalidJson(`${path}.${key}`, "property must be enumerable data")
            }
            return `${JSON.stringify(key)}:${encodeJson(descriptor.value, `${path}.${key}`, ancestors)}`
        })
        return `{${properties.join(",")}}`
    } finally {
        ancestors.delete(value)
    }
}

export function canonicalJsonBuffer(value: unknown): Buffer {
    return Buffer.from(`${encodeJson(value, "$", new WeakSet())}\n`, "utf8")
}

export function sha256Object(bytes: Buffer): `sha256:${string}` {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("bytes must be a Buffer")
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}
