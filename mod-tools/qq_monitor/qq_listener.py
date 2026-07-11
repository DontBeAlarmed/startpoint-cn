#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QQ 群「修改器反馈」监听器 —— NapCat (OneBot 11) 正向 WebSocket 客户端。

监听目标群内以触发前缀(默认 #修改器)开头的消息，逐条落盘到
inbox/pending.jsonl，供 Claude Code 定期读取处理；处理完可 --reply 回群。

依赖: pip install websockets

用法:
  python qq_listener.py                       常驻监听(前台)
  python qq_listener.py --list-groups         列出 bot 已加入的群(核对群号)
  python qq_listener.py --send "文本"          向目标群发一条消息
  python qq_listener.py --reply 消息ID "文本"   引用回复某条反馈(消息ID即 inbox 记录里的 message_id)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path

try:
    import websockets
except ImportError:
    print("缺少依赖: 先执行 pip install websockets")
    sys.exit(1)

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "config.json"

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def log(msg: str, logfile: Path | None = None) -> None:
    line = f"[{now()}] {msg}"
    print(line, flush=True)
    if logfile:
        try:
            with open(logfile, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass


def norm(s: str) -> str:
    """去掉 emoji 变体选择符/零宽字符/空白，用于群名模糊匹配。"""
    return re.sub("[\\ufe0e\\ufe0f\\u200b\\u200d\\s]", "", s or "")


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        print(f"缺少 {CONFIG_PATH}\n先复制 config.example.json 为 config.json 再按需修改")
        sys.exit(1)
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    cfg.setdefault("ws_url", "ws://127.0.0.1:3001")
    cfg.setdefault("access_token", "")
    cfg.setdefault("group_id", 0)
    cfg.setdefault("group_name", "")
    cfg.setdefault("trigger_prefixes", ["#修改器", "＃修改器"])
    cfg.setdefault("auto_ack", False)
    cfg.setdefault("ack_text", "反馈已收到，进入处理队列。")
    cfg.setdefault("inbox_dir", "inbox")
    return cfg


def extract_text(msg) -> str:
    """从 OneBot 消息段数组里抽纯文本；非数组格式原样转字符串。"""
    if isinstance(msg, list):
        parts = []
        for seg in msg:
            if isinstance(seg, dict) and seg.get("type") == "text":
                parts.append(str(seg.get("data", {}).get("text", "")))
        return "".join(parts)
    return str(msg or "")


class OneBot:
    """单连接 OneBot 11 客户端：API 调用按 echo 配对，事件走回调。"""

    def __init__(self, cfg: dict):
        url = cfg["ws_url"]
        if cfg["access_token"]:
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}access_token={cfg['access_token']}"
        self.url = url
        self.ws = None
        self._pending: dict[str, asyncio.Future] = {}
        self._seq = 0

    async def connect(self):
        self.ws = await websockets.connect(self.url, max_size=None)

    async def close(self):
        try:
            if self.ws:
                await self.ws.close()
        except Exception:
            pass

    async def api(self, action: str, params: dict | None = None, timeout: float = 15):
        self._seq += 1
        echo = f"q{self._seq}"
        fut = asyncio.get_running_loop().create_future()
        self._pending[echo] = fut
        await self.ws.send(json.dumps({"action": action, "params": params or {}, "echo": echo}))
        try:
            resp = await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(echo, None)
        if resp.get("status") == "failed":
            raise RuntimeError(f"{action} 调用失败: {resp}")
        return resp.get("data")

    async def pump(self, on_event):
        """常驻收包循环：API 响应喂给等待的 future，其余事件交回调。"""
        async for raw in self.ws:
            try:
                data = json.loads(raw)
            except (ValueError, TypeError):
                continue
            echo = data.get("echo")
            if echo and echo in self._pending:
                fut = self._pending.get(echo)
                if fut and not fut.done():
                    fut.set_result(data)
                continue
            await on_event(data)


async def open_bot(cfg: dict):
    """建立连接并启动收包任务(忽略事件)，用于一次性命令。"""
    bot = OneBot(cfg)
    await bot.connect()

    async def _ignore(_):
        pass

    task = asyncio.create_task(bot.pump(_ignore))
    return bot, task


async def resolve_group(bot: OneBot, cfg: dict, logfile: Path | None = None) -> int:
    if cfg["group_id"]:
        return int(cfg["group_id"])
    want = norm(str(cfg["group_name"]))
    groups = await bot.api("get_group_list") or []
    if want:
        for g in groups:
            gname = norm(str(g.get("group_name", "")))
            if gname == want or want in gname:
                log(f"按群名匹配到: {g.get('group_name')} → {g.get('group_id')}", logfile)
                return int(g["group_id"])
    log("没匹配到目标群。bot 当前所在的群：", logfile)
    for g in groups:
        log(f"  {g.get('group_id')}  {g.get('group_name')}", logfile)
    raise SystemExit("请把正确的群号填进 config.json 的 group_id")


def _save_state(path: Path, seen: set) -> None:
    try:
        path.write_text(
            json.dumps({"seen": list(seen)[-1000:]}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        pass


async def listen(cfg: dict):
    inbox = BASE / cfg["inbox_dir"]
    inbox.mkdir(exist_ok=True)
    pending = inbox / "pending.jsonl"
    logfile = inbox / "listener.log"
    state_path = BASE / "state.json"
    try:
        seen = set(json.loads(state_path.read_text(encoding="utf-8")).get("seen", []))
    except (OSError, ValueError):
        seen = set()
    prefixes = [p for p in cfg["trigger_prefixes"] if p]
    backoff = 5

    while True:
        bot = OneBot(cfg)
        try:
            await bot.connect()
            gid_holder: dict = {}

            async def on_event(data):
                if data.get("post_type") != "message" or data.get("message_type") != "group":
                    return
                gid = gid_holder.get("gid")
                if gid is None or int(data.get("group_id", -1)) != gid:
                    return
                text = (extract_text(data.get("message")) or str(data.get("raw_message") or "")).strip()
                if not any(text.startswith(p) for p in prefixes):
                    return
                mid = data.get("message_id")
                if mid in seen:
                    return
                seen.add(mid)
                _save_state(state_path, seen)
                sender = data.get("sender") or {}
                rec = {
                    "report_id": time.strftime("%Y%m%d-%H%M%S") + f"-{mid}",
                    "message_id": mid,
                    "group_id": gid,
                    "user_id": data.get("user_id"),
                    "nickname": sender.get("card") or sender.get("nickname") or "",
                    "time": now(),
                    "text": text,
                    "raw": str(data.get("raw_message") or "")[:4000],
                    "status": "pending",
                }
                with open(pending, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                log(f"收到反馈 {rec['report_id']} 来自 {rec['nickname']}({rec['user_id']}): {text[:60]!r}", logfile)
                if cfg["auto_ack"]:
                    try:
                        await bot.api("send_group_msg", {
                            "group_id": gid,
                            "message": f"[CQ:reply,id={mid}]{cfg['ack_text']}",
                        })
                    except Exception as e:
                        log(f"自动回执失败: {e!r}", logfile)

            pump_task = asyncio.create_task(bot.pump(on_event))
            gid_holder["gid"] = await resolve_group(bot, cfg, logfile)
            log(f"监听中: 群 {gid_holder['gid']}，触发前缀 {prefixes}，收件箱 {pending}", logfile)
            backoff = 5
            await pump_task
            log("连接被服务端关闭", logfile)
        except Exception as e:
            log(f"连接失败/断开: {e!r}", logfile)
        await bot.close()
        log(f"{backoff}s 后重连…", logfile)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60)


async def oneshot_list(cfg: dict):
    bot, task = await open_bot(cfg)
    try:
        groups = await bot.api("get_group_list") or []
        for g in groups:
            print(f"{g.get('group_id')}\t{g.get('group_name')}")
    finally:
        task.cancel()
        await bot.close()


async def oneshot_send(cfg: dict, text: str, reply_mid: str | None):
    bot, task = await open_bot(cfg)
    try:
        gid = await resolve_group(bot, cfg)
        msg = (f"[CQ:reply,id={reply_mid}]" if reply_mid else "") + text
        await bot.api("send_group_msg", {"group_id": gid, "message": msg})
        print("已发送")
    finally:
        task.cancel()
        await bot.close()


def main():
    ap = argparse.ArgumentParser(
        description="QQ 群修改器反馈监听器 (NapCat/OneBot11)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--list-groups", action="store_true", help="列出 bot 所在的群")
    ap.add_argument("--send", metavar="文本", help="向目标群发一条消息")
    ap.add_argument("--reply", nargs=2, metavar=("消息ID", "文本"), help="引用回复某条反馈")
    args = ap.parse_args()
    cfg = load_config()
    if args.list_groups:
        asyncio.run(oneshot_list(cfg))
    elif args.send:
        asyncio.run(oneshot_send(cfg, args.send, None))
    elif args.reply:
        asyncio.run(oneshot_send(cfg, args.reply[1], args.reply[0]))
    else:
        try:
            asyncio.run(listen(cfg))
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
