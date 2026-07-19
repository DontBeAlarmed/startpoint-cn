import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";

export type CharacterRoot = "common" | "medium" | "android";

export interface ArchiveLocation {
    location: string;
    size: number;
    sha256: string;
}

export interface DiffGroup {
    original_version: string;
    version: string;
    archive: ArchiveLocation[];
}

export interface CharacterArchive {
    root: CharacterRoot;
    relative_path: string;
    size: number;
    sha256: string;
}

export interface CharacterRelease {
    release_id: string;
    package_id: string;
    from_version: string;
    version: string;
    package_manifest_sha256: string;
    archives: CharacterArchive[];
}

export interface ValidatedReleaseChain {
    baseVersion: string;
    tailVersion: string;
    releases: CharacterRelease[];
    error: string | null;
}

const ROOT_DIRS: Record<CharacterRoot, string> = {
    common: "archive-common-diff",
    medium: "archive-medium-diff",
    android: "archive-android-diff",
};
const ROOTS: CharacterRoot[] = ["common", "medium", "android"];
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[a-z0-9][a-z0-9_-]*$/;

function sha256(raw: Buffer): string {
    return createHash("sha256").update(raw).digest("hex");
}

function bump(version: string): string | null {
    if (!VERSION_RE.test(version)) return null;
    const [major, minor, patchValue] = version.split(".").map(Number);
    return `${major}.${minor}.${patchValue + 1}`;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
    const keys = Object.keys(value).sort();
    return keys.length === expected.length
        && keys.every((key, index) => key === [...expected].sort()[index]);
}

function validBasePackageOwners(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const seen = new Set<string>();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2) return false;
        const [packageId, hash] = entry as unknown[];
        if (typeof packageId !== "string" || !TOKEN_RE.test(packageId) || seen.has(packageId)) {
            return false;
        }
        if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
        seen.add(packageId);
    }
    return true;
}

function safeRelative(value: string): boolean {
    if (!value || value.includes("\\") || path.posix.isAbsolute(value)) return false;
    const parts = value.split("/");
    return parts.every(part => part !== "" && part !== "." && part !== "..");
}

