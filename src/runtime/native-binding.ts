import fs from "node:fs"
import Module from "node:module"
import path from "node:path"

export class NativeBindingConfigError extends Error {
    readonly code = "INVALID_NATIVE_BINDING"

    constructor() {
        super("invalid better-sqlite3 native binding")
        this.name = "NativeBindingConfigError"
    }
}

export function resolveNativeBinding(
    environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
    const configured = environment.BETTER_SQLITE3_NATIVE_BINDING
    if (configured === undefined) return undefined
    if (!path.isAbsolute(configured)) throw new NativeBindingConfigError()
    const extension = path.extname(configured)
    if (extension !== ".node" && extension !== ".so") {
        throw new NativeBindingConfigError()
    }

    let status: fs.Stats
    try {
        status = fs.lstatSync(configured)
    } catch {
        throw new NativeBindingConfigError()
    }
    if (!status.isFile() || status.isSymbolicLink()) throw new NativeBindingConfigError()

    try {
        return fs.realpathSync(configured)
    } catch {
        throw new NativeBindingConfigError()
    }
}

export function createBetterSqlite3Database<T>(
    constructor: (databasePath: string, options?: { nativeBinding?: string | object }) => T,
    databasePath: string,
    environment: Readonly<Record<string, string | undefined>> = process.env,
    loadNativeBinding: (bindingPath: string) => object = loadNativeAddon,
): T {
    const nativeBinding = resolveNativeBinding(environment)
    if (nativeBinding === undefined) return constructor(databasePath)
    return constructor(databasePath, {
        nativeBinding: path.extname(nativeBinding) === ".node"
            ? nativeBinding
            : loadNativeBinding(nativeBinding),
    })
}

function loadNativeAddon(bindingPath: string): object {
    try {
        const addonModule = new Module(bindingPath, module)
        addonModule.filename = bindingPath
        process.dlopen(addonModule, bindingPath)
        const exports = addonModule.exports
        if ((typeof exports !== "object" && typeof exports !== "function") || exports === null) {
            throw new NativeBindingConfigError()
        }
        return exports
    } catch {
        throw new NativeBindingConfigError()
    }
}
