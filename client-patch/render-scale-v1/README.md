# render-scale-v1 · 逐角色像素占屏（尊重 frame.scale）

## 问题
v6 用户像素原生 25px，官方群像 14px；客户端 `PixelArtCharacterView` 与战斗 `MemberView`
把动画 scale 强制成常量（角色页/编队/主城=animation.scale 1 × layer 6；战斗=SCALE_RENDERER 6），
完全忽略 frame 容器里的 scale，导致 v6 恒定为官方的 25/14=1.79×（用户实机反馈「像素显著偏大」）。

## 补丁语义
让渲染尊重 frame.scale（逐角色数据驱动）。占屏公式 display = native × frame.scale：
- 官方角色 frame.scale=6：14×6=84（不变，零感知）
- 杰拉德 v6 令 frame.scale=3.36：25×3.36=84（与群像等高）
- 赛瑞斯路线 C 大原生窗同理，frame.scale 逐角色标定到 84。

### 站点 1（已实现）：PixelArtCharacterView（角色页/编队/主城）
- `_loc12_.scale = 1;` → `_loc12_.scale = _loc12_.scale / 6;`
- 该点 `_loc12_` 刚 `Animation.parse` 完，其 .scale 仍是 frame.scale；/6 抵消外层
  `characterLayer.scale = 6`，净得 display = native × frame.scale。**单行、最小改动。**
- 补丁文件：`PixelArtCharacterView.as`（从 live SWF 导出后改）。

### 站点 2（已实现）：MemberView（战斗内，标准构建默认启用）
- `patch_memberview_site2.py` 精确删除 character 的 `scaleX/scaleY = SCALE_RENDERER(6)` 指令，
  保留 shadow 的固定 ×6；角色动画因此继续使用 `Animation.parse` 得到的 frame.scale。
- `build_render_scale_apk.py` 在 UI 类注入后自动执行站点 2，并以双站点 SWF 继续回读、打包和签名。
- 官方角色 frame.scale=6 保持不变；杰拉德 frame.scale=3.36 时战斗占屏与 UI 使用同一公式。

## 构建（需用户执行——涉及 keystore 密码）
凭证纪律：keystore 密码只经 `env:WF_APK_KS_PASS` 传给 apksigner，不落盘不进命令行。
```powershell
$env:WF_APK_KS_PASS = "<你的 keystore 密码>"   # 由你设置，Claude 不接触
python -X utf8 client-patch/render-scale-v1/build_render_scale_apk.py `
  --base D:\WF\startpoint-cn\out\abyss-client-patch\WorldFlipper-abyss.apk `
  --patched-as client-patch/render-scale-v1/PixelArtCharacterView.as `
  --out out/render-scale-v1/WorldFlipper-render-scale.apk `
  --work out/render-scale-v1/work `
  --ffdec D:\WF\startpoint-cn\ffdec_26.2.1\ffdec.jar `
  --java <java8> --zipalign <zipalign> --apksigner D:\WF\starview-windows\apksigner.bat `
  --ks D:\WF\startpoint-cn\弹国服\instrument\wf_new.keystore --ks-pass-env WF_APK_KS_PASS
```
base 选 abyss APK（已叠 abyss+重定向+dual-form），本补丁再叠加，四合一不丢。
构建器回读验证 SWF 内补丁标记后才出签名包。**同一 keystore 覆盖安装保留玩家身份。**

## 配套数据（客户端换包后才发，否则不一致）
- 杰拉德 pixelart frame `scale 4 → 3.36`（1.3.4 数据包）。
- 赛瑞斯 frame.scale 逐帧标定到 native×scale=84。
