# 角色生成器与编辑器 · Codex 实施任务书

> 交给 Codex 的自包含任务说明。**必须在本机工作区 `D:\WF\startpoint-cn` 上以本地模式运行**
> (mod-tools/、弹国服/ 数据包均为未跟踪本地目录,云端克隆的仓库里没有)。
> 环境:Windows 10 + PowerShell,Python 3(已装 Pillow),git 分支 release/modes-20260714。

## 任务

按设计文档 **`mod-tools/docs/角色生成器方案.md`** 完整实施「角色生成器与编辑器」工具。
该文档是唯一权威规格,先通读它再动手。实施中若发现规格与代码现实冲突,按"最小偏差+在
最终报告中列出偏差"处理,不要静默改需求。

## 必读背景(动手前按序读)

1. `mod-tools/docs/角色生成器方案.md` — 本次规格(文件清单、九阶段定义、安全规则、验收标准)。
2. `.claude/skills/wf-mod/SKILL.md` — 项目全景(两层数据架构、发布链路、GUI 端点惯例)。
3. `.claude/skills/wf-mod/references/api.md` — wf_gui 现有 HTTP API 契约(新端点风格要一致:
   JSON、`{"error": 中文}`、写操作 dry_run 惯例)。
4. `mod-tools/wf_kyle_canary.py` — DERIVATIVES 裁切表与全资产替换流水线(已真机验证,S3 的直接来源)。
5. `mod-tools/wf_canary_skin.py` — fit_rgba / cover_rgba / 色板映射算法(S3/S4 直接复用)。
6. `mod-tools/wf_assets.py` — PNG/MP3 编解码与严格校验、char_asset_manifest。
7. `mod-tools/wf_gui.py` — 只读相关区段:clone_character、replace_asset、save_char_fields、
   asset_template_check、toolbox 后台任务模式(约 5298 行起)、do_GET/do_POST 路由注册
   (约 7324 行起)。文件约 8000 行,用搜索定位,不要全文通读。
8. `mod-tools/tests/test_canary_skin.py` — 测试风格样板(sys.path 注入、合成 PNG/MP3 fixture、
   不碰真实 store)。

## 交付物(与方案 §5 一致)

新增:

- `mod-tools/wf_openai.py` — 纯 stdlib OpenAI 客户端(images generate/edit、TTS、chat),
  transport 可注入,重试/退避/超时,响应缓存;支持 `OPENAI_API_KEY` / `OPENAI_BASE_URL` /
  `mod-tools/work/openai.json`。
- `mod-tools/wf_char_gen.py` — 生成引擎 + CLI(plan/text/masters/ui/pixel/voice/qa/all、
  `--spec`、`--force`、`--selftest` 离线自检)。**不 import wf_gui**。spec.json 结构自行设计,
  但须覆盖方案 §3 列出的字段。
- `mod-tools/wf_ui_derive.py` — 从 wf_kyle_canary.py 提炼共享 UI 派生逻辑;改 wf_kyle_canary.py
  引用它,行为不能变(其现有测试必须仍然全绿)。
- `mod-tools/tests/test_char_gen.py`、`mod-tools/tests/test_openai_client.py`、
  `mod-tools/tests/test_ui_derive.py` — 全离线。
- `mod-tools/docs/角色生成器使用说明.md` — 用户手册(配 Key、成本、逐阶段操作、回滚)。

修改:

- `mod-tools/wf_gui.py` — `/chargen/*` 端点组(方案 §5);后台任务用独立线程+进度轮询,
  同时只跑一个,不挤占 toolbox。
- `mod-tools/wf_gui.html` — 新页签「角色生成」向导(方案 §4 的 S0–S8 每步:重新生成/上传替换/
  锁定;GIF 预览、语音试听、QA 报告、apply/publish 确认流)。UI 文案全中文,风格与现有页签一致。
- `.gitignore` — 追加 `mod-tools/work/char_gen/` 与 `mod-tools/work/openai.json`(若未覆盖)。

## 硬性约束(违反=返工)

1. S0–S6 阶段代码只写 `mod-tools/work/char_gen/`;实施与测试期间**绝不写真实 store、
   assets/cdndata、.cdn**(apply/publish 只写代码路径,不实际执行)。
2. 不执行任何 git 写操作(不 add/commit/branch);交付为工作区未提交改动,由作者审后自行提交。
3. 不修改 `web/pages/`、`src/routes/web/`、`web/public/`、`admin/`、`src/`(服务端 TS 零改动)。
4. 不动 `decompile/`、`ffdec_26.2.1/`、`弹国服/`、`pc-run/`、`assets/*.backup.json`。
5. 测试不联网、不依赖真实 OPENAI_API_KEY、不 import wf_gui、不读真实 store
   (用临时目录+合成 fixture)。
6. spec/缓存/日志不得存 API Key。
7. 全部新文件 LF 换行、UTF-8。Python 风格对齐现有 mod-tools(中文 docstring/注释)。
8. wf_gui.py / wf_gui.html 的修改保持外科手术式:只加不删,现有端点与页面零行为变化。

## 验证(必须真实执行并记录结果)

- `python -m unittest discover -s mod-tools/tests -p "test_*.py" -v`(仓库根执行;个别旧测试
  若因环境缺失本来就跑不了,记录即可,但必须保证:①新增三个测试文件全绿;
  ②test_canary_skin.py 中与 wf_kyle_canary / wf_canary_skin 相关的用例仍全绿)。
- `python mod-tools/wf_char_gen.py --selftest` 在无 Key 环境通过。
- wf_gui 启动冒烟:`python mod-tools/wf_gui.py` 能起服务(可用 `WF_GUI_PORT` 换端口,
  起来后立即结束进程);若本机缺 store 导致启动即退,记录原因即可,不算失败。
- 绝不虚报:哪些验证实际执行了、哪些没能执行,报告里写清楚。

## 最终报告格式

1. 交付文件清单(新增/修改,行数量级);
2. 每项验证的真实执行结果(命令+结论;未能执行的注明原因);
3. 与设计文档的全部偏差及理由;
4. 遗留问题/风险清单;
5. spec.json 的字段结构示例(便于审查)。
