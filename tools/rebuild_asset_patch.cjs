/**
 * Generate patched gacha_feature_content + gacha table orderedmaps.
 * 
 * Fixes:
 *   1. C2032 feature_content crash: adds 41 missing entries
 *   2. C2032 getCost() crash: sets pageKind=0 for 38 problematic banners
 * 
 * Usage: node tools/rebuild_asset_patch.cjs
 */
const fs = require("fs");
const path = require("path");
const { hashResourcePath, serializeOrderedMap } = require("./orderedmap_serializer.cjs");

const ROOT = path.resolve(__dirname, "..");
const FC_PATH = path.join(ROOT, "assets", "cdndata", "gacha_feature_content.json");
const GACHA_PATH = path.join(ROOT, "assets", "cdndata", "gacha.json");
const PATCH_DIR = path.join(ROOT, "assets", "asset-patch");

function buildFeatureContentPatch(gacha) {
    console.log("=== [1/2] gacha_feature_content patch ===\n");
    const fc = JSON.parse(fs.readFileSync(FC_PATH, "utf8"));
    const MINIMAL_ENTRY = {
        "1": [["1", "", "", "", "", "", "(None)", "", ""]]
    };

    let added = 0, existing = 0;
    for (const [gid, rows] of Object.entries(gacha)) {
        const row = rows[0];
        if (!row || row[9] === "2") continue;
        if (fc[gid] && Object.keys(fc[gid]).length > 0) { existing++; continue; }
        fc[gid] = MINIMAL_ENTRY;
        added++;
    }

    console.log(`  Existing: ${existing}, Added: ${added}, Total: ${existing + added}`);

    const entries = Object.entries(fc).map(([key, value]) => ({
        key,
        row: JSON.stringify(value),
    }));

    // Write: production/upload/14/dd5a36...
    const fp = "orderedmap/gacha/gacha_feature_content.json";
    const hash = hashResourcePath(fp);
    const outDir = path.join(PATCH_DIR, "production", "upload", hash.relativePath.split("/")[0]);
    const outFile = path.join(outDir, hash.relativePath.split("/")[1]);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const buf = serializeOrderedMap(entries);
    fs.writeFileSync(outFile, buf);
    console.log(`  Written: ${outFile} (${buf.length} bytes, ${entries.length} entries)`);
    return { hash, size: buf.length };
}

function buildGachaTablePatch(gacha) {
    console.log("\n=== [2/2] GachaTable pageKind patch ===\n");

    // pageKind values that cause GachaLogic.getCost() → None → C2032
    const PROBLEMATIC_PK = new Set(["1", "3", "4", "5"]);
    let fixed = 0;

    const entries = [];
    for (const [gid, rows] of Object.entries(gacha)) {
        const row = rows[0];
        if (!row) continue;
        const pk = String(row[4] || "0");
        if (PROBLEMATIC_PK.has(pk)) {
            // Clone and fix pageKind to "0" (Normal)
            const fixedRow = [...row];
            fixedRow[4] = "0";
            entries.push({ key: gid, row: JSON.stringify(fixedRow) });
            fixed++;
            console.log(`  gid=${gid}: pk=${pk}→0 ${String(row[1] || '')}`);
        } else {
            // Keep original
            entries.push({ key: gid, row: JSON.stringify(row) });
        }
    }

    console.log(`\n  Fixed: ${fixed} banners, Total entries: ${entries.length}`);

    // Write: production/upload/2d/61c787b4c237441691b6a4c4e8b4367f35b889
    const fp = "orderedmap/gacha/gacha.json";
    const hash = hashResourcePath(fp);
    const outDir = path.join(PATCH_DIR, "production", "upload", hash.relativePath.split("/")[0]);
    const outFile = path.join(outDir, hash.relativePath.split("/")[1]);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const buf = serializeOrderedMap(entries);
    fs.writeFileSync(outFile, buf);
    console.log(`  Written: ${outFile} (${buf.length} bytes, ${entries.length} entries)`);
    return { hash, size: buf.length };
}

function createPatchArchive(files) {
    console.log("\n=== Creating patch archive ===\n");
    const childProcess = require("child_process");
    const tmpDir = path.join(PATCH_DIR, "tmp");
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    // Copy patch files into tmp with correct paths
    for (const f of files) {
        const src = path.join(PATCH_DIR, "production", "upload", f.hash.relativePath.split("/")[0], f.hash.relativePath.split("/")[1]);
        const dstDir = path.join(tmpDir, "production", "upload", f.hash.relativePath.split("/")[0]);
        if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(src, path.join(dstDir, f.hash.relativePath.split("/")[1]));
        console.log(`  Added to archive: production/upload/${f.hash.relativePath}`);
    }

    // Create ZIP
    const archiveName = "pinball-1.4.55-1.4.56-1";
    const archiveDir = path.join(PATCH_DIR, "archive");
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

    const tmpArchiveDir = path.join(tmpDir, "archive");
    if (!fs.existsSync(tmpArchiveDir)) fs.mkdirSync(tmpArchiveDir, { recursive: true });
    
    // Remove any old archive with same prefix
    for (const f of fs.readdirSync(archiveDir)) {
        if (f.startsWith(archiveName)) fs.unlinkSync(path.join(archiveDir, f));
    }

    const cwd = process.cwd();
    process.chdir(tmpDir);
    childProcess.execSync(`zip -X -r "${path.join(archiveDir, archiveName + '.zip')}" production/`, { stdio: "ignore" });
    process.chdir(cwd);

    // Add SHA1 hash to filename
    const sha1 = childProcess.execSync(`shasum -a 1 "${path.join(archiveDir, archiveName + '.zip')}"`).toString().split(" ")[0];
    const finalName = `${archiveName}-${sha1.substring(0, 8)}.zip`;
    fs.renameSync(path.join(archiveDir, archiveName + ".zip"), path.join(archiveDir, finalName));

    fs.rmSync(tmpDir, { recursive: true });
    const stats = fs.statSync(path.join(archiveDir, finalName));
    console.log(`  Written: ${finalName} (${(stats.size / 1024).toFixed(1)} KB)`);
    
    return { name: finalName, size: stats.size };
}

function main() {
    console.log("=== Rebuild asset patch ===\n");
    const gacha = JSON.parse(fs.readFileSync(GACHA_PATH, "utf8"));

    const fcResult = buildFeatureContentPatch(gacha);
    const gachaResult = buildGachaTablePatch(gacha);
    
    createPatchArchive([fcResult, gachaResult]);

    console.log("\nDone. Next steps:");
    console.log("  1. Set CN_RES_VERSION=1.4.56 in .env");
    console.log("  2. Compile + restart server");
    console.log("  3. Client will download diff archive on next asset update");
}

main();
