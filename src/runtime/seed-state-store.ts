import * as fs from "fs";
import { randomUUID } from "crypto";
import {
    DataVolumeFileSystem,
    prepareSeedStateDirectory,
    resolveRuntimeDataPaths,
    RuntimeDataPaths,
} from "./data-paths";
import {
    SeedRuntimeSnapshot,
    validateSeedRuntimeSnapshot,
} from "./seed-state-schema";

export { SeedRuntimeSnapshot } from "./seed-state-schema";

export interface SeedStateFileSystem extends DataVolumeFileSystem {
    readFileSync(path: fs.PathOrFileDescriptor, options: BufferEncoding): string;
    writeFileSync(file: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions): void;
}

export interface SeedStateStore {
    /** Implementations must return a schema-validated, normalized snapshot. */
    read(): SeedRuntimeSnapshot | null;
    write(snapshot: SeedRuntimeSnapshot): void;
}

export interface SeedStateStoreOptions {
    dataPaths?: RuntimeDataPaths;
    fileSystem?: SeedStateFileSystem;
    temporaryFileId?: () => string;
    validateSnapshot?: typeof validateSeedRuntimeSnapshot;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function inspectOptionalRegularFile(
    target: string,
    label: string,
    fileSystem: SeedStateFileSystem,
): fs.Stats | null {
    let stats: fs.Stats;
    try {
        stats = fileSystem.lstatSync(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error(`Failed to inspect ${label.toLowerCase()} "${target}": ${errorMessage(error)}`);
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`${label} must be a regular file: ${target}`);
    }
    return stats;
}

function inspectOptionalDirectory(
    directory: string,
    label: string,
    fileSystem: SeedStateFileSystem,
): boolean {
    let stats: fs.Stats;
    try {
        stats = fileSystem.lstatSync(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new Error(`Failed to inspect ${label.toLowerCase()} "${directory}": ${errorMessage(error)}`);
    }
    if (stats.isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link: ${directory}`);
    }
    if (!stats.isDirectory()) {
        throw new Error(`${label} must be a directory: ${directory}`);
    }
    return true;
}

class FileSeedStateStore implements SeedStateStore {
    constructor(
        private readonly dataPaths: RuntimeDataPaths,
        private readonly fileSystem: SeedStateFileSystem,
        private readonly temporaryFileId: () => string,
        private readonly validateSnapshot: typeof validateSeedRuntimeSnapshot,
    ) {}

    read(): SeedRuntimeSnapshot | null {
        const hasDataRoot = inspectOptionalDirectory(
            this.dataPaths.dataDir,
            "Data volume root",
            this.fileSystem,
        );
        const hasStateDirectory = hasDataRoot && inspectOptionalDirectory(
            this.dataPaths.stateDir,
            "Data volume state directory",
            this.fileSystem,
        );
        const hasSeedStateDirectory = hasStateDirectory && inspectOptionalDirectory(
            this.dataPaths.seedStateDir,
            "Seed state directory",
            this.fileSystem,
        );
        if (!hasSeedStateDirectory) return null;
        if (inspectOptionalRegularFile(
            this.dataPaths.seedStateFile,
            "Seed state target",
            this.fileSystem,
        ) === null) return null;

        let source: string;
        try {
            source = this.fileSystem.readFileSync(this.dataPaths.seedStateFile, "utf8");
        } catch (error) {
            throw new Error(`Failed to read seed state snapshot: ${errorMessage(error)}`);
        }
        try {
            return this.validateSnapshot(JSON.parse(source));
        } catch (error) {
            if (error instanceof SyntaxError) {
                throw new Error(`Invalid seed state JSON: ${errorMessage(error)}`);
            }
            throw new Error(`Invalid seed state snapshot: ${errorMessage(error)}`);
        }
    }

    write(snapshot: SeedRuntimeSnapshot): void {
        const normalizedSnapshot = this.validateSnapshot(snapshot);
        prepareSeedStateDirectory(this.dataPaths, this.fileSystem);
        inspectOptionalRegularFile(
            this.dataPaths.seedStateFile,
            "Seed state target",
            this.fileSystem,
        );
        const temporaryId = this.temporaryFileId();
        if (!/^[A-Za-z0-9-]+$/.test(temporaryId)) {
            throw new Error("Seed state temporary file ID is invalid");
        }
        const temporaryFile = `${this.dataPaths.seedStateTemporaryFilePrefix}${temporaryId}.tmp`;

        let descriptor: number | null = null;
        let createdTemporary = false;
        try {
            descriptor = this.fileSystem.openSync(temporaryFile, "wx");
            createdTemporary = true;
            this.fileSystem.writeFileSync(descriptor, JSON.stringify(normalizedSnapshot, null, 2), "utf8");
            this.fileSystem.fsyncSync(descriptor);
            this.fileSystem.closeSync(descriptor);
            descriptor = null;

            inspectOptionalRegularFile(
                this.dataPaths.seedStateFile,
                "Seed state target",
                this.fileSystem,
            );
            // This supports retry after process interruption. Without directory fsync,
            // it does not promise durability across OS or storage power loss.
            this.fileSystem.renameSync(
                temporaryFile,
                this.dataPaths.seedStateFile,
            );
            createdTemporary = false;
        } catch (error) {
            if (descriptor !== null) {
                try {
                    this.fileSystem.closeSync(descriptor);
                } catch {
                    // Preserve the publication error below.
                }
            }
            if (createdTemporary) {
                try {
                    this.fileSystem.unlinkSync(temporaryFile);
                } catch (cleanupError) {
                    throw new Error(
                        `Failed to publish seed state snapshot: ${errorMessage(error)}; `
                        + `temporary cleanup failed: ${errorMessage(cleanupError)}`,
                    );
                }
            }
            throw new Error(`Failed to publish seed state snapshot: ${errorMessage(error)}`);
        }
    }
}

export function createSeedStateStore(options: SeedStateStoreOptions = {}): SeedStateStore {
    return new FileSeedStateStore(
        options.dataPaths ?? resolveRuntimeDataPaths(),
        options.fileSystem ?? fs,
        options.temporaryFileId ?? randomUUID,
        options.validateSnapshot ?? validateSeedRuntimeSnapshot,
    );
}
