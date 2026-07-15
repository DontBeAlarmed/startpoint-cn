import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const [, , script, ...args] = process.argv
if (!script) {
    console.error("Usage: node scripts/run-bash.mjs <script> [...args]")
    process.exit(2)
}

let bash = "bash"
if (process.platform === "win32") {
    const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim()
    const bundledBash = resolve(gitExecPath, "../../../bin/bash.exe")
    if (!existsSync(bundledBash)) {
        throw new Error(`Git Bash was not found next to Git's exec path: ${bundledBash}`)
    }
    bash = bundledBash
}

const result = spawnSync(bash, [script, ...args], { stdio: "inherit" })
if (result.error) throw result.error
if (result.signal) {
    console.error(`Bash terminated by signal ${result.signal}`)
    process.exit(1)
}
process.exit(result.status ?? 1)
