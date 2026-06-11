/**
 * Web 面板状态管理：当前活跃存档。
 * 持久化到 .database/active_account.json
 */
import * as fs from "fs";
import * as path from "path";
import { setServerTimeOffset } from "../utils";

const STATE_FILE = path.join(__dirname, "..", "..", ".database", "active_account.json");

interface WebState {
    activePlayerId: number | null;
    selectedAccountId: number | null;
    timeOffset: number | null;
    lastSetTime: string | null;
}

function readState(): WebState {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
            return {
                activePlayerId: raw.activePlayerId ?? null,
                selectedAccountId: raw.selectedAccountId ?? null,
                timeOffset: raw.timeOffset ?? null,
                lastSetTime: raw.lastSetTime ?? null,
            };
        }
    } catch { /* ignore corrupt file */ }
    return { activePlayerId: null, selectedAccountId: null, timeOffset: null, lastSetTime: null };
}

function writeState(state: WebState): void {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

export function getActivePlayerId(): number | null {
    return readState().activePlayerId;
}

export function setActivePlayerId(id: number | null): void {
    const state = readState();
    state.activePlayerId = id;
    writeState(state);
}

export function getSelectedAccountId(): number | null {
    return readState().selectedAccountId;
}

export function setSelectedAccountId(id: number | null): void {
    const state = readState();
    state.selectedAccountId = id;
    writeState(state);
}

/**
 * Save time offset from Web panel, also updates active player's time_offset.
 */
export function saveTimeOffset(offset: number | null): void {
    const state = readState();
    state.timeOffset = offset;
    state.lastSetTime = offset !== null ? new Date(Date.now() + offset).toISOString() : null;
    writeState(state);

    // Also persist to current active player
    const pid = state.activePlayerId;
    if (pid) {
        try {
            const { getDb } = require("./wdfpData");
            getDb().prepare(`UPDATE players SET time_offset = ? WHERE id = ?`).run(offset, pid);
        } catch {}
    }
}

/**
 * Restore time offset on server startup — uses global offset only.
 * Player-specific time is handled by getServerTimeForPlayer.
 */
export function restoreTimeOffset(): void {
    const state = readState();
    if (state.timeOffset !== null) {
        setServerTimeOffset(state.timeOffset);
    }
}
