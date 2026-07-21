import path from "node:path"

import {
    runContentSync,
    type ContentSyncMode,
    type ContentSyncOptions,
    type ContentSyncResult,
} from "./engine"

export class ContentSyncCliError extends Error {
    readonly code: "CONTENT_SYNC_UNKNOWN_ARGUMENT" | "CONTENT_SYNC_MODE_CONFLICT"

    constructor(
        code: "CONTENT_SYNC_UNKNOWN_ARGUMENT" | "CONTENT_SYNC_MODE_CONFLICT",
        message: string,
    ) {
        super(message)
        this.name = "ContentSyncCliError"
        this.code = code
    }
}

export interface ContentSyncCliArguments {
    readonly mode: ContentSyncMode
}

export interface ContentSyncCliDependencies {
    readonly projectRoot?: string
    readonly env?: NodeJS.ProcessEnv
    readonly runSync?: (options: ContentSyncOptions) => Promise<ContentSyncResult>
    readonly stdout?: Pick<NodeJS.WriteStream, "write">
    readonly stderr?: Pick<NodeJS.WriteStream, "write">
    readonly setExitCode?: (code: number) => void
}

export function parseContentSyncArguments(argv: readonly string[]): ContentSyncCliArguments {
    let mode: ContentSyncMode = "normal"
    let selected = false
    for (const argument of argv) {
        if (argument !== "--check" && argument !== "--force") {
            throw new ContentSyncCliError(
                "CONTENT_SYNC_UNKNOWN_ARGUMENT",
                `未知参数：${argument}`,
            )
        }
        if (selected) {
            throw new ContentSyncCliError(
                "CONTENT_SYNC_MODE_CONFLICT",
                "--check 与 --force 互斥且不能重复",
            )
        }
        selected = true
        mode = argument === "--check" ? "check" : "force"
    }
    return { mode }
}

function printableResult(result: ContentSyncResult): ContentSyncResult {
    return {
        status: result.status,
        action: result.action,
        targetVersion: result.targetVersion,
        currentVersion: result.currentVersion,
        reason: result.reason,
        ...(result.releaseDigest === undefined ? {} : { releaseDigest: result.releaseDigest }),
    }
}

function sanitizeErrorMessage(message: string, projectRoot: string): string {
    const withoutProject = message.split(projectRoot).join("<PROJECT_ROOT>")
    return withoutProject
        .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]*\1/g, "$1<PATH>$1")
        .replace(/\\\\[^\s:：,，;；"']+/g, "<PATH>")
        .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s:：,，;；"']+/g, "<PATH>")
}

export async function runContentSyncCli(
    argv: readonly string[],
    dependencies: ContentSyncCliDependencies = {},
): Promise<number> {
    const projectRoot = path.resolve(dependencies.projectRoot ?? path.resolve(__dirname, "../../.."))
    const runSync = dependencies.runSync ?? runContentSync
    const stdout = dependencies.stdout ?? process.stdout
    const stderr = dependencies.stderr ?? process.stderr
    const setExitCode = dependencies.setExitCode ?? (code => { process.exitCode = code })

    try {
        const { mode } = parseContentSyncArguments(argv)
        const result = await runSync({
            projectRoot,
            env: dependencies.env ?? process.env,
            mode,
        })
        stdout.write(`${JSON.stringify(printableResult(result))}\n`)
        setExitCode(0)
        return 0
    } catch (error) {
        const code = error instanceof ContentSyncCliError
            ? error.code
            : "CONTENT_SYNC_FAILED"
        const message = error instanceof Error ? error.message : "内容同步失败"
        stderr.write(`错误 [${code}]：${sanitizeErrorMessage(message, projectRoot)}\n`)
        setExitCode(1)
        return 1
    }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    return runContentSyncCli(argv)
}
