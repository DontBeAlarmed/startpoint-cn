import { initializeContentAndModes } from "./boot"

/**
 * The seam's slice of cn-server's runtime-coordinator dependencies.
 *
 * cn-server builds its dependency object by spreading the result of
 * `createContentLifecycleDependencies()`, so the lifecycle test drives the
 * production entry point rather than a re-creation of it: if cn-server ever
 * stopped composing this in, the ordering test would lose its module load
 * and fail instead of quietly passing.
 *
 * Ordering guarantee under test: content snapshot → modes registered →
 * multiplayer start → HTTP listen. Modules must see a ready snapshot, and
 * registration must complete before any listener can accept a request that
 * would dispatch into a half-registered set.
 */
export interface ContentLifecycleOptions<Config> {
    readonly projectRoot: string
    /** Builds the snapshot for a config; cn-server passes the real one. */
    readonly initializeContentSnapshot: (config: Config) => Promise<unknown>
    readonly env?: NodeJS.ProcessEnv
    readonly log?: (message: string) => void
}

export interface ContentLifecycleDependencies<Config> {
    readonly initializeContent: (config: Config) => Promise<unknown>
}

export function createContentLifecycleDependencies<Config>(
    options: ContentLifecycleOptions<Config>,
): ContentLifecycleDependencies<Config> {
    return {
        initializeContent: config => initializeContentAndModes({
            projectRoot: options.projectRoot,
            initializeContentSnapshot: () => options.initializeContentSnapshot(config),
            env: options.env,
            log: options.log,
        }),
    }
}
