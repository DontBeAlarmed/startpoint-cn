#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""wf_rogue_save.py — 生成 Roguelike 专用存档(独立武器池)。

克隆指定存档 → 清空全部武器(players_equipment)+ 清空魂珠道具
(players_items 中 item.category==5 的 436 键,清单 assets/soul_item_ids.json;
魂珠持有判定读道具背包,OwnedAbilitySoulRepository 实证)+ 洗掉编队里的装备/魂珠引用
(players_parties.equipment_1..3 / ability_soul_1..3)→ 角色/练度/其余道具全保留。
配合 assets/rogue_event.json 的每轮掉落:开局武器栏为空,掉什么用什么 = 独立武器池。

用法(项目根运行):
  python mod-tools/wf_rogue_save.py --source 8              # dry-run 预览
  python mod-tools/wf_rogue_save.py --source 8 --apply      # 执行
  python mod-tools/wf_rogue_save.py --reset 10 --apply      # 重置一局:清武器/魂珠/rush进度
  python mod-tools/wf_rogue_save.py --reset 10 --random-boss --restart-game --apply
      # 一条命令整局重开:杀游戏→清状态→随机换无尽boss战场(发布)→拉起游戏
选项:
  --name <存档名>    默认 肉鸽空武器
  --server <url>     默认 WF_SERVER_URL,再读项目 .env,最后回退 127.0.0.1:8001
  --keep-active      克隆后默认存档留在新档(默认会切回原存档,防止误登)
  --reset <id>       不克隆,直接重置指定存档的 run 状态(装备/魂珠道具/编队引用/
                     rush 活动进度与已用队伍全清,角色练度与其余道具保留);改后重启游戏生效

