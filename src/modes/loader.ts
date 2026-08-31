/**
 * Mode module loader (fork/dev-base).
 *
 * Loads operator-installed gameplay-mode modules from `modes.d/*.mjs` at
 * process start. Installing a module is an operator-level trust decision
 * equivalent to installing the server itself, so loading is doubly explicit:
 * the file must be present AND its sha256 must be registered in
 * `modes.d/modes-allowlist.json` ({"<file>.mjs": "<sha256-hex>"}). Anything
 * else is skipped loudly. `MODES_ENABLED=0` disables the whole seam.
 *
 * No hot reload: modules load once at boot, matching the frozen content
 * snapshot model. Install/remove requires a restart.
 */
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { getContentSnapshot } from "../content/runtime/content-snapshot"
import { getCharacterDataSync } from "../lib/assets"
import { grantCharacterExpWithinTransactionSync } from "../lib/character-growth/commands/grant-character-exp"
import { updatePlayerEquipmentSync } from "../data/domains/equipment"
import {
    isModeManifest,
    listModeCapabilities,
    MODE_API_VERSION,
    registerMode,
    type ModeHooks,
    type ModeHost,
    type ModeManifest,
    type ModeTransactionHost,
} from "./registry"

export interface LoadModesOptions {
    readonly projectRoot: string
    readonly env?: NodeJS.ProcessEnv
    readonly log?: (message: string) => void
    readonly importModule?: (url: string) => Promise<unknown>
}

/**
 * Read-only host for hooks that run outside a transaction. It deliberately
 * carries no write primitive, so such a hook cannot modify player data.
 */
export function createModeHost(log: (message: string) => void): ModeHost {
    return Object.freeze({
        apiVersion: MODE_API_VERSION,
        // Base-registered tables only; unknown names throw. Mode-private
        // configuration does not live in the content registry.
        table: <T>(tableName: string): T => (
            getContentSnapshot().repository.table<T>(tableName)
        ),
        log,
    })
}

/**
 * Host for hooks that run inside an explicit transaction. Writes issued
 * through these primitives join the caller's transaction, so they roll back
 * with it.
 */
export function createModeTransactionHost(
    log: (message: string) => void,
): ModeTransactionHost {
    return Object.freeze({
        ...createModeHost(log),
        server: Object.freeze({
            getCharacterElement: (characterId: number) => {
                const element = Number(getCharacterDataSync(characterId)?.element)
                return Number.isInteger(element) ? element : null
            },
            updatePlayerEquipment: (
                playerId: number, equipmentId: number, patch: { level: number },
            ) => { updatePlayerEquipmentSync(playerId, equipmentId, patch) },
            givePlayerCharactersExp: (
                playerId: number, characterIds: number[], amount: number,
            ) => grantCharacterExpWithinTransactionSync({
                playerId,
                characterIds,
                amount,
                evaluationTime: new Date(),
            }),
        }),
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function loadModes(options: LoadModesOptions): Promise<readonly string[]> {
    const env = options.env ?? process.env
    const log = options.log ?? ((message: string) => console.log(message))
    if (env.MODES_ENABLED === "0") {
        log("[modes] disabled by MODES_ENABLED=0")
        return []
    }
    const modesDir = env.MODES_DIR ?? path.join(options.projectRoot, "modes.d")
    let entries: string[]
    try {
        // Code-point order, not locale order: the dispatch sequence must be
        // identical on every machine for a given modes.d/.
        entries = (await fs.readdir(modesDir))
            .filter(name => name.endsWith(".mjs"))
            .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
    }
    if (entries.length === 0) return []

    const allowlistPath = path.join(modesDir, "modes-allowlist.json")
    let allowlist: Record<string, unknown> = {}
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(allowlistPath, "utf8"))
        if (isRecord(parsed)) allowlist = parsed
        else log(`[modes] allowlist is not an object; ignoring ${allowlistPath}`)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            log(`[modes] allowlist unreadable (${(error as Error).message}); nothing will load`)
        }
    }

    // Indirect eval keeps a true ESM dynamic import even when TypeScript
    // compiles this module to CommonJS (a plain import() would become
    // require(), which cannot load file:// .mjs modules).
    const importModule = options.importModule
        ?? (new Function("url", "return import(url)") as (url: string) => Promise<unknown>)
    const loaded: string[] = []
    for (const fileName of entries) {
        const expected = allowlist[fileName]
        if (typeof expected !== "string") {
            log(`[modes] SKIP ${fileName}: not registered in modes-allowlist.json`)
            continue
        }
        const absolute = path.join(modesDir, fileName)
        const digest = createHash("sha256").update(await fs.readFile(absolute)).digest("hex")
        if (digest !== expected.toLowerCase()) {
            log(`[modes] SKIP ${fileName}: sha256 mismatch (file ${digest})`)
            continue
        }
        // An allowlisted module that fails to import, register or declare a
        // usable definition is reported and skipped. Boot continues: one bad
        // module must not deny service for everything else.
        try {
            const imported = await importModule(pathToFileURL(absolute).href)
            const moduleExports = isRecord(imported) ? imported : {}
            const fromDefault = isRecord(moduleExports.default)
                ? moduleExports.default as Record<string, unknown>
                : {}
            const manifest = moduleExports.modeManifest ?? fromDefault.modeManifest
            // Compatibility is decided from the statically exported manifest,
            // before any module code receives a host: an incompatible module
            // must never get the chance to call one.
            if (!isModeManifest(manifest)) {
                log(`[modes] SKIP ${fileName}: no usable modeManifest export`)
                continue
            }
            if (manifest.apiVersion !== MODE_API_VERSION) {
                log(
                    `[modes] SKIP ${fileName}: targets mode API `
                    + `${String(manifest.apiVersion)}, this server provides ${MODE_API_VERSION}`,
                )
                continue
            }
            const register = fromDefault.register ?? moduleExports.register
            if (typeof register !== "function") {
                log(`[modes] SKIP ${fileName}: no register(host) export`)
                continue
            }
            const hooks = (await register(createModeHost(log)) ?? {}) as ModeHooks
            registerMode(
                { ...(manifest as ModeManifest), ...hooks },
                {
                    fileName,
                    name: manifest.name,
                    capability: manifest.capability,
                    sha256: digest,
                },
            )
            log(`[modes] loaded ${manifest.name} (${manifest.capability}) sha256=${digest.slice(0, 12)}…`)
            loaded.push(manifest.name)
        } catch (error) {
            log(`[modes] SKIP ${fileName}: ${(error as Error)?.message ?? String(error)}`)
        }
    }
    if (loaded.length > 0) {
        log(`[modes] capabilities: ${listModeCapabilities().join(", ")}`)
    }
    return loaded
}
