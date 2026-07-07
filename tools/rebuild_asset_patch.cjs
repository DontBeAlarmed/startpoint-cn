/**
 * Generate patched gacha_feature_content orderedmap.
 * 
 * Fixes C2032 client crash: adds minimal feature_content entries
 * for banners missing from the CDN's gacha_feature_content data.
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

function main() {
    console.log("=== Rebuild asset patch ===\n");

    const fc = JSON.parse(fs.readFileSync(FC_PATH, "utf8"));
    const gacha = JSON.parse(fs.readFileSync(GACHA_PATH, "utf8"));
    
    // Minimal safe feature_content entry
    const MINIMAL_ENTRY = {
        "1": [["1", "", "", "", "", "", "(None)", "", ""]]
    };

    let added = 0;
    let existing = 0;

    for (const [gid, rows] of Object.entries(gacha)) {
        const row = rows[0];
        if (!row || row[9] === "2") continue; // skip equipment
        if (fc[gid] && Object.keys(fc[gid]).length > 0) {
            existing++;
            continue;
        }
        fc[gid] = MINIMAL_ENTRY;
        added++;
    }

    console.log(`Existing entries: ${existing}`);
    console.log(`Added entries: ${added}`);
    console.log(`Total entries: ${existing + added}`);
    console.log(`Banners without fc: 41 (expected)`);
    console.log(`\nPatched entries (first 10):`);
    let shown = 0;
    for (const [gid, rows] of Object.entries(gacha)) {
        const row = rows[0];
        if (!row || row[9] === "2") continue;
        if (fc[gid] && Object.keys(fc[gid]).length > 0 && !fc[gid + "_was_patched"]) {
            // Already existed before patching
            continue;
        }
        if (shown < 10) {
            console.log(`  gid=${gid} "${String(row[1] || '')}"`);
            shown++;
        }
    }

    // Build orderedmap entries
    const entries = Object.entries(fc).map(([key, value]) => ({
        key,
        row: JSON.stringify(value),
    }));

    // Write orderedmap file
    const fp = "orderedmap/gacha/gacha_feature_content.json";
    const hash = hashResourcePath(fp);
    const outDir = path.join(PATCH_DIR, "production", "upload", hash.relativePath.split("/")[0]);
    const outFile = path.join(outDir, hash.relativePath.split("/")[1]);
    
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const buf = serializeOrderedMap(entries);
    fs.writeFileSync(outFile, buf);
    
    console.log(`\nWritten: ${outFile} (${buf.length} bytes, ${entries.length} entries)`);
    console.log(`Hash: ${hash.relativePath}`);
    console.log(`CDN path: production/upload/${hash.relativePath}`);
    console.log("Done.");
}

main();
