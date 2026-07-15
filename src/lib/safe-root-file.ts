import {
    existsSync,
    lstatSync,
    realpathSync,
    statSync,
} from "node:fs";
import { FileHandle, open, realpath } from "node:fs/promises";
import path from "node:path";


function matches(pattern: RegExp, value: string): boolean {
    pattern.lastIndex = 0;
    const result = pattern.test(value);
    pattern.lastIndex = 0;
    return result;
}


function isContained(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== ""
        && relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}


function isSingleLeaf(value: string): boolean {
    return value !== ""
        && value !== "."
        && value !== ".."
        && !value.includes("\0")
        && path.posix.basename(value) === value
        && path.win32.basename(value) === value;
}


export interface SafePathComponent {
    value: string;
    pattern: RegExp;
}


export function resolveSafeRelativeFile(
    root: string,
    components: readonly SafePathComponent[],
): string | null {
    if (components.length === 0) return null;
    if (components.some(item => !isSingleLeaf(item.value) || !matches(item.pattern, item.value))) {
        return null;
    }
    try {
        if (components.some(item => decodeURIComponent(item.value) !== item.value)) return null;
        if (!existsSync(root)) return null;
        const rootReal = realpathSync.native(root);
        if (!statSync(rootReal).isDirectory()) return null;
        const candidate = path.resolve(rootReal, ...components.map(item => item.value));
        if (!isContained(rootReal, candidate)) return null;
        const candidateStat = lstatSync(candidate);
        if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) return null;
        const fileReal = realpathSync.native(candidate);
        return isContained(rootReal, fileReal) ? fileReal : null;
    } catch {
        return null;
    }
}


export function resolveSafeLeaf(root: string, leaf: string, pattern: RegExp): string | null {
    return resolveSafeRelativeFile(root, [{ value: leaf, pattern }]);
}


export async function openSafeRelativeFile(
    root: string,
    components: readonly SafePathComponent[],
): Promise<FileHandle | null> {
    const resolved = resolveSafeRelativeFile(root, components);
    if (resolved === null) return null;

    let handle: FileHandle | null = null;
    try {
        handle = await open(resolved, "r");
        const [openedStat, currentReal] = await Promise.all([handle.stat(), realpath(resolved)]);
        if (!openedStat.isFile() || currentReal !== resolved) {
            await handle.close();
            return null;
        }
        return handle;
    } catch {
        if (handle !== null) {
            try { await handle.close(); } catch { /* best effort after failed open validation */ }
        }
        return null;
    }
}


export async function openSafeLeaf(
    root: string,
    leaf: string,
    pattern: RegExp,
): Promise<FileHandle | null> {
    return openSafeRelativeFile(root, [{ value: leaf, pattern }]);
}
