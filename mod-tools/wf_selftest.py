#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WF mod-tools 全链路自检:环境可用性检测 + 功能模拟演练。

把历次功能落地时的临时验证固化成可重复回归:
  * 检测(detect):数据包/核心表/逆向资料/签名表/路径表/APK/CDN/服务端/模拟器 是否就位
  * 模拟(simulate):词条描述抽查、词条工坊 dry-run 组装/跨表模板/缺键新建、
    技能 DSL 字节级往返抽样、命令库构建、强化弹射总览与克隆预检、发布预检
  * --deep 额外做"金丝雀写入闭环":真实写入后立即还原,校验表文件字节复原
    (ability 追加+删行 / PF 克隆新种类+回滚),pending 与备份一并复原

用法:
  python mod-tools/wf_selftest.py            # 只读 + dry-run(随便跑)
  python mod-tools/wf_selftest.py --deep     # 含金丝雀写入闭环(结束即复原)
  python mod-tools/wf_selftest.py --sample 200   # DSL 往返抽样数(默认 60,0=全部)

输出每项 [n/m] PASS/WARN/FAIL;退出码 0=无 FAIL。GUI 工具箱可直接跑。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import time
import zlib
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))

RESULTS: list[tuple[str, str, str]] = []   # (级别, 名称, 详情)
_STEP = [0, 0]


def _emit(level: str, name: str, detail: str = "") -> None:
    RESULTS.append((level, name, detail))
    _STEP[0] += 1
    print(f"[{_STEP[0]}/{_STEP[1]}] {level:4s} {name}" + (f" — {detail}" if detail else ""))


def ok(name, detail=""):
    _emit("PASS", name, detail)


def warn(name, detail=""):
    _emit("WARN", name, detail)


def fail(name, detail=""):
    _emit("FAIL", name, detail)


