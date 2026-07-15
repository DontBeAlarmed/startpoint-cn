import { spawnSync } from "node:child_process"

const commands = []
if (process.platform === "win32") {
    commands.push({
        label: "Windows launcher suite",
        file: "powershell",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/tests/test-start-cn.ps1"],
    })
}
commands.push({
    label: "Linux launcher suite",
    file: process.execPath,
    args: ["scripts/run-bash.mjs", "scripts/tests/test-start-cn-sh.sh"],
})

for (const command of commands) {
    const result = spawnSync(command.file, command.args, { stdio: "inherit" })
    if (result.error) throw result.error
    if (result.signal) {
        console.error(`${command.label} terminated by signal ${result.signal}`)
        process.exit(1)
    }
    if (result.status !== 0) process.exit(result.status ?? 1)
}
