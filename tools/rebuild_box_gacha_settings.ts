import * as fs from "fs";
import * as path from "path";

const SOURCE_PATH = process.env.BOX_GACHA_BOX_SOURCE
    ? path.resolve(process.env.BOX_GACHA_BOX_SOURCE)
    : path.resolve(__dirname, "../../wf-assets-cn/orderedmap/box_gacha/box.json");
const OUTPUT_PATH = process.env.BOX_GACHA_SETTINGS_OUTPUT
    ? path.resolve(process.env.BOX_GACHA_SETTINGS_OUTPUT)
    : path.resolve(__dirname, "../assets/box_gacha_box_settings.json");

interface BoxGachaBoxSettings {
    requiredBoxId: number | null;
    resetKind: number;
    resetLimit: number | null;
    availableFrom: string;
    availableUntil: string | null;
    closeKind: number;
}

type BoxGachaSettings = Record<string, Record<string, BoxGachaBoxSettings>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveId(kind: string, value: string): number {
    if (!/^[1-9]\d*$/.test(value)) {
        throw new Error(`Invalid ${kind} ${value}`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Invalid ${kind} ${value}`);
    }
    return parsed;
}

function parseInteger(
    field: string,
    value: unknown,
    minimum: number,
): number {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
        throw new Error(`Invalid ${field} ${String(value)}`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new Error(`Invalid ${field} ${value}`);
    }
    return parsed;
}

function parseNullableInteger(
    field: string,
    value: unknown,
    minimum: number,
): number | null {
    return value === "(None)" ? null : parseInteger(field, value, minimum);
}

function parseDate(field: string, value: unknown): string {
    if (typeof value !== "string") {
        throw new Error(`Invalid ${field} ${String(value)}`);
    }
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (match === null) {
        throw new Error(`Invalid ${field} ${value}`);
    }
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    const isValid = date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day
        && date.getUTCHours() === hour
        && date.getUTCMinutes() === minute
        && date.getUTCSeconds() === second;
    if (!isValid) {
        throw new Error(`Invalid ${field} ${value}`);
    }
    return value;
}

function parseBoxSettings(gachaId: string, boxId: string, value: unknown): BoxGachaBoxSettings {
    if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0])) {
        throw new Error(`Invalid row wrapper for gacha ${gachaId} box ${boxId}`);
    }
    const raw = value[0] as unknown[];
    if (raw.length < 16) {
        throw new Error(`Invalid row length for gacha ${gachaId} box ${boxId}`);
    }

    const resetKind = parseInteger("resetKind", raw[11], 0);
    if (resetKind !== 0 && resetKind !== 2) {
        throw new Error(`Invalid resetKind ${resetKind} for gacha ${gachaId} box ${boxId}`);
    }
    const closeKind = parseInteger("closeKind", raw[15], 0);
    if (closeKind !== 0 && closeKind !== 1) {
        throw new Error(`Invalid closeKind ${closeKind} for gacha ${gachaId} box ${boxId}`);
    }

    return {
        requiredBoxId: parseNullableInteger("requiredBoxId", raw[3], 1),
        resetKind,
        resetLimit: parseNullableInteger("resetLimit", raw[12], 0),
        availableFrom: parseDate("availableFrom", raw[13]),
        availableUntil: raw[14] === "(None)"
            ? null
            : parseDate("availableUntil", raw[14]),
        closeKind,
    };
}

export function buildBoxGachaSettings(source: unknown): BoxGachaSettings {
    if (!isRecord(source)) {
        throw new Error("Invalid box gacha source root");
    }

    const settings: BoxGachaSettings = {};
    const gachaIds = Object.keys(source)
        .map((gachaId) => [gachaId, parsePositiveId("gacha ID", gachaId)] as const)
        .sort((left, right) => left[1] - right[1]);

    for (const [gachaId] of gachaIds) {
        const sourceBoxes = source[gachaId];
        if (!isRecord(sourceBoxes)) {
            throw new Error(`Invalid boxes for gacha ${gachaId}`);
        }
        const boxes: Record<string, BoxGachaBoxSettings> = {};
        const boxIds = Object.keys(sourceBoxes)
            .map((boxId) => [boxId, parsePositiveId("box ID", boxId)] as const)
            .sort((left, right) => left[1] - right[1]);

        for (const [boxId] of boxIds) {
            boxes[boxId] = parseBoxSettings(gachaId, boxId, sourceBoxes[boxId]);
        }
        settings[gachaId] = boxes;
    }

    return settings;
}

function main(): void {
    const source = JSON.parse(fs.readFileSync(SOURCE_PATH, "utf8")) as unknown;
    const settings = buildBoxGachaSettings(source);
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(settings, null, 2)}\n`);
    const boxCount = Object.values(settings)
        .reduce((total, boxes) => total + Object.keys(boxes).length, 0);
    console.log(`Wrote ${Object.keys(settings).length} gachas and ${boxCount} boxes to ${OUTPUT_PATH}`);
}

if (require.main === module) main();
