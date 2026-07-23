import * as fs from "fs";
import * as path from "path";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const STATE_FILES = ["active_account.json", "default_save.json"] as const;
type StateFileName = typeof STATE_FILES[number];

export interface RuntimeDataPaths {
    dataDir: string;
    stateDir: string;
    seedStateDir: string;
    seedStateFile: string;
    seedStateTemporaryFilePrefix: string;
    databaseFile: string;
    databaseVersionFile: string;
    activeAccountFile: string;
    defaultSaveFile: string;
}

export interface RuntimeDataPathEnvironment {
    readonly [name: string]: string | undefined;
    readonly DATA_DIR?: string;
    readonly WDFP_DATABASE_DIR?: string;
}

export interface RuntimeDataPathApi {
    join(...paths: string[]): string;
    resolve(...paths: string[]): string;
}

export interface DataVolumeFileSystem {
    constants: Pick<typeof fs.constants, "COPYFILE_EXCL" | "R_OK" | "W_OK">;
    accessSync(path: fs.PathLike, mode?: number): void;
    closeSync(fd: number): void;
    copyFileSync(source: fs.PathLike, destination: fs.PathLike, mode?: number): void;
    existsSync(path: fs.PathLike): boolean;
    fsyncSync(fd: number): void;
    lstatSync(path: fs.PathLike): fs.Stats;
    mkdirSync(
        path: fs.PathLike,
        options?: fs.MakeDirectoryOptions & { recursive?: boolean },
    ): string | undefined;
    openSync(path: fs.PathLike, flags: fs.OpenMode): number;
    renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void;
    unlinkSync(path: fs.PathLike): void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function resolveRuntimeDataPaths(
    environment: RuntimeDataPathEnvironment = process.env,
    projectRoot: string = PROJECT_ROOT,
    pathApi: RuntimeDataPathApi = path,
): RuntimeDataPaths {
    const configuredDirectory = environment.DATA_DIR || environment.WDFP_DATABASE_DIR;
    const dataDir = configuredDirectory
        ? pathApi.resolve(projectRoot, configuredDirectory)
        : pathApi.join(pathApi.resolve(projectRoot), ".database");
    const stateDir = pathApi.join(dataDir, "state");

    const seedStateDir = pathApi.join(stateDir, "seeds");

    return {
        dataDir,
        stateDir,
        seedStateDir,
        seedStateFile: pathApi.join(seedStateDir, "seed-state.json"),
        seedStateTemporaryFilePrefix: pathApi.join(seedStateDir, ".seed-state.json."),
        databaseFile: pathApi.join(dataDir, "wdfp_data.db"),
        databaseVersionFile: pathApi.join(dataDir, "wdfp_data.db.version"),
        activeAccountFile: pathApi.join(stateDir, "active_account.json"),
        defaultSaveFile: pathApi.join(stateDir, "default_save.json"),
    };
}

export function prepareSeedStateDirectory(
    paths: RuntimeDataPaths = resolveRuntimeDataPaths(),
    fileSystem: DataVolumeFileSystem = fs,
): string {
    ensureDirectory(paths.dataDir, "Data volume root", fileSystem);
    ensureDirectory(paths.stateDir, "Data volume state directory", fileSystem);
    ensureDirectory(paths.seedStateDir, "Seed state directory", fileSystem);
    assertReadableAndWritable(paths.dataDir, "Data volume root", fileSystem);
    assertReadableAndWritable(paths.stateDir, "Data volume state directory", fileSystem);
    assertReadableAndWritable(paths.seedStateDir, "Seed state directory", fileSystem);
    return paths.seedStateDir;
}

function ensureDirectory(
    directory: string,
    label: string,
    fileSystem: DataVolumeFileSystem,
): void {
    try {
        if (!fileSystem.existsSync(directory)) {
            fileSystem.mkdirSync(directory, { recursive: true });
        }
        const stats = fileSystem.lstatSync(directory);
        if (stats.isSymbolicLink()) {
            throw new Error(`${label} must not be a symbolic link: ${directory}`);
        }
        if (!stats.isDirectory()) {
            throw new Error(`${label} must be a directory: ${directory}`);
        }
    } catch (error) {
        const message = errorMessage(error);
        if (message.startsWith(`${label} must`)) throw error;
        throw new Error(`Failed to prepare ${label.toLowerCase()} "${directory}": ${message}`);
    }
}

function assertReadableAndWritable(
    directory: string,
    label: string,
    fileSystem: DataVolumeFileSystem,
): void {
    try {
        fileSystem.accessSync(
            directory,
            fileSystem.constants.R_OK | fileSystem.constants.W_OK,
        );
    } catch (error) {
        throw new Error(
            `${label} must be readable and writable: ${directory}. ${errorMessage(error)}`,
        );
    }
}

function inspectOptionalPath(
    target: string,
    fileSystem: DataVolumeFileSystem,
): fs.Stats | null {
    try {
        return fileSystem.lstatSync(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error(`Failed to inspect state migration path "${target}": ${errorMessage(error)}`);
    }
}

function inspectOptionalRegularFile(
    target: string,
    label: string,
    fileSystem: DataVolumeFileSystem,
): fs.Stats | null {
    const stats = inspectOptionalPath(target, fileSystem);
    if (stats !== null && (stats.isSymbolicLink() || !stats.isFile())) {
        throw new Error(`${label} must be a regular file: ${target}`);
    }
    return stats;
}

function cleanupTemporaryFile(
    temporaryFile: string,
    fileSystem: DataVolumeFileSystem,
): void {
    const stats = inspectOptionalRegularFile(
        temporaryFile,
        "State migration temporary path",
        fileSystem,
    );
    if (stats === null) return;
    try {
        fileSystem.unlinkSync(temporaryFile);
    } catch (error) {
        throw new Error(
            `Failed to clean up state migration temporary file "${temporaryFile}": ${errorMessage(error)}`,
        );
    }
}

function removeLegacyStateFile(
    source: string,
    fileSystem: DataVolumeFileSystem,
): void {
    try {
        fileSystem.unlinkSync(source);
    } catch (error) {
        throw new Error(
            `Failed to remove legacy state file "${source}": ${errorMessage(error)}`,
        );
    }
}

function flushFile(file: string, fileSystem: DataVolumeFileSystem): void {
    const descriptor = fileSystem.openSync(file, "r");
    try {
        fileSystem.fsyncSync(descriptor);
    } finally {
        fileSystem.closeSync(descriptor);
    }
}

function migrateStateFile(
    fileName: StateFileName,
    paths: RuntimeDataPaths,
    fileSystem: DataVolumeFileSystem,
): void {
    const source = path.join(paths.dataDir, fileName);
    const target = path.join(paths.stateDir, fileName);
    const temporaryFile = path.join(paths.stateDir, `.${fileName}.migrate.tmp`);

    cleanupTemporaryFile(temporaryFile, fileSystem);
    const targetStats = inspectOptionalRegularFile(
        target,
        "Canonical state target",
        fileSystem,
    );
    const sourceStats = inspectOptionalRegularFile(
        source,
        "Legacy state source",
        fileSystem,
    );

    if (targetStats !== null) {
        if (sourceStats !== null) removeLegacyStateFile(source, fileSystem);
        return;
    }
    if (sourceStats === null) return;

    try {
        fileSystem.copyFileSync(source, temporaryFile, fileSystem.constants.COPYFILE_EXCL);
        flushFile(temporaryFile, fileSystem);
        fileSystem.renameSync(temporaryFile, target);
        if (inspectOptionalRegularFile(target, "Canonical state target", fileSystem) === null) {
            throw new Error(`Canonical state target was not published: ${target}`);
        }
    } catch (error) {
        throw new Error(
            `Failed to migrate legacy state file "${source}" to "${target}": ${errorMessage(error)}`,
        );
    }

    removeLegacyStateFile(source, fileSystem);
}

export function prepareDataVolume(
    paths: RuntimeDataPaths = resolveRuntimeDataPaths(),
    fileSystem: DataVolumeFileSystem = fs,
): RuntimeDataPaths {
    ensureDirectory(paths.dataDir, "Data volume root", fileSystem);
    ensureDirectory(paths.stateDir, "Data volume state directory", fileSystem);
    assertReadableAndWritable(paths.dataDir, "Data volume root", fileSystem);
    assertReadableAndWritable(paths.stateDir, "Data volume state directory", fileSystem);

    for (const fileName of STATE_FILES) {
        migrateStateFile(fileName, paths, fileSystem);
    }

    return paths;
}
