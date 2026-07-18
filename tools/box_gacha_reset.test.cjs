const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const sourcePath = path.resolve(
    projectRoot,
    "../wf-assets-cn/orderedmap/box_gacha/box.json",
);
const settingsPath = path.resolve(
    projectRoot,
    "assets/box_gacha_box_settings.json",
);
const generatorPath = path.resolve(__dirname, "rebuild_box_gacha_settings.ts");
const tsNodePath = path.resolve(projectRoot, "node_modules/ts-node/dist/bin.js");

const source = require(sourcePath);

function runGenerator(sourceOverride, outputOverride) {
    return spawnSync(process.execPath, [tsNodePath, generatorPath], {
        cwd: projectRoot,
        env: {
            ...process.env,
            BOX_GACHA_BOX_SOURCE: sourceOverride,
            BOX_GACHA_SETTINGS_OUTPUT: outputOverride,
        },
        encoding: "utf8",
    });
}

const productionBefore = fs.existsSync(settingsPath)
    ? fs.readFileSync(settingsPath)
    : null;
const productionStatBefore = fs.existsSync(settingsPath)
    ? fs.statSync(settingsPath)
    : null;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "box-gacha-settings-"));
const temporaryOutputPath = path.join(temporaryDirectory, "box_gacha_box_settings.json");

try {
    const firstRun = runGenerator(sourcePath, temporaryOutputPath);
    assert.equal(
        firstRun.status,
        0,
        `isolated rebuild must succeed: ${firstRun.stderr || firstRun.error || "unknown error"}`,
    );
    const firstGeneration = fs.readFileSync(temporaryOutputPath);
    if (productionBefore !== null) {
        assert.deepEqual(
            firstGeneration,
            productionBefore,
            "isolated rebuild bytes must match the committed production asset",
        );
    }

    const secondRun = runGenerator(sourcePath, temporaryOutputPath);
    assert.equal(
        secondRun.status,
        0,
        `second isolated rebuild must succeed: ${secondRun.stderr || secondRun.error || "unknown error"}`,
    );
    assert.deepEqual(
        fs.readFileSync(temporaryOutputPath),
        firstGeneration,
        "two consecutive rebuilds must produce identical bytes",
    );

    const invalidCases = [
        {
            name: "gacha ID",
            source: { "01": { "1": [["1", "", "", "(None)", "", "", "", "", "", "", "", "0", "(None)", "2025-01-01 00:00:00", "(None)", "1"]] } },
            expected: /gacha ID.*01/,
        },
        {
            name: "box ID",
            source: { "1": { "0": [["1", "", "", "(None)", "", "", "", "", "", "", "", "0", "(None)", "2025-01-01 00:00:00", "(None)", "1"]] } },
            expected: /box ID.*0/,
        },
        {
            name: "reset kind",
            source: { "1": { "1": [["1", "", "", "(None)", "", "", "", "", "", "", "", "1", "(None)", "2025-01-01 00:00:00", "(None)", "1"]] } },
            expected: /resetKind.*1/,
        },
        {
            name: "nullable number",
            source: { "1": { "1": [["1", "", "", "invalid", "", "", "", "", "", "", "", "0", "(None)", "2025-01-01 00:00:00", "(None)", "1"]] } },
            expected: /requiredBoxId.*invalid/,
        },
        {
            name: "date",
            source: { "1": { "1": [["1", "", "", "(None)", "", "", "", "", "", "", "", "0", "(None)", "2025-13-40 00:00:00", "(None)", "1"]] } },
            expected: /availableFrom.*2025-13-40/,
        },
    ];

    for (const invalidCase of invalidCases) {
        const invalidSourcePath = path.join(temporaryDirectory, `${invalidCase.name}.json`);
        fs.writeFileSync(invalidSourcePath, JSON.stringify(invalidCase.source));
        const invalidRun = runGenerator(invalidSourcePath, temporaryOutputPath);
        assert.notEqual(invalidRun.status, 0, `${invalidCase.name} must be rejected`);
        assert.match(invalidRun.stderr, invalidCase.expected);
    }

    if (productionBefore === null) {
        assert.equal(fs.existsSync(settingsPath), false, "isolated rebuild must not create production asset");
    } else {
        assert.deepEqual(
            fs.readFileSync(settingsPath),
            productionBefore,
            "isolated rebuild must not modify production asset bytes",
        );
        const productionStatAfter = fs.statSync(settingsPath);
        assert.equal(productionStatAfter.mtimeMs, productionStatBefore.mtimeMs);
        assert.equal(productionStatAfter.mode, productionStatBefore.mode);
    }
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

const settings = require(settingsPath);

const sourceGachaIds = Object.keys(source).sort((left, right) => Number(left) - Number(right));
assert.deepEqual(
    Object.keys(settings),
    sourceGachaIds,
    "settings must contain exactly the CN box gacha IDs in numeric order",
);

let boxCount = 0;
let resetKindTwoCount = 0;

for (const gachaId of sourceGachaIds) {
    const sourceBoxIds = Object.keys(source[gachaId])
        .sort((left, right) => Number(left) - Number(right));
    assert.deepEqual(
        Object.keys(settings[gachaId]),
        sourceBoxIds,
        `gacha ${gachaId} must contain exactly the CN box IDs in numeric order`,
    );

    for (const boxId of sourceBoxIds) {
        const wrappedRows = source[gachaId][boxId];
        assert.equal(wrappedRows.length, 1, `gacha ${gachaId} box ${boxId} must have one row`);
        const raw = wrappedRows[0];
        const expected = {
            requiredBoxId: raw[3] === "(None)" ? null : Number(raw[3]),
            resetKind: Number(raw[11]),
            resetLimit: raw[12] === "(None)" ? null : Number(raw[12]),
            availableFrom: raw[13],
            availableUntil: raw[14] === "(None)" ? null : raw[14],
            closeKind: Number(raw[15]),
        };

        assert.deepEqual(
            settings[gachaId][boxId],
            expected,
            `gacha ${gachaId} box ${boxId} settings must match CN fields 3 and 11-15`,
        );
        boxCount++;
        if (expected.resetKind === 2) resetKindTwoCount++;
    }
}

assert.equal(sourceGachaIds.length, 48);
assert.equal(boxCount, 269);
assert.equal(resetKindTwoCount, 38);
assert.deepEqual(settings["28"]["5"], {
    requiredBoxId: 4,
    resetKind: 2,
    resetLimit: null,
    availableFrom: "2025-06-26 12:00:00",
    availableUntil: null,
    closeKind: 1,
});
assert.equal(settings["28"]["4"].resetKind, 0);

require("ts-node/register/transpile-only");
const { getBoxGachaSync } = require("../src/lib/assets.ts");
assert.deepEqual(
    getBoxGachaSync(28)?.boxSettings,
    settings["28"],
    "asset loader must expose box settings for the selected gacha",
);

const settings28 = settings["28"];
try {
    delete settings["28"];
    assert.equal(
        getBoxGachaSync(28),
        null,
        "asset loader must return null when box settings are missing",
    );
} finally {
    settings["28"] = settings28;
}

console.log("box gacha reset asset consistency tests passed");