function asObject(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function resolveCnCdnDir(): string {
    const configured = process.env.CDN_DIR || ".cdn";
    const parent = path.isAbsolute(configured)
        ? configured
        : path.join(__dirname, "..", "..", configured);
    return path.resolve(parent, "cn");
}

export function readActiveCharacterReleases(cdnDir: string): ValidatedReleaseChain {
    const empty = (error: string | null, baseVersion = ""): ValidatedReleaseChain => ({
        baseVersion,
        tailVersion: baseVersion,
        releases: [],
        error,
    });
    const activePath = path.join(cdnDir, "character-releases", "active.json");
    if (!existsSync(activePath)) return empty(null);
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(activePath, "utf8"));
    } catch (error) {
        return empty(`active.json invalid JSON: ${(error as Error).message}`);
    }
    const manifest = asObject(value);
    const manifestKeysOk = manifest !== null && (
        exactKeys(manifest, ["schema_version", "base_version", "releases"])
        || exactKeys(manifest, ["schema_version", "base_version", "releases", "base_package_owners"])
    );
    if (!manifest || !manifestKeysOk) {
        return empty("active.json fields are invalid");
    }
    if (manifest.base_package_owners !== undefined
        && !validBasePackageOwners(manifest.base_package_owners)) {
        return empty("active.json base_package_owners is invalid");
    }
    if (manifest.schema_version !== 1) return empty("active.json schema_version must be 1");
    const baseVersion = manifest.base_version;
    if (typeof baseVersion !== "string" || !VERSION_RE.test(baseVersion)) {
        return empty("active.json base_version is invalid");
    }
    if (!Array.isArray(manifest.releases)) return empty("active.json releases must be an array");

    const accepted: CharacterRelease[] = [];
    let expectedFrom = baseVersion;
    const seenIds = new Set<string>();
    for (let index = 0; index < manifest.releases.length; index += 1) {
        const rawRelease = asObject(manifest.releases[index]);
        const label = `active.json releases[${index}]`;
        const fail = (message: string): ValidatedReleaseChain => ({
            baseVersion,
            tailVersion: accepted.length > 0
                ? accepted[accepted.length - 1].version
                : baseVersion,
            releases: accepted,
            error: `${label}: ${message}`,
        });
        if (!rawRelease || !exactKeys(rawRelease, [
            "release_id", "package_id", "from_version", "version",
            "package_manifest_sha256", "archives",
        ])) return fail("fields are invalid");
        const releaseId = rawRelease.release_id;
        const packageId = rawRelease.package_id;
        const version = rawRelease.version;
        if (typeof releaseId !== "string" || !TOKEN_RE.test(releaseId) || seenIds.has(releaseId)) {
            return fail("release_id is invalid");
        }
        if (typeof packageId !== "string" || !TOKEN_RE.test(packageId)) {
            return fail("package_id is invalid");
        }
        if (rawRelease.from_version !== expectedFrom || version !== bump(expectedFrom)) {
            return fail("version chain is not continuous");
        }
        if (typeof rawRelease.package_manifest_sha256 !== "string"
            || !HASH_RE.test(rawRelease.package_manifest_sha256)) {
            return fail("package manifest hash is invalid");
        }
        if (!Array.isArray(rawRelease.archives) || rawRelease.archives.length !== 3) {
            return fail("exactly three archives are required");
        }
        const archives: CharacterArchive[] = [];
        const seenRoots = new Set<CharacterRoot>();
        for (const rawArchiveValue of rawRelease.archives) {
            const rawArchive = asObject(rawArchiveValue);
            if (!rawArchive || !exactKeys(rawArchive, ["root", "relative_path", "size", "sha256"])) {
                return fail("archive fields are invalid");
            }
            const rootName = rawArchive.root;
            if (typeof rootName !== "string" || !ROOTS.includes(rootName as CharacterRoot)
                || seenRoots.has(rootName as CharacterRoot)) {
                return fail("archive root is invalid");
            }
            const root = rootName as CharacterRoot;
            seenRoots.add(root);
            const relative = rawArchive.relative_path;
            if (typeof relative !== "string" || !safeRelative(relative)
                || !relative.startsWith(`${ROOT_DIRS[root]}/`)) {
                return fail("archive relative path is invalid");
            }
            const expectedName = `pinball-${expectedFrom}-${version}-1-charpkg-${packageId}-${releaseId}-${root}.zip`;
            if (path.posix.basename(relative) !== expectedName) {
                return fail("archive filename is invalid");
            }
            if (typeof rawArchive.size !== "number" || !Number.isSafeInteger(rawArchive.size)
                || rawArchive.size <= 0 || typeof rawArchive.sha256 !== "string"
                || !HASH_RE.test(rawArchive.sha256)) {
                return fail("archive size/hash declaration is invalid");
            }
            const disk = path.resolve(cdnDir, ...relative.split("/"));
            const rootAnchor = path.resolve(cdnDir);
            if (disk !== rootAnchor && !disk.startsWith(`${rootAnchor}${path.sep}`)) {
                return fail("archive path escapes CDN root");
            }
            let bytes: Buffer;
            try {
                if (!statSync(disk).isFile()) return fail("archive is not a file");
                bytes = readFileSync(disk);
            } catch (error) {
                return fail(`archive is missing: ${relative}: ${(error as Error).message}`);
            }
            if (bytes.length !== rawArchive.size || sha256(bytes) !== rawArchive.sha256) {
                return fail(`archive hash/size mismatch: ${relative}`);
            }
            archives.push({
                root,
                relative_path: relative,
                size: rawArchive.size,
                sha256: rawArchive.sha256,
            });
        }
        seenIds.add(releaseId);
        accepted.push({
            release_id: releaseId,
            package_id: packageId,
            from_version: expectedFrom,
            version: version as string,
            package_manifest_sha256: rawRelease.package_manifest_sha256,
            archives,
        });
        expectedFrom = version as string;
    }
    return {
        baseVersion,
        tailVersion: expectedFrom,
        releases: accepted,
        error: null,
    };
}

export function mergeLegacyAndCharacterDiffs(
    legacy: DiffGroup[],
    chain: ValidatedReleaseChain,
    baseUrl: string,
): DiffGroup[] {
    const normalizedBase = baseUrl.replace(/\/$/, "");
    const legacyWithoutCharacterArchives = legacy
        .map(group => ({
            ...group,
            archive: group.archive.filter(item => !item.location.includes("-charpkg-")),
        }))
        .filter(group => group.archive.length > 0);
    const characterGroups = chain.releases.map(release => ({
        original_version: release.from_version,
        version: release.version,
        archive: release.archives.map(archive => ({
            location: `${normalizedBase}/${archive.relative_path}`,
            size: archive.size,
            sha256: archive.sha256,
        })),
    }));
    return [...legacyWithoutCharacterArchives, ...characterGroups];
}

export function maxCharacterReleaseVersion(cdnDir: string): string | null {
    const chain = readActiveCharacterReleases(cdnDir);
    return chain.releases.length > 0 ? chain.tailVersion : null;
}
