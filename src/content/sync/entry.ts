import { runContentSyncCli, type ContentSyncCliDependencies } from "./cli"

export interface ContentSyncEntryDependencies {
    readonly runCli?: typeof runContentSyncCli
    readonly env?: NodeJS.ProcessEnv
    readonly stdout?: Pick<NodeJS.WriteStream, "write">
    readonly stderr?: Pick<NodeJS.WriteStream, "write">
    readonly setExitCode?: (code: number) => void
}

export async function runContentSyncEntry(
    argv: readonly string[] = process.argv.slice(2),
    dependencies: ContentSyncEntryDependencies = {},
): Promise<number> {
    const runCli = dependencies.runCli ?? runContentSyncCli
    const stderr = dependencies.stderr ?? process.stderr
    const setExitCode = dependencies.setExitCode ?? (code => { process.exitCode = code })
    const cliDependencies: ContentSyncCliDependencies = {
        env: dependencies.env ?? process.env,
        stdout: dependencies.stdout ?? process.stdout,
        stderr,
        setExitCode,
    }

    try {
        return await runCli(argv, cliDependencies)
    } catch {
        stderr.write("错误 [CONTENT_SYNC_ENTRY_FAILED]：内容同步入口初始化失败\n")
        setExitCode(1)
        return 1
    }
}

if (require.main === module) {
    void runContentSyncEntry()
}
