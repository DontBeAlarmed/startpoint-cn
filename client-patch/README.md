# 客户端最小补丁(免登录 + 重定向)

让官方 CN 客户端连接本服务,仅需两处改动。补丁作用于 FFDec 反编译出的 AS3 源码。

## 前置要求(自备,均不随本目录分发)

- FFDec 24.0.1(SWF 反编译 / 回封)
- 一份官方 CN 客户端 APK(源)
- 一个签名 keystore(重打包后签名)
- Android build-tools(`zipalign` / `apksigner`)

## 两处改动

1. **免登录** — `pinball/config/core/DevConfig.as`
   - `public static var sdkDummy:Boolean = false;`
   - → `public static var sdkDummy:Boolean = true;`
   - 效果:跳过雷霆 SDK 登录,使用假 userId;支付 / 推送 / 实名等真实 SDK 功能变 stub。
2. **重定向到本服** — `pinball/config/gbits/DevConfig_gf_android.as`
   - 域名 `shijtswygamegf.leiting.com` → `<你的服务器 host:port>`(如 `192.168.1.10:8001`)
   - 协议 `"https"` → `"http"`

## 应用步骤(手动)

1. 用 FFDec 把源 APK 内的主 SWF 反编译 / 导出为 AS3 脚本目录(记为 `EXPORT_DIR`)。
2. 运行 `bash apply.sh <EXPORT_DIR> <host:port>`(或按上文手动改两文件)。
3. 用 FFDec 把改后的 AS3 导回 SWF,替换进 APK,`zipalign` + `apksigner` 重签名。
4. 安装到设备。

## 可选补丁

- **omni-element**(`apply-omni-element.sh` / `omni-element.md`):共鸣通用属性标签。
- **random-floor**(`apply-random-floor.sh` / `random-floor.md`):boss 塔每次进本随机——
  `BattleQuestBaseImpl` 两个 getTower*FloorValues 识别 floor 表 `__random__,K` 头行,
  每次构建 quest 时从池中抽 K 层洗牌。配合 `mod-tools/wf_chain_build.py --pool K` 生成数据。
  ⚠ 未打此补丁的客户端读到 `__random__` 数据会崩,数据须在全员换包后再发。

## 说明

完整的自动化流水线(FFDec 导出 / 导入 / 打包 / 签名)是作者基于 [starview](https://github.com/duosii/starview)(GPL-3.0)的本地扩展,未随本仓库分发。本目录仅提供"最小改动 + 应用脚本",方便手动复现;`apply.sh` 为原创实现,不含 starview 代码。
