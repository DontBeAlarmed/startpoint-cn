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
const resetServicePath = path.resolve(projectRoot, "src/lib/box-gacha-reset.ts");
const protocolPath = path.resolve(projectRoot, "src/lib/box-gacha-protocol.ts");
const routePath = path.resolve(projectRoot, "src/routes/api/boxGacha.ts");

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

const missingFeatures = [];
let resetModule;
try {
    resetModule = require(resetServicePath);
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    missingFeatures.push("box gacha reset service is missing");
}

let protocolModule;
try {
    protocolModule = require(protocolPath);
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    missingFeatures.push("box gacha reset protocol helpers are missing");
}

const routeSource = fs.readFileSync(routePath, "utf8");
if (!routeSource.includes('fastify.post("/reset"')) {
    missingFeatures.push("box_gacha/reset route is missing");
}
assert.deepEqual(missingFeatures, [], missingFeatures.join("; "));

const {
    BoxGachaInvalidPeriodError,
    BoxGachaLockedError,
    BoxGachaNotEmptyError,
    BoxGachaResetLimitReachedError,
    BoxGachaResetUnavailableError,
    BoxGachaStateNotFoundError,
    resetBoxGachaSync,
} = resetModule;

const {
    parseBoxGachaResetRequest,
    sendBoxGachaResultCode,
} = protocolModule;

assert.deepEqual(
    parseBoxGachaResetRequest({ viewer_id: 123, box_gacha_id: 28, box_id: 5, api_count: 1 }),
    { viewerId: 123, boxGachaId: 28, boxId: 5 },
    "valid reset request must be normalized",
);
for (const invalidBody of [
    null,
    undefined,
    [],
    "invalid",
    {},
    { viewer_id: "123", box_gacha_id: 28, box_id: 5 },
    { viewer_id: 123, box_gacha_id: 28.5, box_id: 5 },
    { viewer_id: 123, box_gacha_id: 28, box_id: 0 },
]) {
    assert.equal(
        parseBoxGachaResetRequest(invalidBody),
        null,
        `invalid reset body must be rejected: ${JSON.stringify(invalidBody)}`,
    );
}

{
    const replyState = { headers: {}, statusCode: null, payload: null };
    const reply = {
        header(name, value) {
            replyState.headers[name] = value;
            return this;
        },
        status(statusCode) {
            replyState.statusCode = statusCode;
            return this;
        },
        send(payload) {
            replyState.payload = payload;
            return payload;
        },
    };

    const payload = sendBoxGachaResultCode(reply, 123, 4608);

    assert.equal(replyState.headers["content-type"], "application/x-msgpack");
    assert.equal(replyState.statusCode, 200);
    assert.equal(replyState.payload, payload);
    assert.equal(payload.data_headers.viewer_id, 123);
    assert.equal(payload.data_headers.result_code, 4608);
    assert.deepEqual(payload.data, {});
}

const PLAYER_ID = 18;
const BOX_GACHA_ID = 28;
const BOX_ID = 5;
const AVAILABLE_COUNT = 2732;
const NOW_MS = Date.parse("2025-06-26T13:00:00+09:00");

function boxKey(playerId, boxGachaId, boxId) {
    return `${playerId}:${boxGachaId}:${boxId}`;
}

