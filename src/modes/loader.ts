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
import { givePlayerCharactersExpSync } from "../lib/character"
import { updatePlayerEquipmentSync } from "../data/domains/equipment"
import {
    listModeCapabilities,
    registerMode,
    type ModeDefinition,
    type ModeHost,
} from "./registry"

export interface LoadModesOptions {
    readonly projectRoot: string
    readonly env?: NodeJS.ProcessEnv
    readonly log?: (message: string) => void
    readonly importModule?: (url: string) => Promise<unknown>
}

export function createModeHost(log: (message: string) => void): ModeHost {
    return Object.freeze({
        table: <T>(tableName: string): T => (
            getContentSnapshot().repository.table<T>(tableName)
        ),
        log,
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
            ) => givePlayerCharactersExpSync(playerId, characterIds, amount, false),
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
        entries = (await fs.readdir(modesDir)).filter(name => name.endsWith(".mjs")).sort()
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
        const imported = await importModule(pathToFileURL(absolute).href)
        const moduleExports = isRecord(imported) ? imported : {}
        const register = (isRecord(moduleExports.default)
            ? (moduleExports.default as Record<string, unknown>).register
            : undefined) ?? moduleExports.register
        if (typeof register !== "function") {
            log(`[modes] SKIP ${fileName}: no register(host) export`)
            continue
        }
        const host = createModeHost(log)
        const definition = await register(host) as ModeDefinition
        registerMode(definition)
        log(`[modes] loaded ${definition.name} (${definition.capability}) sha256=${digest.slice(0, 12)}…`)
        loaded.push(definition.name)
    }
    if (loaded.length > 0) {
        log(`[modes] capabilities: ${listModeCapabilities().join(", ")}`)
    }
    return loaded
}
