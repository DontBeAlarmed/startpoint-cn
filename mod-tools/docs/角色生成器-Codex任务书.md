# 角色生成器与编辑器 · Codex 实施任务书(v2)

> 交给 Codex 的自包含任务说明。**必须在本机工作区 `D:\WF\startpoint-cn` 上以本地模式运行**
> (mod-tools/、弹国服/ 数据包均为未跟踪本地目录,云端克隆的仓库里没有)。
> 环境:Windows 10 + PowerShell,Python 3(已装 Pillow),git 分支 release/modes-20260714。
> v2 变更:发布链路改走 `wf_character_flow.py`(零直写 live)、语音 provider 抽象(开源引擎
> 为主)、三种数据模式、draft/complete 两段式、调整循环、一键生成 API。

## 任务

按设计文档 **`mod-tools/docs/角色生成器方案.md`(v2)** 完整实施「角色生成器与编辑器」工具。
该文档是唯一权威规格,先通读它再动手。实施中若发现规格与代码现实冲突,按"最小偏差+在
最终报告中列出偏差"处理,不要静默改需求。

## 必读背景(动手前按序读)

1. `mod-tools/docs/角色生成器方案.md` — 本次规格(v2:文件清单、阶段定义 S0–S8+data、
   三模式、两段式、调整循环、一键 API、安全规则、验收标准)。
2. `mod-tools/docs/角色包工作流.md` — **发布唯一入口** `wf_character_flow.py` 的完整契约
   (workspace 结构、37/37 门禁、preflight/rebase/publish/rollback、runtime_test 例外模式、
   末行稳定 JSON)。生成器的 pack/publish 阶段全部以此为准。
3. `.claude/skills/wf-mod/SKILL.md` — 项目全景(两层数据架构、发布链路、GUI 端点惯例、
   §4.1 新角色包唯一入口硬门禁)。
4. `.claude/skills/wf-mod/references/api.md` — wf_gui 现有 HTTP API 契约(新端点风格要一致:
   JSON、`{"error": 中文}`、写操作 dry_run 惯例)。
5. `mod-tools/wf_kyle_canary.py` — DERIVATIVES 裁切表与全资产替换流水线(已真机验证,S3 的直接来源)。
6. `mod-tools/wf_canary_skin.py` — fit_rgba / cover_rgba / 色板映射算法(S3/S4 直接复用)。
7. `mod-tools/wf_assets.py` — PNG/MP3 编解码与严格校验、char_asset_manifest。
8. `mod-tools/wf_gui.py` — 只读相关区段:clone_character(仅参考其 dry-run 冲突预检逻辑)、
   replace_asset(仅参考派生/trim 算法)、save_char_fields(仅参考三层同步字段集)、
   composer 一族与 `_client_legality_problems`(S5.5 data 阶段哨兵)、asset_template_check、
   toolbox 后台任务模式(约 5298 行起)、do_GET/do_POST 路由注册(约 7324 行起)。
   文件约 8000 行,用搜索定位,不要全文通读。⚠ v2 下 chargen **不得**调用这些端点直写
   live store——它们只是算法参考源,落盘目标一律是 workspace。
9. `mod-tools/wf_character_flow.py` — 组包/发布子进程调用对象;只允许在测试与 GUI 编排中
   调用 `init/status/preflight`(publish 需口令,实施与测试期间不执行)。
10. `mod-tools/tests/test_canary_skin.py` — 测试风格样板(sys.path 注入、合成 PNG/MP3 fixture、
    不碰真实 store)。

## 交付物(与方案 §10 一致)

新增:

- `mod-tools/wf_openai.py` — 纯 stdlib OpenAI 客户端(images generate/edit、chat),
  transport 可注入,重试/退避/超时,响应缓存;支持 `OPENAI_API_KEY`(已配置为用户级环境变量)/
  `OPENAI_BASE_URL` / `mod-tools/work/openai.json`。
- `mod-tools/wf_voice.py` — 语音 provider 抽象:`local_http`(GPT-SoVITS api_v2 兼容,
  base_url 可配)+ `openai` 后备;统一 wav 出口 → ffmpeg CBR → `mp3_encode` 预检;
  transport 可注入;声线卡含 `source_license` 必填校验。
- `mod-tools/wf_char_gen.py` — 生成引擎 + CLI(plan/text/masters/ui/pixel/voice/data/qa/pack/
  oneclick/adjust、`--spec`、`--force`、`--selftest` 离线自检)。**不 import wf_gui**。
  spec.json 结构自行设计,但须覆盖方案 §3 列出的字段(mode/tier/身份卡/修订链/adjustments/
  数据构建单/package_id)。