def check(name: str, fn, warn_only: bool = False):
    """跑一个检查项:fn 返回 str=详情(PASS)/抛异常=FAIL(或 WARN)。"""
    try:
        detail = fn()
        ok(name, detail if isinstance(detail, str) else "")
    except Exception as e:  # noqa: BLE001 —— 自检就是要接住一切
        (warn if warn_only else fail)(name, f"{type(e).__name__}: {e}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deep", action="store_true", help="含金丝雀写入闭环(写入后立即复原)")
    ap.add_argument("--sample", type=int, default=60, help="DSL 往返抽样数(0=全部)")
    args = ap.parse_args()
    _STEP[1] = 20 + (2 if args.deep else 0)

    t0 = time.time()
    print(f"== WF mod-tools 全链路自检 =={'(deep)' if args.deep else ''}")

    # ---------------- 检测:环境与资料 ----------------
    import wf_mod_tool as core
    prof = core.resolve_profile()
    store = prof.store

    check("数据包 store 可达", lambda: (
        f"{store}" if store.is_dir() else (_ for _ in ()).throw(RuntimeError("目录不存在"))))

    import wf_gui  # 复用 GUI 全部真实代码路径(不起服务)
    import wf_describe
    import wf_dsl
    import wf_dsl_sig

    def _tables():
        counts = {}
        # 下限 = CN 1.4.x 实测值的 8 成左右(防表损坏/误换 store,不追新增)
        for lg, least in ((core.ABILITY_LOGICAL, 2300), (wf_gui.LEADER_LOGICAL, 350),
                          (wf_gui.SOUL_LOGICAL, 300), (wf_gui.WEAPON_LOGICAL, 20),
                          (core.CHARACTER_LOGICAL, 400), (wf_gui.EQUIP_LOGICAL, 300),
                          (wf_gui.PF_LOGICAL, 3), (wf_gui.UNIQUE_LOGICAL, 15)):
            n = len(core.load_table(lg, store, store).keys)
            if n < least:
                raise RuntimeError(f"{lg} 只有 {n} 键(< {least})")
            counts[lg.rsplit('/', 1)[-1].split('.')[0]] = n
        return " ".join(f"{k}={v}" for k, v in counts.items())
    check("核心平表读取", _tables)

    def _nested():
        t = core.load_action_skill_table(store, store)
        if len(t.keys) < 400:
            raise RuntimeError(f"action_skill 只有 {len(t.keys)} 键")
        lv = core.decode_action_skill_row(t.rows[0])
        return f"action_skill={len(t.keys)} 首键 {len(lv)} 级"
    check("嵌套表读取(action_skill)", _nested)

    check("ability schema", lambda: (
        f"{len(core.schema_names(wf_gui.load_schema()))} 列"))

    def _enum_map():
        m = wf_describe.enum_map()
        lays = list(m["layouts"])
        opts = wf_describe.enum_options()
        sizes = {k: len(v) for k, v in opts.items()}
        want = {"precondition": 209, "trigger": 262, "during_trigger": 230,
                "instant_content": 724, "during_content": 422}
        for k, n in want.items():
            if sizes.get(k) != n:
                raise RuntimeError(f"{k} 枚举 {sizes.get(k)} ≠ {n}")
        return f"布局 {len(lays)} 表,枚举 {sum(sizes.values())} 项"
    check("词条枚举资料(enum_map+全表§6)", _enum_map)

    check("技能命令签名表(wf_dsl_sig)", lambda: (
        f"命令 {len(wf_dsl_sig.COMMANDS)} 事件 {len(wf_dsl_sig.EVENTS)} "
        f"枚举类 {len(wf_dsl_sig.ENUMS)} AC {len(wf_dsl_sig.AC_CN)}"
        if len(wf_dsl_sig.COMMANDS) >= 112 and len(wf_dsl_sig.EVENTS) >= 6
        else (_ for _ in ()).throw(RuntimeError("签名表缺项"))))

    def _pathlist():
        p = Path(__file__).resolve().parent / "WF_PATHLIST_recovered.txt"
        n = sum(1 for _ in p.open(encoding="utf-8", errors="replace"))
        if n < 50000:
            raise RuntimeError(f"仅 {n} 行(疑似截断)")
        return f"{n} 行"
    check("路径表 WF_PATHLIST_recovered.txt", _pathlist)

    check("语音采集表 HarvestedPaths.csv", lambda: (
        f"{(Path(__file__).resolve().parent / 'HarvestedPaths.csv').stat().st_size // 1024} KB"),
        warn_only=True)

    def _apk():
        apk = wf_gui._find_apk()
        if not apk:
            raise RuntimeError("找不到 APK(WF_APK 或 弹国服/*.apk);PF 内置提取不可用")
        raw = wf_gui._apk_read_asset("battle/action/power_flip/action/knight$knight_lv1")
        if not raw:
            raise RuntimeError(f"{apk.name} 的 bundle 里找不到 knight PF(包不完整?)")
        return f"{apk.name},knight_lv1 {len(raw)}B"
    check("APK 内置 base 可读", _apk, warn_only=True)

    def _cdn():
        import wf_publish
        ver = wf_publish.current_max_version()
        return f"当前最高版本 {ver}"
    check("发布链路(wf_publish/CDN 目录)", _cdn)

    check("服务端探活", lambda: (
        (lambda r: f"{r.get('url')} server_time={r.get('server_time')}"
         if r.get("online") else (_ for _ in ()).throw(RuntimeError(f"离线: {r.get('detail')}")))(
            wf_gui.server_ping())), warn_only=True)

    check("模拟器/adb", lambda: (
        (lambda s: "已连接" if s.get("connected")
         else (_ for _ in ()).throw(RuntimeError("未连接(发布后手动重启游戏即可)")))(
            wf_gui.adb_status())), warn_only=True)

    # ---------------- 模拟:功能演练(dry-run) ----------------
    def _describe():
        ab = core.load_table(core.ABILITY_LOGICAL, store, store)
        n = bad = 0
        for k, t in list(ab.text_rows().items())[:200]:
            for r in core.read_csv_lines(t):
                n += 1
                if wf_describe.describe_line(r, "ability") is None:
                    bad += 1
        if bad:
            raise RuntimeError(f"{bad}/{n} 行描述异常")
        return f"抽查 {n} 行"
    check("行级中文描述抽查", _describe)

    def _composer_meta():
        m = wf_gui.composer_meta()
        if len(m["kinds"]) < 4 or not m["unique_conditions"]:
            raise RuntimeError("meta 缺项")
        return f"{len(m['kinds'])} 表 {len(m['categories'])} 类别 {len(m['groups'])} 角色组"
    check("词条工坊 meta", _composer_meta)

    def _composer_dry():
        m = wf_gui.composer_meta()
        outs = []
        for key, kind in (("1110011", "ability"), ("L:111001", "leader_ability")):
            b = wf_gui.composer_blank(key)
            row = b["row"]
            ib = m["kinds"][b["kind"]]["blocks"]["instant_content"]
            row[ib], row[ib + 1], row[ib + 4], row[ib + 5] = "32", "5", "10000", "10000"
            d = wf_gui.composer_describe(b["kind"], row)["desc"]
            if "攻击力" not in d:
                raise RuntimeError(f"{key} 组装描述异常: {d}")
            r = wf_gui.composer_apply(key, "append", row, True, True)
            if r["changes"] != 1:
                raise RuntimeError(f"{key} apply dry 异常")
            outs.append(kind)
        # 跨表模板(队长技 -> 角色词条 列重排)
        t = wf_gui.composer_row("L:111001", 1, as_key="1110011")
        if t["kind"] != "ability" or len(t["row"]) != t["ncols"]:
            raise RuntimeError("跨表重排异常")
        # 缺键新建(dry)
        r = wf_gui.composer_apply("999000111222", "append",
                                  wf_gui.composer_blank("1110011")["row"],
                                  False, True, True)
        if "新建整键" not in r["log"]:
            raise RuntimeError("create_missing 未生效")
        return "组装/追加 dry ×2 + 跨表模板 + 缺键新建"
    check("词条工坊 dry-run 演练", _composer_dry)

    def _dsl_roundtrip():
        owners = wf_gui._all_program_paths()
        pps = sorted(owners)
        if args.sample:
            pps = pps[:: max(1, len(pps) // args.sample)][:args.sample]
        n = byte_ok = sem_ok = missing = 0
        for pp in pps:
            fp = wf_gui._dsl_store_path(pp)
            if not fp.exists():
                missing += 1
                continue
            data = zlib.decompress(fp.read_bytes(), -15)
            b, s = wf_dsl.roundtrip_ok(data)
            n += 1
            byte_ok += b
            sem_ok += (b or s)
            # 字面量保持 JSON 往返(前端同款语义,后端等价校验)
            if wf_dsl.json_text_to_dsl(wf_dsl.dsl_to_json_text(data)) != data and b:
                raise RuntimeError(f"{pp} JSON 往返字节不一致")
        if sem_ok != n:
            raise RuntimeError(f"语义往返 {sem_ok}/{n}")
        return f"{n} 文件:字节级 {byte_ok},语义级 {sem_ok},缺失 {missing}"
    check("技能 DSL 编码往返抽样", _dsl_roundtrip)

    def _csv_multiline_roundtrip():
        # 2026-07-12 U0000 事故回归防线:character_text/character_speech 官方行含
        # 引号内换行的多行单元格,read_csv_lines 必须整段解析且往返字节一致。
        tables = [core.CHARACTER_LOGICAL, wf_gui.CHAR_TEXT2_LOGICAL,
                  "master/character/character_speech.orderedmap", wf_gui.LEADER_LOGICAL]
        n = ml = 0
        for lg in tables:
            om = core.read_orderedmap_file(core.table_path(wf_gui.TARGET_STORE, lg), lg)
            for k, t in om.text_rows().items():
                if core.write_csv_lines(core.read_csv_lines(t)) != t:
                    raise RuntimeError(f"{lg.split('/')[-1]} 键 {k} CSV 往返不一致(多行单元格坑?)")
                n += 1
                if any("\n" in c for r in core.read_csv_lines(t) for c in r):
                    ml += 1
        if ml < 10:
            raise RuntimeError(f"多行单元格样本过少({ml}),检测可能失效")
        return f"{n} 键往返字节一致(含多行单元格 {ml} 键)"
    check("CSV 多行单元格往返(4 表全量)", _csv_multiline_roundtrip)

    def _cmdlib():
        t = time.time()
        r = wf_gui.skill_cmd_lib("CreateCondition", "攻击力", 5)
        if len(r["names"]) < 40 or not r["items"]:
            raise RuntimeError(f"命令库异常: {len(r['names'])} 种 {len(r['items'])} 命中")
        json.loads(r["items"][0]["json"])
        return f"{len(r['names'])} 种命令,构建+检索 {time.time() - t:.1f}s"
    check("技能命令库", _cmdlib)

    def _pf():
        o = wf_gui.powerflip_overview("111001")
        for k in o["kinds"]:
            if k["std"] and not all(l["in_store"] or l["in_apk"] for l in k["levels"]):
                raise RuntimeError(f"标准种类 {k['id']} 有级别既不在 store 也不在 APK")
        r = wf_gui.powerflip_clone("special", "pf_selftest_probe", True)
        if r["changes"] != 4:
            raise RuntimeError("clone dry 异常")
        r2 = wf_gui.powerflip_extract("knight", True)
        return f"{len(o['kinds'])} 种类;clone/extract dry OK({r2['changes']} 文件可提)"
    check("强化弹射(总览/克隆/提取 dry)", _pf)

    check("发布预检(list_only)", lambda: (
        (lambda r: (r.get("log") or "").splitlines()[-1][:60] if r else "")(
            wf_gui.run_publish(list_only=True))), warn_only=True)

    # ---------------- deep:金丝雀写入闭环(写入后立即复原) ----------------
    if args.deep:
        def _canary_ability():
            tblp = core.table_path(store, core.ABILITY_LOGICAL)
            h0 = hashlib.sha1(tblp.read_bytes()).hexdigest()
            pend0 = list(wf_gui.read_pending())
            n0 = wf_gui.composer_row("1110011", 1)["lines_total"]
            m = wf_gui.composer_meta()
            b = wf_gui.composer_blank("1110011")
            row = b["row"]
            ib = m["kinds"]["ability"]["blocks"]["instant_content"]
            row[ib], row[ib + 1], row[ib + 4] = "32", "5", "10000"
            wf_gui.composer_apply("1110011", "append", row, True, False)
            wf_gui.delete_line("1110011", n0 + 1, False)
            h1 = hashlib.sha1(tblp.read_bytes()).hexdigest()
            # 清理本轮备份与 pending
            for bak in tblp.parent.glob(tblp.name + ".bak-wfmod-gui-*"):
                if bak.stat().st_mtime >= t0:
                    bak.unlink()
            wf_gui.PENDING_FILE.write_text(json.dumps(pend0, indent=2), encoding="utf-8")
            if h0 != h1:
                raise RuntimeError("追加+删行后表文件字节未复原!")
            return "ability 表追加+删行 → 字节复原 ✓"
        check("金丝雀:词条写入闭环", _canary_ability)

        def _canary_pf():
            tblp = core.table_path(store, wf_gui.PF_LOGICAL)
            h0 = hashlib.sha1(tblp.read_bytes()).hexdigest()
            pend0 = list(wf_gui.read_pending())
            r = wf_gui.powerflip_clone("special", "pf_selftest_canary", False)
            for pp in r["paths"]:
                fp = wf_gui._dsl_store_path(pp)
                if not fp.exists():
                    raise RuntimeError(f"克隆文件未落盘: {pp}")
                fp.unlink()
            baks = sorted(tblp.parent.glob(tblp.name + ".bak-wfmod-gui-*"))
            tblp.write_bytes(baks[-1].read_bytes())
            for bak in baks:
                if bak.stat().st_mtime >= t0:
                    bak.unlink()
            wf_gui.PENDING_FILE.write_text(json.dumps(pend0, indent=2), encoding="utf-8")
            if hashlib.sha1(tblp.read_bytes()).hexdigest() != h0:
                raise RuntimeError("PF 表回滚后字节不一致!")
            return "PF 克隆新种类 → 回滚 → 字节复原 ✓"
        check("金丝雀:PF 克隆闭环", _canary_pf)

    # ---------------- 汇总 ----------------
    n_pass = sum(1 for l, _, _ in RESULTS if l == "PASS")
    n_warn = sum(1 for l, _, _ in RESULTS if l == "WARN")
    n_fail = sum(1 for l, _, _ in RESULTS if l == "FAIL")
    print(f"\n== 自检完成({time.time() - t0:.1f}s):PASS {n_pass} / WARN {n_warn} / FAIL {n_fail} ==")
    for lvl, name, detail in RESULTS:
        if lvl != "PASS":
            print(f"  {lvl}: {name} — {detail}")
    if n_fail == 0:
        print("链路可用" + ("(服务端/模拟器为 WARN 时,发布与重启需人工确认)" if n_warn else ""))
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
