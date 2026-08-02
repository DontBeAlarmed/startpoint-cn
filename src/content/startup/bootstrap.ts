import { spawn as spawnChildProcess } from "node:child_process"
import path from "node:path"

import { parseAssetProviderConfig } from "../cdn/asset-mode"
// Keep the standalone sync entry in the explicit CN TypeScript build graph.
import type {} from "../sync/entry"

export interface StartupOutcome {
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
}

interface StartupChild {
    once(event: "error", listener: (error: Error) => void): this
    once(
        event: "close",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): this
    kill(signal: NodeJS.Signals): boolean
}

interface StartupProcessTarget {
    on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
    removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

interface StartupSpawnOptions {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly shell: false
    readonly stdio: "inherit"
}

type StartupSpawn = (
    executable: string,
    args: readonly string[],
    options: StartupSpawnOptions,
) => StartupChild

export interface ContentStartupDependencies {
    readonly projectRoot?: string
    readonly executable?: string
    readonly env?: NodeJS.ProcessEnv
    readonly processTarget?: StartupProcessTarget
    readonly spawn?: StartupSpawn
    readonly stderr?: Pick<NodeJS.WriteStream, "write">
}

function normalizeOutcome(
    code: number | null,
    signal: NodeJS.Signals | null,
): StartupOutcome {
    if (signal !== null) return { code: null, signal }
    if (code !== null && Number.isInteger(code) && code >= 0) return { code, signal: null }
    return { code: 1, signal: null }
}

export async function runContentStartup(
    dependencies: ContentStartupDependencies = {},
): Promise<StartupOutcome> {
    const projectRoot = path.resolve(dependencies.projectRoot ?? path.resolve(__dirname, "../../.."))
    const executable = dependencies.executable ?? process.execPath
    const env = dependencies.env ?? process.env
    const assetProvider = parseAssetProviderConfig({ projectRoot, env })
    const processTarget = dependencies.processTarget ?? process
    const spawn = dependencies.spawn ?? ((command, args, options) => (
        spawnChildProcess(command, args, options)
    ))
    const stderr = dependencies.stderr ?? process.stderr
    const spawnOptions: StartupSpawnOptions = {
        cwd: projectRoot,
        env,
        shell: false,
        stdio: "inherit",
    }
    let activeChild: StartupChild | null = null
    let shutdownSignal: NodeJS.Signals | null = null

    const forwardSignal = (signal: NodeJS.Signals): void => {
        if (shutdownSignal !== null) return
        shutdownSignal = signal
        if (activeChild !== null) activeChild.kill(signal)
    }
    const onSigint = (): void => forwardSignal("SIGINT")
    const onSigterm = (): void => forwardSignal("SIGTERM")
    processTarget.on("SIGINT", onSigint)
    processTarget.on("SIGTERM", onSigterm)

    const runStage = async (
        stage: "sync" | "server",
        entryPath: string,
    ): Promise<StartupOutcome> => {
        if (shutdownSignal !== null) return { code: null, signal: shutdownSignal }

        let child: StartupChild
        try {
            child = spawn(executable, [entryPath], spawnOptions)
            activeChild = child
        } catch {
            stderr.write(`错误 [CONTENT_STARTUP_SPAWN_FAILED]：无法启动${stage === "sync" ? "内容同步" : "游戏服务"}\n`)
            return { code: 1, signal: null }
        }

        const outcomePromise = new Promise<StartupOutcome>(resolve => {
            let settled = false
            const finish = (result: StartupOutcome): void => {
                if (settled) return
                settled = true
                resolve(result)
            }
            child.once("error", () => {
                stderr.write(`错误 [CONTENT_STARTUP_SPAWN_FAILED]：无法启动${stage === "sync" ? "内容同步" : "游戏服务"}\n`)
                finish({ code: 1, signal: null })
            })
            child.once("close", (code, signal) => finish(normalizeOutcome(code, signal)))
        })
        if (shutdownSignal !== null) child.kill(shutdownSignal)

        const outcome = await outcomePromise
        if (activeChild === child) activeChild = null
        return outcome
    }

    try {
        if (assetProvider.mode === "local") {
            const syncOutcome = await runStage(
                "sync",
                path.join(projectRoot, "out/content/sync/entry.js"),
            )
            if (
                shutdownSignal !== null
                || syncOutcome.signal !== null
                || syncOutcome.code !== 0
            ) {
                return syncOutcome
            }
        }
        const serverOutcome = await runStage(
            "server",
            path.join(projectRoot, "out/cn-server.js"),
        )
        if (shutdownSignal !== null && serverOutcome.code === 0 && serverOutcome.signal === null) {
            stderr.write("[startup] CN server exited cleanly\n")
        }
        return serverOutcome
    } finally {
        processTarget.removeListener("SIGINT", onSigint)
        processTarget.removeListener("SIGTERM", onSigterm)
    }
}
