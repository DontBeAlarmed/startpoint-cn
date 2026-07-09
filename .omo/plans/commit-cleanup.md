# commit 清理 & 文档更新 & 仓库整理

## 当前状态

```
已修改:  assets/confirmed_seeds.json
未追踪:  tools/extract_odds_from_cdn.cjs  (新工具)
未追踪:  tmp/gacha_odds/                   (935 odds 文件，应 gitignore)
未追踪:  assets/cdndata/gacha.json.bak     (备份文件，应删除)
未追踪:  .cdn/zip_index.json               (CDN 索引缓存，应 gitignore)
```

## 执行步骤

### 1. 清理
- 删除 `assets/cdndata/gacha.json.bak`
- 确认 `tools/extract_odds_from_cdn.cjs` 无非法引用（只有 Node.js 内置模块）
- 确认 `confirmed_seeds.json` 的 diff 是合法变更

### 2. 更新 .gitignore
- 添加 `tmp/`
- 添加 `.cdn/zip_index.json`

### 3. Commit
```
feat(tools): extract_odds_from_cdn — 从 CDN 归档按需提取 gacha odds 文件

- tools/extract_odds_from_cdn.cjs: 扫描 677 个 CDN zip 建立索引，按 odds ID 提取
- .gitignore: 添加 tmp/ 和 .cdn/zip_index.json
- 结论: 与旧 assets/gacha_odds/ 提取结果 SHA256 一致
```

### 4. 更新文档
- 在 `docs/protocol/gacha-pool-generation.md` 末尾补充"按需提取"章节
- 说明: tmp/gacha_odds 替代 assets/gacha_odds，从 CDN 归档按需生成
- 使用方法: `node tools/extract_odds_from_cdn.cjs`

### 5. 验证
- `tsc --incremental` 编译通过
- git status 干净（仅预期文件）
