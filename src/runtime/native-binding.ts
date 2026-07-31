import fs from "node:fs"
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
    constructor: (databasePath: string, options?: { nativeBinding?: string }) => T,
    databasePath: string,
    environment: Readonly<Record<string, string | undefined>> = process.env,
): T {
    const nativeBinding = resolveNativeBinding(environment)
    return nativeBinding === undefined
        ? constructor(databasePath)
        : constructor(databasePath, { nativeBinding })
}
