import { loadModes } from "./loader"

/**
 * The content+modes boot step, shared by cn-server and its tests.
 *
 * Keeping the composition here rather than inline in cn-server means a test
 * exercises the same function the server runs, instead of re-creating the
 * ordering itself — a self-injected loader in a test cannot prove the server
 * actually calls one.
 *
 * Order matters: modules read the content snapshot, so it must exist before
 * they register, and registration must finish before any listener accepts a
 * request that could dispatch to a half-registered set.
 */
export interface ContentAndModesBootOptions {
    readonly projectRoot: string
    readonly initializeContentSnapshot: () => Promise<unknown>
    readonly env?: NodeJS.ProcessEnv
    readonly log?: (message: string) => void
}

export async function initializeContentAndModes(
    options: ContentAndModesBootOptions,
): Promise<readonly string[]> {
    await options.initializeContentSnapshot()
    return loadModes({
        projectRoot: options.projectRoot,
        env: options.env,
        log: options.log,
    })
}