- `mod-tools/wf_ui_derive.py` — 从 wf_kyle_canary.py 提炼共享 UI 派生逻辑;改 wf_kyle_canary.py
  引用它,行为不能变(其现有测试必须仍然全绿)。
- `mod-tools/tests/test_char_gen.py`、`tests/test_openai_client.py`、`tests/test_voice.py`、
  `tests/test_ui_derive.py` — 全离线。
- `mod-tools/docs/角色生成器使用说明.md` — 用户手册(配 Key、GPT-SoVITS 部署、成本、
  逐阶段操作、调整循环、draft/complete 发布、回滚)。

修改:

- `mod-tools/wf_gui.py` — `/chargen/*` 端点组(方案 §10;含 oneclick/adjust/pack/flow);
  后台任务独立线程+进度轮询,同时只跑一个,不挤占 toolbox;flow 子进程只解析末行 JSON。
- `mod-tools/wf_gui.html` — 新页签「角色生成」向导(方案 §7 各步:重新生成/上传替换/锁定/调整;
  GIF 预览、语音试听、QA 报告、数据构建单勾选、组包与发布确认流含口令输入框)。
  UI 文案全中文,风格与现有页签一致。
- `.gitignore` — 追加 `mod-tools/work/char_gen/` 与 `mod-tools/work/openai.json`(若未覆盖)。

## 硬性约束(违反=返工)

1. 生成阶段只写 `mod-tools/work/char_gen/`;pack 阶段只写
   `work/character_packs/<package_id>/package/`;实施与测试期间**绝不写真实 store、
   assets/cdndata、`.cdn`**,不执行 `wf_character_flow.py publish/rollback`
   (只允许 init/status/preflight,它们不写 live)。
2. 不执行任何 git 写操作(不 add/commit/branch);交付为工作区未提交改动,由作者审后自行提交。
3. 不修改 `web/pages/`、`src/routes/web/`、`web/public/`、`admin/`、`src/`(服务端 TS 零改动),
   不修改 `wf_character_flow.py`(发现其能力缺口写进偏差报告,不自行扩展)。
4. 不动 `decompile/`、`ffdec_26.2.1/`、`弹国服/`、`pc-run/`、`assets/*.backup.json`。
5. 测试不联网、不依赖真实 OPENAI_API_KEY/本地 TTS 引擎、不 import wf_gui、不读真实 store
   (用临时目录+合成 fixture;flow 集成测试用临时 workspace 跑 status)。
6. spec/缓存/日志不得存 API Key;声线参考音频只接受带 `source_license` 声明的输入。
7. 发布永不自动:oneclick 终点=pack+status+preflight;publish 口令只能由用户人工输入,
   代码里不得出现自动填充 `PUBLISH_CHARACTER_PACKAGE`/`DIRECT_REAL_TEST` 的路径。
8. 全部新文件 LF 换行、UTF-8。Python 风格对齐现有 mod-tools(中文 docstring/注释)。
9. wf_gui.py / wf_gui.html 的修改保持外科手术式:只加不删,现有端点与页面零行为变化。

## 验证(必须真实执行并记录结果)

- `python -m unittest discover -s mod-tools/tests -p "test_*.py" -v`(仓库根执行;个别旧测试
  若因环境缺失本来就跑不了,记录即可,但必须保证:①新增四个测试文件全绿;
  ②test_canary_skin.py 中与 wf_kyle_canary / wf_canary_skin 相关的用例仍全绿)。
- `python mod-tools/wf_char_gen.py --selftest` 在无 Key、无本地 TTS 引擎环境通过。
- flow 集成:临时 workspace 上 `wf_character_flow.py init + status` 真实执行,断言末行 JSON
  可解析且 `errors` 结构符合预期(不执行 preflight 之后的写链路亦可,记录实际执行到哪一步)。
- wf_gui 启动冒烟:`python mod-tools/wf_gui.py` 能起服务(可用 `WF_GUI_PORT` 换端口,
  起来后立即结束进程);若本机缺 store 导致启动即退,记录原因即可,不算失败。
- 绝不虚报:哪些验证实际执行了、哪些没能执行,报告里写清楚。

## 最终报告格式

1. 交付文件清单(新增/修改,行数量级);
2. 每项验证的真实执行结果(命令+结论;未能执行的注明原因);
3. 与设计文档的全部偏差及理由(特别是 wf_character_flow 声明模型对新技能 DSL/新特效路径/
   custom_ability_string 新键的覆盖情况——方案 §13 第一条);
4. 遗留问题/风险清单;
5. spec.json 的字段结构示例(便于审查,含 mode/tier/adjustments/数据构建单)。
