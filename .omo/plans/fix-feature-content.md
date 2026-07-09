# 修复 feature_content 有序图

## 目标

`GachaFeatureContentTable` 有序图覆盖全部 584 个 gacha ID，且每个条目有有效图片路径（不再有 `(None)` 或空值导致 C2032）。

## 问题分类

```
584 个 gacha ID
  ├── 324 有效（不改）
  └── 260 问题
        ├── A: 条目存在，Section 1 图片路径为 (None)/空 — 219 个
        ├── B1: 条目缺失，但 gacha.json 中有同类 — 38 个
        └── B2: 条目缺失，无同类 — 3 个
```

## 模板

| 类型 | Section 1 模板 |
|------|---------------|
| 角色池 (kind=0) | `["0", "", "gacha/feature_movie/release_gacha/top/feature", "", "", "", "(None)", "", ""]` |
| 装备池 (kind=1) | `["1", "dynamic/gacha_banner/equipment_gacha", "", "", "", "", "(None)", "", ""]` |

## 执行步骤

### Step 1: 生成修复后的 gacha_feature_content.json

编写 `tools/fix_feature_content.cjs`，执行以下逻辑：

#### A类：改写 (None) 条目

遍历 fc 中所有条目，检查 Section 1[0]：
- 如果 prizeKind=0 且 pos 2 为空/`(None)` → 填入 pos 2 = `gacha/feature_movie/release_gacha/top/feature`
- 如果 prizeKind=1 且 pos 1 为空/`(None)` → 填入 pos 1 = `dynamic/gacha_banner/equipment_gacha`

#### B1类：补充缺失的复刻条目

遍历 gacha.json 中不在 fc 的 ID：
- 去掉 stringId 的 `_N` 后缀，查找 fc 中是否有同类
- 有 → 深拷贝同类的 Section 1（保留原始图片路径）
- prizeKind 通过 gacha.json row[13] 判断

#### B2类：补充缺失的全新条目

B1 之后仍未覆盖的 ID：
- prizeKind=0 → 用角色模板
- prizeKind=1 → 用装备模板

### Step 2: 输出新的 JSON

写入 `assets/cdndata/gacha_feature_content.json`（覆盖原文件）。

### Step 3: 重新生成有序图

```bash
node tools/rebuild_asset_patch.cjs
```

### Step 4: 更新 manifest + 打包

- bump 版本号（1.4.56 → 1.4.57）
- 更新 `manifest.json`
- 重新生成 active zip
- 编译 + 重启

### Step 5: 验证

- 有序图条目数 = 584
- 不再有 `(None)` 或空图片路径
- 41 个缺失条目已补全