function createHarness(options = {}) {
    const state = {
        boxes: {
            [boxKey(PLAYER_ID, BOX_GACHA_ID, 1)]: {
                boxId: 1,
                resetTimes: 0,
                remainingNumber: 0,
                isClosed: true,
            },
            [boxKey(PLAYER_ID, BOX_GACHA_ID, 2)]: {
                boxId: 2,
                resetTimes: 0,
                remainingNumber: 0,
                isClosed: true,
            },
            [boxKey(PLAYER_ID, BOX_GACHA_ID, 3)]: {
                boxId: 3,
                resetTimes: 0,
                remainingNumber: 0,
                isClosed: true,
            },
            [boxKey(PLAYER_ID, BOX_GACHA_ID, 4)]: {
                boxId: 4,
                resetTimes: 0,
                remainingNumber: 0,
                isClosed: true,
            },
            [boxKey(PLAYER_ID, BOX_GACHA_ID, BOX_ID)]: {
                boxId: BOX_ID,
                resetTimes: 0,
                remainingNumber: 0,
                isClosed: true,
            },
        },
        drawnRows: [
            { playerId: PLAYER_ID, boxGachaId: BOX_GACHA_ID, boxId: BOX_ID, id: 501, number: 2700 },
            { playerId: PLAYER_ID, boxGachaId: BOX_GACHA_ID, boxId: BOX_ID, id: 502, number: 32 },
            { playerId: PLAYER_ID, boxGachaId: BOX_GACHA_ID, boxId: 4, id: 401, number: 100 },
            { playerId: 19, boxGachaId: BOX_GACHA_ID, boxId: BOX_ID, id: 501, number: 1 },
            { playerId: PLAYER_ID, boxGachaId: 27, boxId: BOX_ID, id: 501, number: 1 },
        ],
        currency: { "18:40528": 999 },
        obtainedRewards: [{ playerId: PLAYER_ID, rewardId: 501, number: 2700 }],
    };
    let inTransaction = false;

    const dependencies = {
        transaction(operation) {
            assert.equal(inTransaction, false, "reset must use one top-level transaction");
            const snapshot = structuredClone(state);
            inTransaction = true;
            try {
                return operation();
            } catch (error) {
                state.boxes = snapshot.boxes;
                state.drawnRows = snapshot.drawnRows;
                state.currency = snapshot.currency;
                state.obtainedRewards = snapshot.obtainedRewards;
                throw error;
            } finally {
                inTransaction = false;
            }
        },
        getBox(playerId, boxGachaId, boxId) {
            assert.equal(inTransaction, true, "box state must be read inside the transaction");
            const box = state.boxes[boxKey(playerId, boxGachaId, boxId)];
            return box ? structuredClone(box) : null;
        },
        updateBox(playerId, boxGachaId, box) {
            assert.equal(inTransaction, true, "box state must be updated inside the transaction");
            const key = boxKey(playerId, boxGachaId, box.boxId);
            assert.ok(state.boxes[key], `box state ${key} must exist`);
            Object.assign(state.boxes[key], box);
        },
        deleteDrawnRewards(playerId, boxGachaId, boxId) {
            assert.equal(inTransaction, true, "drawn rewards must be deleted inside the transaction");
            state.drawnRows = state.drawnRows.filter((row) =>
                row.playerId !== playerId
                || row.boxGachaId !== boxGachaId
                || row.boxId !== boxId
            );
            if (options.failDelete) throw new Error("simulated drawn reward delete failure");
        },
    };

    return { state, dependencies };
}

function createInput(overrides = {}) {
    return {
        playerId: PLAYER_ID,
        boxGachaId: BOX_GACHA_ID,
        boxId: BOX_ID,
        availableCount: AVAILABLE_COUNT,
        settings: settings["28"]["5"],
        nowMs: NOW_MS,
        ...overrides,
    };
}

function assertResetFailsWithoutMutation(harness, input, ErrorType) {
    const before = structuredClone(harness.state);
    assert.throws(
        () => resetBoxGachaSync(input, harness.dependencies),
        ErrorType,
    );
    assert.deepEqual(harness.state, before, `${ErrorType.name} must not leave partial state`);
}

