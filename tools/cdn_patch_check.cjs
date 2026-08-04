#!/usr/bin/env node
"use strict"

const fs = require("node:fs")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const envPath = path.join(projectRoot, ".env")
if (fs.existsSync(envPath)) process.loadEnvFile(envPath)

require("ts-node").register({
    project: path.join(projectRoot, "tsconfig.json"),
    transpileOnly: true,
})

void require("../src/content/cdn/patch-check").main()
