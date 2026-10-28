"use strict"

/**
 * 测试引导（L1）：以 esbuild 转译替代 ts-node/register/transpile-only。
 *
 * 动机：ts-node 10 无持久转译缓存，每个测试文件冷启动都要重新转译整个
 * import 闭包（实测 15-25s/文件），是各测试组预算棘轮的主要推手。esbuild
 * transform 单文件 <10ms，语义对 transpile-only 等价（只转译、不检查）。
 *
 * 回退：TEST_BOOTSTRAP=ts-node 环境变量一键回到旧引导（依赖不删）。
 *
 * 覆盖面与 ts-node 相同：.ts/.tsx/.mts/.cts 的 require 钩子；.json 与
 * .node 由 Node 原生处理不受影响。仅转译，不做路径别名解析（本仓测试
 * 不使用 tsconfig paths）。
 */

const fs = require("node:fs")
const path = require("node:path")
const projectRoot = path.resolve(__dirname, "..", "..")

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"]

function installEsbuildRegister() {
    const esbuild = require("esbuild")
    const { Module } = require("node:module")

    for (const extension of EXTENSIONS) {
        Module._extensions[extension] = function (module, filename) {
            const source = fs.readFileSync(filename, "utf8")
            const transformed = esbuild.transformSync(source, {
                loader: extension === ".tsx" ? "tsx" : "ts",
                format: "cjs",
                target: "node18",
                sourcefile: filename,
            })
            module._compile(transformed.code, filename)
        }
    }
}

function bootstrap() {
    // 默认 ts-node：esbuild 的 CJS 互操作（__importStar 值快照）会破坏本仓
    // 测试套件大量使用的模块猴补丁风格（gameTime.getRealNow = ...、
    // stubModule 等）——见 plans/coop-overhaul/test-framework-optimization.md
    // L1 段的风险记录。TEST_BOOTSTRAP=esbuild 可显式试用（实验性）。
    const mode = process.env.TEST_BOOTSTRAP ?? "ts-node"
    if (mode === "ts-node") {
        require("ts-node").register({
            project: path.join(projectRoot, "tsconfig.json"),
            transpileOnly: true,
        })
        return "ts-node"
    }
    installEsbuildRegister()
    // 兼容层：历史测试文件直接 require("ts-node/register/transpile-only")——
    // 指向本引导的 esbuild 注册（已装钩子，此处 require 只需不抛错）。
    require.cache[require.resolve("ts-node/register/transpile-only")] = {
        id: "ts-node/register/transpile-only",
        filename: "ts-node/register/transpile-only",
        loaded: true,
        exports: {},
    }
    return "esbuild"
}

module.exports = { bootstrap }