{
    const harness = createHarness();
    const targetRows = harness.state.drawnRows.filter((row) =>
        row.playerId === PLAYER_ID
        && row.boxGachaId === BOX_GACHA_ID
        && row.boxId === BOX_ID
    );
    assert.equal(
        targetRows.reduce((total, row) => total + row.number, 0),
        2732,
        "player 18 gacha 28 box 5 fixture must reproduce all 2732 drawn capsules",
    );
    const before = structuredClone(harness.state);

    const result = resetBoxGachaSync(createInput(), harness.dependencies);

    assert.deepEqual(result, {
        boxId: BOX_ID,
        resetTimes: 1,
        remainingNumber: AVAILABLE_COUNT,
        isClosed: false,
    });
    assert.deepEqual(
        harness.state.boxes[boxKey(PLAYER_ID, BOX_GACHA_ID, BOX_ID)],
        result,
    );
    for (const boxId of [1, 2, 3, 4]) {
        assert.deepEqual(
            harness.state.boxes[boxKey(PLAYER_ID, BOX_GACHA_ID, boxId)],
            before.boxes[boxKey(PLAYER_ID, BOX_GACHA_ID, boxId)],
            `box ${boxId} must not change`,
        );
    }
    assert.deepEqual(harness.state.currency, before.currency, "reset must not deduct currency");
    assert.deepEqual(
        harness.state.obtainedRewards,
        before.obtainedRewards,
        "reset must not reclaim obtained rewards",
    );
    assert.deepEqual(
        harness.state.drawnRows,
        before.drawnRows.filter((row) =>
            row.playerId !== PLAYER_ID
            || row.boxGachaId !== BOX_GACHA_ID
            || row.boxId !== BOX_ID
        ),
        "reset must delete only the exact player + gacha + box drawn rows",
    );

    const afterFirstReset = structuredClone(harness.state);
    assert.throws(
        () => resetBoxGachaSync(createInput(), harness.dependencies),
        BoxGachaNotEmptyError,
        "an immediate retry must fail because the box is no longer empty",
    );
    assert.deepEqual(harness.state, afterFirstReset, "immediate retry must not mutate state");
}

{
    const harness = createHarness();
    harness.state.boxes[boxKey(PLAYER_ID, BOX_GACHA_ID, BOX_ID)].remainingNumber = 1;
    harness.state.boxes[boxKey(PLAYER_ID, BOX_GACHA_ID, BOX_ID)].isClosed = false;
    assertResetFailsWithoutMutation(harness, createInput(), BoxGachaNotEmptyError);
}

{
    const harness = createHarness();
    assertResetFailsWithoutMutation(
        harness,
        createInput({ settings: { ...settings["28"]["5"], resetKind: 0 } }),
        BoxGachaResetUnavailableError,
    );
}

{
    const harness = createHarness();
    harness.state.boxes[boxKey(PLAYER_ID, BOX_GACHA_ID, 4)].remainingNumber = 1;
    harness.state.boxes[boxKey(PLAYER_ID, BOX_GACHA_ID, 4)].isClosed = false;
    assertResetFailsWithoutMutation(harness, createInput(), BoxGachaLockedError);
}

{
    const harness = createHarness();
    harness.state.boxes[boxKey(PLAYER_ID, BOX_GACHA_ID, BOX_ID)].resetTimes = 1;
    assertResetFailsWithoutMutation(
        harness,
        createInput({ settings: { ...settings["28"]["5"], resetLimit: 1 } }),
        BoxGachaResetLimitReachedError,
    );
}

for (const input of [
    createInput({ nowMs: Date.parse("2025-06-26T11:59:59+09:00") }),
    createInput({
        nowMs: Date.parse("2025-06-26T14:00:01+09:00"),
        settings: {
            ...settings["28"]["5"],
            availableUntil: "2025-06-26 14:00:00",
        },
    }),
]) {
    const harness = createHarness();
    const before = structuredClone(harness.state);
    assert.throws(
        () => resetBoxGachaSync(input, harness.dependencies),
        (error) => {
            assert.ok(error instanceof BoxGachaInvalidPeriodError);
            assert.equal(error.errorCode, 4608);
            return true;
        },
    );
    assert.deepEqual(harness.state, before, "period errors must not mutate state");
}

{
    const harness = createHarness();
    delete harness.state.boxes[boxKey(PLAYER_ID, BOX_GACHA_ID, BOX_ID)];
    assertResetFailsWithoutMutation(harness, createInput(), BoxGachaStateNotFoundError);
}

{
    const harness = createHarness({ failDelete: true });
    assertResetFailsWithoutMutation(harness, createInput(), Error);
}

assert.match(
    routeSource,
    /fastify\.post\("\/reset"[\s\S]*?parseBoxGachaResetRequest[\s\S]*?resolvePlayerIdSync[\s\S]*?getServerTimeForPlayer[\s\S]*?sendBoxGachaResultCode[\s\S]*?"all_box_info": getAllBoxList\(playerId, boxGachaId, boxGachaData\.boxes\)/,
    "reset route must validate input, resolve the active player, use player server time, return protocol result codes, and return complete all_box_info",
);

console.log("box gacha reset asset, transaction, and route tests passed");
