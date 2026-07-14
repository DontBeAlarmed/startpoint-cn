# 自建服 · 玩「深渊连战 + 15 把深渊武器」完整指南

面向想**自己从零搭一套私服**、玩这两个自制模式和深渊武器的人。整条链缺任一环都进不去游戏,按顺序来。

## 先备齐四样

| # | 东西 | 说明 |
|---|---|---|
| 1 | 一台 Linux 服务器 + 一个域名 | Node ≥ 20;联机/CDN/证书需要域名(纯本地内网玩可简化,见步骤 3) |
| 2 | 本仓库 `release/modes-20260714` 分支 | 含两模式、武器数据、`client-patch/` 全套客户端改造工具 |
| 3 | **CN CDN 数据 `cn_cdn.rar`(~10GB)** | ⚠️ 官方源 `shijtswydl.leiting.com` **已停服失效**,这份 dump 只能从服主处获取(见步骤 2) |
| 4 | 官方 CN 客户端 APK(1.8.1)+ FFDec + keystore + Android build-tools | 自己重打客户端用(步骤 4) |

---

## 步骤

### 1. 拿代码

```bash
git clone -b release/modes-20260714 https://github.com/kuronzzhan-droid/startpoint-cn.git starpoint-cn
cd starpoint-cn && npm install
```

> 必须是 `release/modes-20260714` 分支。默认 `main` 没有这两个模式。

### 2. 放 CDN 资源

把 `cn_cdn.rar` 解开到 `.cdn/cn/`(目录结构与校验见 [`docs/cdn/overview.md`](cdn/overview.md))。

> ⚠️ **官方 CDN 已停服**,这份 ~10GB dump 官方渠道拿不到了,只能从服主获取:
>
> **【服主填写下载链接 —— 网盘 / BT / 自建镜像】**

### 3. 起服

按 [`docs/deployment.md`](deployment.md) 走(Node 20 + nginx + 域名 + Let's Encrypt + `.env` + TCP 联机口 8003)。

- **公网开服**:照 deployment.md 全套(nginx 反代 + HTTPS + 域名)。
- **本地/内网自己玩**:可简化——`.env` 里 `CN_LISTEN_HOST=0.0.0.0`,客户端直接重定向到 `<你的内网IP>:8001`(见步骤 4),省掉 nginx/域名/证书。

### 4. 打你自己的客户端(**三合一补丁**)

自建服要连**你自己的**服,客户端必须打三个补丁。拿官方 CN APK,用 FFDec 把主 SWF 导出为 AS3 目录(记为 `EXPORT_DIR`),依次应用:

```bash
# ① 免登录 + ② 重定向到你的服(改 DevConfig 两处)
bash client-patch/apply.sh <EXPORT_DIR> <你的host:port>     # 如 192.168.1.10:8001

# ③ 深渊装备战斗门控(否则武器装上不生效!)
python -X utf8 client-patch/abyss-mode-equipment/patch.py \
  --source <EXPORT_DIR>/pinball/common/data/character/BattleCharacterLogic.as \
  --output <EXPORT_DIR>/pinball/common/data/character/BattleCharacterLogic.as
```

然后用 FFDec 把改后的 AS3 导回 SWF、替换进 APK、`zipalign` + `apksigner` 重签名、安装。
`client-patch/abyss-mode-equipment/build_apk.py` 提供了打包+回读验证的一体化脚本(参数见其 README)。

> ‼️ 已发布的 [`WorldFlipper-abyss.apk`](https://github.com/kuronzzhan-droid/wf-abyss-client/releases) 是给"连某个固定服"用的,**自建服请自己重打**指向自己域名的客户端——那个现成包对你没用。

### 5. 进游戏验证

连你的服 → Rush 活动 **700099「深渊连战」** → 打每轮 boss 掉武器/攒代币 → 兑换商店换 15 把深渊武器 → 装上进 700099 / 挑战 2001 / 练习关生效。

---

## 两个模式速览

- **深渊连战(Rush 700099)**:自制无尽/roguelike 活动,每轮不同 boss,通关掉落。
- **15 把深渊武器(`8000101`–`8000115`)**:每属性 2 把 + 通用 3 把,故意超模;代币 `2370099`,兑换商店。
- 门控白名单:武器/能力魂只在 `Rush 700099` · `挑战 2001` · `练习 1–97` 内生效,其余关卡与官方一致。

## 常见坑

- 客户端**只打了免登录+重定向、漏了深渊门控** → 能进服、能拿到武器,但装上在战斗里不生效。三个补丁都要打。
- **没放 CDN 或版本不全** → 客户端卡加载/报错。CDN 是必需的,不是可选。
- 客户端读到自制数据但**没打对应补丁**(如深渊/随机塔)可能崩 → 数据与客户端补丁要配套,全员换包后再发数据。