注意:cloneSave 接口会把账号默认存档切到新克隆,本工具默认随后切回 --source;
开一局 run = admin 后台把默认存档切到肉鸽档 → 重启游戏。
"""
import argparse
import csv
import io
import json
import os
import random
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

import wf_server_auth

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT, ".database", "wdfp_data.db")
MUMU = r"D:\WF\MuMuPlayer\nx_main\MuMuManager.exe"
WF_PACKAGE = "com.leiting.wf"
WF_ACTIVITY = "com.leiting.wf/com.leiting.sdk.activity.PrivacyActivity"
RUSH_QUEST_LOGICAL = "master/quest/event/rush_event_quest.orderedmap"


def api_post(server: str, path: str, query: str = "", body: dict | None = None) -> dict:
    url = f"{server}{path}" + (f"?{query}" if query else "")
    data = json.dumps(body).encode("utf-8") if body is not None else b""
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        **wf_server_auth.admin_bearer_headers(Path(ROOT)),
    }
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_soul_ids() -> list[int]:
    soul_json = os.path.join(ROOT, "assets", "soul_item_ids.json")
    try:
        with open(soul_json, encoding="utf-8") as fh:
            return [int(x) for x in json.load(fh)]
    except OSError:
        print(f"[WARN] {soul_json} 不存在,跳过魂珠清理(魂珠会全解锁!)")
        return []


def mumu_sh(cmd: str) -> None:
    subprocess.run([MUMU, "sh", "-v", "1", "-c", cmd], capture_output=True)


def reroll_endless_field(event: str, quest_no: str, apply: bool) -> None:
    """把无尽 quest 的战场(col98)+BGM(col99)随机换成连战塔素材池里的一层。

    素材池 = wf_chain_build.build_pool():官方 floor 表全部带 boss 的层
    (field_data+BGM 三元组实战验证)。每局重置时重摇 = "每局随机 boss"。
    改的是 ② 层主数据,须发布 + 重启游戏生效(重置流程本来就要重启)。
    """
    sys.path.insert(0, os.path.join(ROOT, "mod-tools"))
    import wf_quest_lib as q
    import wf_chain_build as cb

    pool = cb.build_pool()
    field_key, floor_line, bosses = random.choice(pool)
    bgm = cb._cols(floor_line)[1]

    tree = q.load_table(RUSH_QUEST_LOGICAL)
    leaf = tree[event][quest_no]
    was_bytes = isinstance(leaf, bytes)
    line = leaf.decode("utf-8") if was_bytes else leaf
    row = next(csv.reader(io.StringIO(line)))
    print(f"随机战场: {row[98]} -> {field_key}(BGM {bgm};boss: {','.join(bosses)})")
    if not apply:
        return
    row[98] = field_key
    row[99] = bgm
    buf = io.StringIO()
    csv.writer(buf, lineterminator="").writerow(row)
    tree[event][quest_no] = buf.getvalue().encode("utf-8") if was_bytes else buf.getvalue()
    out = q.save_table(RUSH_QUEST_LOGICAL, tree)
    print(f"[OK] 已写入 {out}")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "mod-tools", "wf_publish.py"),
                        "--tables", "rush_event_quest"], cwd=ROOT)
    print(f"[PUBLISH] wf_publish 退出码 {r.returncode}")


def reset_run(db: sqlite3.Connection, player_id: int, apply: bool) -> int:
    row = db.execute("SELECT id, name FROM players WHERE id=?", (player_id,)).fetchone()
    if row is None:
        print(f"[ERR] 存档 player_id={player_id} 不存在")
        return 1
    soul_ids = load_soul_ids()
    n_equip = db.execute("SELECT COUNT(*) FROM players_equipment WHERE player_id=?", (player_id,)).fetchone()[0]
    n_rush = db.execute("SELECT COUNT(*) FROM players_rush_events WHERE player_id=?", (player_id,)).fetchone()[0]
    n_played = db.execute("SELECT COUNT(*) FROM players_rush_events_played_parties WHERE player_id=?", (player_id,)).fetchone()[0]
    print(f"重置目标: id={player_id} 名={row[1]} — 装备{n_equip} rush状态{n_rush} 已用队伍{n_played}")
    print("⚠ 先关闭游戏再重置!局内继续打会把掉落/进度重新写回(force-stop: "
          'MuMuManager.exe sh -v 1 -c "am force-stop com.leiting.wf")')
    if not apply:
        print("[DRY-RUN] 未执行。加 --apply 生效。")
        return 0
    with db:
        db.execute("DELETE FROM players_equipment WHERE player_id=?", (player_id,))
        if soul_ids:
            placeholders = ",".join("?" * len(soul_ids))
            db.execute(f"DELETE FROM players_items WHERE player_id=? AND id IN ({placeholders})", (player_id, *soul_ids))
        db.execute(
            "UPDATE players_parties SET equipment_1=NULL, equipment_2=NULL, equipment_3=NULL,"
            " ability_soul_1=NULL, ability_soul_2=NULL, ability_soul_3=NULL WHERE player_id=?",
            (player_id,),
        )
        db.execute("DELETE FROM players_rush_events WHERE player_id=?", (player_id,))
        db.execute("DELETE FROM players_rush_events_played_parties WHERE player_id=?", (player_id,))
        db.execute("DELETE FROM players_rush_events_cleared_folders WHERE player_id=?", (player_id,))
    print("[OK] run 已重置(装备/魂珠/编队引用/rush 进度全清)。重启游戏生效。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="生成/重置 Roguelike 空武器存档")
    ap.add_argument("--source", type=int, help="源存档 player_id(克隆模式)")
    ap.add_argument("--reset", type=int, help="重置指定存档的 run 状态(不克隆)")
    ap.add_argument("--random-boss", action="store_true",
                    help="重置时随机换无尽战场(连战塔素材池重摇+发布)= 每局随机 boss")
    ap.add_argument("--restart-game", action="store_true",
                    help="重置前 force-stop 游戏、重置后自动拉起(MuMuManager 通道)")
    ap.add_argument("--event", default="700007", help="rush 活动 id(--random-boss 用)")
    ap.add_argument("--quest-no", default="8", help="无尽 quest 在活动内的序号键(--random-boss 用)")
    ap.add_argument("--name", default="肉鸽空武器", help="新存档名")
    ap.add_argument("--server", default=wf_server_auth.resolve_server_url(Path(ROOT)))
    ap.add_argument("--apply", action="store_true", help="真执行(默认 dry-run)")
    ap.add_argument("--keep-active", action="store_true", help="默认存档留在新档")
    args = ap.parse_args()

    if args.reset is not None:
        if args.restart_game and args.apply:
            print("[GAME] force-stop …")
            mumu_sh(f"am force-stop {WF_PACKAGE}")
        db = sqlite3.connect(DB_PATH, timeout=15)
        db.execute("PRAGMA busy_timeout=15000")
        try:
            code = reset_run(db, args.reset, args.apply)
        finally:
            db.close()
        if code == 0 and args.random_boss:
            reroll_endless_field(args.event, args.quest_no, args.apply)
        if code == 0 and args.restart_game and args.apply:
            print("[GAME] 拉起游戏 …")
            mumu_sh(f"am start -n {WF_ACTIVITY}")
        return code

    if args.source is None:
        ap.error("--source 或 --reset 必须给一个")

    db = sqlite3.connect(DB_PATH, timeout=15)
    db.execute("PRAGMA busy_timeout=15000")
    try:
        row = db.execute(
            "SELECT id, account_id, name FROM players WHERE id=?", (args.source,)
        ).fetchone()
        if row is None:
            print(f"[ERR] 源存档 player_id={args.source} 不存在")
            return 1
        pid, account_id, name = row
        n_equip = db.execute(
            "SELECT COUNT(*) FROM players_equipment WHERE player_id=?", (pid,)
        ).fetchone()[0]
        n_char = db.execute(
            "SELECT COUNT(*) FROM players_characters WHERE player_id=?", (pid,)
        ).fetchone()[0]
        n_party = db.execute(
            "SELECT COUNT(*) FROM players_parties WHERE player_id=?", (pid,)
        ).fetchone()[0]
        print(f"源存档: id={pid} 名={name} 账号={account_id} 角色={n_char} 装备={n_equip} 编队行={n_party}")
        print(f"计划: 克隆 → 新档清空 {n_equip} 件装备 + 洗 {n_party} 行编队装备/魂珠引用 → 改名「{args.name}」"
              + ("(默认存档留在新档)" if args.keep_active else f" → 默认存档切回 {pid}"))

        if not args.apply:
            print("[DRY-RUN] 未执行。加 --apply 生效。")
            return 0

        # 1. 克隆(服务端接口,完整复制;副作用=默认存档切到新档)
        r = api_post(args.server, "/api/server/cloneSave", f"playerId={pid}&accountId={account_id}")
        if not r.get("ok"):
            print(f"[ERR] cloneSave 失败: {r}")
            return 1
        new_id = int(r["newPlayerId"])
        print(f"[OK] 克隆完成 → 新存档 player_id={new_id}")

        # 2. 清装备 + 清魂珠道具 + 洗编队引用(短事务,WAL 下与运行中的服务端共存)
        soul_ids = load_soul_ids()
        with db:
            deleted = db.execute(
                "DELETE FROM players_equipment WHERE player_id=?", (new_id,)
            ).rowcount
            souls_deleted = 0
            if soul_ids:
                placeholders = ",".join("?" * len(soul_ids))
                souls_deleted = db.execute(
                    f"DELETE FROM players_items WHERE player_id=? AND id IN ({placeholders})",
                    (new_id, *soul_ids),
                ).rowcount
            scrubbed = db.execute(
                "UPDATE players_parties SET equipment_1=NULL, equipment_2=NULL, equipment_3=NULL,"
                " ability_soul_1=NULL, ability_soul_2=NULL, ability_soul_3=NULL WHERE player_id=?",
                (new_id,),
            ).rowcount
        print(f"[OK] 清空装备 {deleted} 件;清空魂珠道具 {souls_deleted} 个;编队洗引用 {scrubbed} 行")

        # 3. 改名
        r = api_post(args.server, "/api/server/renameSave", body={"playerId": new_id, "name": args.name})
        print(f"[OK] 改名 → {args.name}" if r.get("ok") else f"[WARN] 改名失败: {r}")

        # 4. 默认存档切回源(除非 --keep-active)
        if not args.keep_active:
            r = api_post(args.server, "/api/server/activateSave", f"playerId={pid}")
            print(f"[OK] 默认存档切回 {pid}" if r.get("ok") else f"[WARN] 切回失败: {r}")

        print()
        print("=== 开一局 run ===")
        print(f"1. admin 后台(/admin)账号页把默认存档切到「{args.name}」(id={new_id}),重启游戏;")
        print("2. 进狂热激战(rogue_event.json 已配掉落),武器栏为空,掉什么用什么;")
        print(f"3. run 结束后默认存档切回 {pid},重启游戏。")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
