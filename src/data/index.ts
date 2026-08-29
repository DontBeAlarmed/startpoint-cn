import sqlite3, { Database as BetterSqlite3Database } from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import initWdfpData from "./initializers/wdfpData";
import {
    updateAfterInit as updateWdfpDataAfter,
    updateBeforeInit as updateWdfpDataBefore,
} from "./updaters/wdfpData";
import {
    prepareDataVolume,
    resolveRuntimeDataPaths,
    RuntimeDataPaths,
} from "../runtime/data-paths";
import { createBetterSqlite3Database } from "../runtime/native-binding";
import { getRealNowMs } from "../runtime/time/game-time";

// better-sqlite3 supports addon objects although the installed type declaration only lists paths.
const sqlite3WithExternalAddon = sqlite3 as unknown as (
    databasePath: string,
    options?: { nativeBinding?: string | object },
) => BetterSqlite3Database;

export const enum Database {
    WDFP_DATA,
}

export interface DatabaseMigrations {
    latestVersion: number;
    init?: (database: BetterSqlite3Database, exists: boolean) => void;
    updateBefore?: (database: BetterSqlite3Database, currentVersion: number) => void;
    updateAfter?: (database: BetterSqlite3Database, currentVersion: number) => void;
}

export interface DatabaseInitializationOptions {
    paths?: RuntimeDataPaths;
    migrations?: DatabaseMigrations;
    databaseFactory?: (databasePath: string) => BetterSqlite3Database;
}

export interface DatabaseStatus {
    open: boolean;
    ready: boolean;
    schema: number | null;
}

export interface DatabaseCheckpointResult {
    mode: "TRUNCATE";
    busy: number;
    log: number;
    checkpointed: number;
}

export class DatabaseLifecycleError extends Error {
    readonly cause: unknown;

    constructor(operation: string, cause: unknown) {
        super(`Database ${operation} failed`);
        this.name = "DatabaseLifecycleError";
        this.cause = cause;
    }
}

const defaultMigrations: DatabaseMigrations = {
    latestVersion: 21,
    init: initWdfpData,
    updateBefore: updateWdfpDataBefore,
    updateAfter: updateWdfpDataAfter,
};

let loadedDatabase: BetterSqlite3Database | null = null;
let loadedSchema: number | null = null;
let initializingDatabase = false;

function requireOpenDatabase(): BetterSqlite3Database {
    if (loadedDatabase === null || !loadedDatabase.open || loadedSchema === null) {
        loadedDatabase = null;
        loadedSchema = null;
        throw new Error("Database is not initialized; call initializeDatabase() first");
    }
    return loadedDatabase;
}

function readLegacyVersion(versionPath: string): number {
    if (!fs.existsSync(versionPath)) return 0;
    const contents = fs.readFileSync(versionPath, "utf8").trim();
    if (!/^\d+$/.test(contents)) return 0;
    const version = Number(contents);
    return Number.isSafeInteger(version) ? version : 0;
}

function publishLegacyVersion(versionPath: string, version: number): void {
    const temporaryPath = path.join(
        path.dirname(versionPath),
        `.${path.basename(versionPath)}.${process.pid}.${getRealNowMs()}.tmp`,
    );
    let descriptor: number | null = null;

    try {
        descriptor = fs.openSync(temporaryPath, "wx");
        fs.writeFileSync(descriptor, version.toString(), "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = null;
        fs.renameSync(temporaryPath, versionPath);
    } catch (error) {
        if (descriptor !== null) {
            try { fs.closeSync(descriptor); } catch { /* preserve publication error */ }
        }
        try { fs.unlinkSync(temporaryPath); } catch { /* temporary file may not exist */ }
        throw error;
    }
}

function readUserVersion(database: BetterSqlite3Database): number {
    const version = database.pragma("user_version", { simple: true });
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
        throw new Error("SQLite returned an invalid schema version");
    }
    return version;
}

export function initializeDatabase(
    options: DatabaseInitializationOptions = {},
): BetterSqlite3Database {
    if (initializingDatabase) {
        throw new Error("Database initialization is already in progress");
    }
    if (loadedDatabase?.open && loadedSchema !== null) return loadedDatabase;
    loadedDatabase = null;
    loadedSchema = null;
    initializingDatabase = true;

    let database: BetterSqlite3Database | null = null;
    try {
        const paths = prepareDataVolume(options.paths ?? resolveRuntimeDataPaths());
        const migrations = options.migrations ?? defaultMigrations;
        if (!Number.isSafeInteger(migrations.latestVersion) || migrations.latestVersion < 0) {
            throw new Error("Database latest schema version is invalid");
        }
        const databaseExists = fs.existsSync(paths.databaseFile);

        const databaseFactory = options.databaseFactory
            ?? ((databasePath: string) => createBetterSqlite3Database(
                sqlite3WithExternalAddon,
                databasePath,
            ));
        database = databaseFactory(paths.databaseFile);

        const userVersion = readUserVersion(database);
        const currentVersion = userVersion === 0 && databaseExists
            ? readLegacyVersion(paths.databaseVersionFile)
            : userVersion;
        if (currentVersion > migrations.latestVersion) {
            throw new Error("Database schema is newer than this server supports");
        }

        database.pragma("journal_mode = WAL");
        database.pragma("foreign_keys = OFF");

        const updateRequired = databaseExists && currentVersion < migrations.latestVersion;
        database.transaction(() => {
            if (updateRequired) migrations.updateBefore?.(database!, currentVersion);
            migrations.init?.(database!, databaseExists);
            if (updateRequired) migrations.updateAfter?.(database!, currentVersion);
            database!.pragma(`user_version = ${migrations.latestVersion}`);
        })();

        database.pragma("foreign_keys = ON");
        publishLegacyVersion(paths.databaseVersionFile, migrations.latestVersion);

        loadedDatabase = database;
        loadedSchema = migrations.latestVersion;
        return database;
    } catch (error) {
        if (database?.open) {
            try { database.close(); } catch { /* preserve initialization error */ }
        }
        loadedDatabase = null;
        loadedSchema = null;
        throw new DatabaseLifecycleError("initialization", error);
    } finally {
        initializingDatabase = false;
    }
}

export function getDatabaseStatus(): DatabaseStatus {
    if (loadedDatabase === null || !loadedDatabase.open || loadedSchema === null) {
        return { open: false, ready: false, schema: null };
    }
    return { open: true, ready: true, schema: loadedSchema };
}

export function checkpointDatabase(): DatabaseCheckpointResult {
    const database = requireOpenDatabase();
    try {
        const rows = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{
            busy: number;
            log: number;
            checkpointed: number;
        }>;
        const result = rows[0];
        if (result === undefined) throw new Error("SQLite returned no checkpoint result");
        return { mode: "TRUNCATE", ...result };
    } catch (error) {
        throw new DatabaseLifecycleError("checkpoint", error);
    }
}

export function closeDatabase(): boolean {
    if (loadedDatabase === null) return false;
    const database = loadedDatabase;
    if (!database.open) {
        loadedDatabase = null;
        loadedSchema = null;
        return false;
    }
    try {
        database.close();
    } catch (error) {
        throw new DatabaseLifecycleError("close", error);
    }
    loadedDatabase = null;
    loadedSchema = null;
    return true;
}

export default function getDatabase(database: Database): BetterSqlite3Database {
    if (database !== Database.WDFP_DATA) throw new Error("Unknown database");
    return requireOpenDatabase();
}
