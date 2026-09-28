/**
 * Web 面板状态管理：当前活跃存档。
 * 持久化到运行时数据目录的 state/active_account.json。
 */
import * as fs from "fs";
import { setServerTimeOffset } from "../utils";
import { prepareDataVolume, resolveRuntimeDataPaths } from "../runtime/data-paths";
import { getAccountPlayersSync } from "./domains/account";
import { getRealNowMs } from "../runtime/time/game-time";

interface WebState {
    activePlayerId: number | null;
    timeOffset: number | null;
    lastSetTime: string | null;
    defaultPlayers: Record<number, number>;
}

function defaultState(): WebState {
    return { activePlayerId: null, timeOffset: null, lastSetTime: null, defaultPlayers: {} };
}

// resolvePlayerIdSync runs on every authenticated request, and each cold read
// replays ~13 sync syscalls (directory preparation + existence probe + file
// read + JSON.parse). Cache the parsed state per resolved state-file path and
// revalidate with a single statSync: every in-process writer goes through
// writeState (which drops the entry), and an external rewrite of the file
// changes mtime/size, so the stat check keeps other processes honest. Paths
// are the cache key, so switching DATA_DIR mid-process cannot cross-contaminate
// volumes.
interface CachedState {
    readonly mtimeMs: number;
    readonly size: number;
    readonly state: WebState;
}

const stateCache = new Map<string, CachedState>();

function parseStateFile(stateFile: string): WebState {
    try {
        const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        return {
            activePlayerId: raw.activePlayerId ?? null,
            timeOffset: raw.timeOffset ?? null,
            lastSetTime: raw.lastSetTime ?? null,
            defaultPlayers: raw.defaultPlayers ?? {},
        };
    } catch { /* ignore corrupt file */ }
    return defaultState();
}

function readState(): WebState {
    const stateFile = resolveRuntimeDataPaths().activeAccountFile;
    try {
        const stats = fs.statSync(stateFile);
        const cached = stateCache.get(stateFile);
        if (cached !== undefined
            && cached.mtimeMs === stats.mtimeMs
            && cached.size === stats.size) {
            return cached.state;
        }
        const state = parseStateFile(stateFile);
        stateCache.set(stateFile, { mtimeMs: stats.mtimeMs, size: stats.size, state });
        return state;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
        // No state file yet: keep the historical side effect of creating the
        // volume directories, then report the empty state.
        stateCache.delete(stateFile);
        prepareDataVolume();
        return defaultState();
    }
}

function writeState(state: WebState): void {
    const stateFile = prepareDataVolume().activeAccountFile;
    stateCache.delete(stateFile);
    fs.writeFileSync(stateFile, JSON.stringify(state));
}

export function getActivePlayerId(): number | null {
    return readState().activePlayerId;
}

export interface AdminPlayerSelectionState {
    readonly activePlayerId: number | null
    readonly defaultPlayers: Readonly<Record<number, number>>
}

export function getAdminPlayerSelectionState(): AdminPlayerSelectionState {
    const state = readState()
    return Object.freeze({
        activePlayerId: state.activePlayerId,
        defaultPlayers: Object.freeze({ ...state.defaultPlayers }),
    })
}

export function setActivePlayerId(id: number | null): void {
    const state = readState();
    state.activePlayerId = id;
    writeState(state);
}

/**
 * Save the global server time offset from Web panel.
 */
export function saveTimeOffset(offset: number | null): void {
    const state = readState();
    state.timeOffset = offset;
    state.lastSetTime = offset !== null ? new Date(getRealNowMs() + offset).toISOString() : null;
    writeState(state);
}

/**
 * Restore time offset on server startup.
 * Uses saved offset, or defaults to 2024-08-14 12:00 UTC if not set.
 */
export function restoreTimeOffset(): void {
    const state = readState();
    if (state.timeOffset !== null) {
        setServerTimeOffset(state.timeOffset);
    } else {
        const defaultDate = new Date("2024-08-14T12:00:00Z");
        const offset = defaultDate.getTime() - getRealNowMs();
        state.timeOffset = offset;
        state.lastSetTime = defaultDate.toISOString();
        writeState(state);
        setServerTimeOffset(offset);
    }
}

/**
 * Get the default player ID for a specific account.
 * Falls back to null if no default is set.
 */
export function getAccountDefaultPlayer(accountId: number): number | null {
    const state = readState();
    return state.defaultPlayers[accountId] ?? null;
}

/**
 * Save the default player ID for a specific account.
 */
export function saveAccountDefaultPlayer(accountId: number, playerId: number): void {
    const state = readState();
    state.defaultPlayers[accountId] = playerId;
    writeState(state);
}

export function removeAccountFromAdminState(accountId: number, playerIds: number[] = []): void {
    const state = readState()
    delete state.defaultPlayers[accountId]
    if (state.activePlayerId !== null && playerIds.includes(state.activePlayerId)) {
        state.activePlayerId = null
    }
    writeState(state)
}

/**
 * Resolves the active player ID for an account.
 * Uses per-account defaultPlayers, falls back to first player.
 * Returns null if the account has no players.
 */
export function resolvePlayerIdSync(accountId: number): number | null {
    const playerIds = getAccountPlayersSync(accountId);
    if (!playerIds.length) return null;
    const state = readState();
    const preferredId = state.defaultPlayers[accountId];
    return (preferredId && playerIds.includes(preferredId)) ? preferredId : playerIds[0];
}
