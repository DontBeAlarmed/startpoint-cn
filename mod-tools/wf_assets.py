#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
角色资产(立绘/图标/语音)读写。

逆向依据(fileFaker.converter.*,2026-07-06):
  * PNG:仅魔数混淆。存储态 `89 70 6E 67`("png"小写) ↔ 标准 `89 50 4E 47`("PNG")。
  * MP3:逐帧把帧头首字节 0xFF(sync 2047>>>3) ↔ 0x7F(1023>>>3),其余字节不动;
    ID3v2 头按 unsynchsafe 跳过,ID3v1 'TAG' 跳 128 字节。CBR Layer3 only。
  * 存储根:upload(通用) / medium_upload(大图:立绘/cut-in) / android_upload(平台)。
    文件名 = sha1(逻辑路径+盐),三根同规则。发布通道:common/medium/android 三套 diff 目录。
  * 立绘 = character/<code>/ui/full_shot_1440_1920_{0,1}.png(0=基础,1=进化/觉醒),
    逻辑设计尺寸 1440x1920,实际 PNG 尺寸可不同(配 CharacterImage 表的 pivot/scale)。
"""
from __future__ import annotations

import csv
import json
import os
import struct
from pathlib import Path

import wf_mod_tool as core

HERE = Path(__file__).resolve().parent
# 全角色语音 datamine(537 角色,ally/battle/home 三分类 + voiceLines.json 台词文本)。
# 实测游戏路径 = character/<code>/voice/<分类>/<名>.mp3,与 dump 一一对应(fire_dragon 18/18)。
VOICE_DUMP = Path(os.environ.get("WF_VOICE_DUMP", r"D:\WF\角色语音"))

PNG_REAL = bytes([137, 80, 78, 71, 13, 10, 26, 10])
PNG_FAKE = bytes([137, 112, 110, 103, 13, 10, 26, 10])

# MP3 帧参数表(MP3Converter.as 原样)
_BITRATE_V1 = [0, 32000, 40000, 48000, 56000, 64000, 80000, 96000, 122000,
               128000, 160000, 192000, 224000, 256000, 320000]
_BITRATE_V2 = [0, 8000, 16000, 24000, 32000, 40000, 48000, 56000, 64000,
               80000, 96000, 112000, 128000, 144000, 160000]
_SRATE_V1 = [44100, 48000, 32000]
_SRATE_V2 = [22050, 24000, 16000]
_SRATE_V25 = [11025, 12000, 8000]


# ---------------------------------------------------------------- PNG

def png_decode(data: bytes) -> bytes:
    if data[:8] == PNG_FAKE:
        return PNG_REAL + data[8:]
    return data


def png_encode(data: bytes) -> bytes:
    if data[:8] == PNG_REAL:
        return PNG_FAKE + data[8:]
    raise ValueError("不是标准 PNG 文件(魔数不对)")


def png_dims(data: bytes) -> tuple[int, int] | None:
    if data[1:4] not in (b"PNG", b"png") or len(data) < 24:
        return None
    return struct.unpack(">II", data[16:24])


# ---------------------------------------------------------------- MP3

def _mp3_convert(data: bytes, from_sig: int, to_sig: int) -> bytes:
    """逐帧改写帧头首字节(from_sig>>>3 → to_sig>>>3)。容错:遇到无法解析处停止改写。"""
    buf = bytearray(data)
    pos = 0
    n = len(buf)
    from_b = (from_sig >> 3) & 0xFF
    to_b = (to_sig >> 3) & 0xFF
    while pos + 4 <= n:
        b0 = buf[pos]
        if b0 == 0x49:  # 'I' → ID3v2
            if buf[pos:pos + 3] != b"ID3":
                break
            size = 0
            raw = int.from_bytes(buf[pos + 6:pos + 10], "big")
            mask = 0x7F000000
            while mask:
                size >>= 1
                size |= raw & mask
                mask >>= 8
            pos += size + 10
            continue
        if b0 == 0x54:  # 'T' → ID3v1 'TAG'
            if buf[pos:pos + 3] != b"TAG":
                break
            pos += 128
            continue
        if b0 == from_b and (buf[pos + 1] >> 5 & 7) == (from_sig & 7):
            header = int.from_bytes(buf[pos:pos + 4], "big")
            version = header >> 19 & 3
            layer = header >> 17 & 3
            br_idx = header >> 12 & 0x0F
            sr_idx = header >> 10 & 3
            padding = header >> 9 & 1
            if version == 1 or layer != 1 or br_idx in (0, 15) or sr_idx == 3:
                break
            bitrate = (_BITRATE_V1 if version == 3 else _BITRATE_V2)[br_idx]
            srate = (_SRATE_V1 if version == 3 else _SRATE_V2 if version == 2 else _SRATE_V25)[sr_idx]
            buf[pos] = to_b
            frame = int(144 * bitrate / srate + padding + 2e-10)
            pos += frame
            continue
        break
    return bytes(buf)


def mp3_decode(data: bytes) -> bytes:
    """存储态(0x7F 帧头) → 标准 MP3。"""
    return _mp3_convert(data, 1023, 2047)


def mp3_probe(data: bytes, sig: int) -> dict:
    """逐帧探测(只读):{frames, bitrates, srates, end(帧流覆盖末位), tail(其后字节数)}。
    与 _mp3_convert 同一走帧逻辑,用于量化"转换到底覆盖了多少"。"""
    pos, n = 0, len(data)
    sig_b = (sig >> 3) & 0xFF
    frames = 0
    bitrates: set[int] = set()
    srates: set[int] = set()
    while pos + 4 <= n:
        b0 = data[pos]
        if b0 == 0x49:
            if data[pos:pos + 3] != b"ID3":
                break
            raw = int.from_bytes(data[pos + 6:pos + 10], "big")
            size = 0
            mask = 0x7F000000
            while mask:
                size >>= 1
                size |= raw & mask
                mask >>= 8
            pos += size + 10
            continue
        if b0 == 0x54:
            if data[pos:pos + 3] != b"TAG":
                break
            pos += 128
            continue
        if b0 == sig_b and (data[pos + 1] >> 5 & 7) == (sig & 7):
            header = int.from_bytes(data[pos:pos + 4], "big")
            version = header >> 19 & 3
            layer = header >> 17 & 3
            br_idx = header >> 12 & 0x0F
            sr_idx = header >> 10 & 3
            padding = header >> 9 & 1
            if version == 1 or layer != 1 or br_idx in (0, 15) or sr_idx == 3:
                break
            bitrate = (_BITRATE_V1 if version == 3 else _BITRATE_V2)[br_idx]
            srate = (_SRATE_V1 if version == 3 else _SRATE_V2 if version == 2 else _SRATE_V25)[sr_idx]
            frames += 1
            bitrates.add(bitrate)
            srates.add(srate)
            pos += int(144 * bitrate / srate + padding + 2e-10)
            continue
        break
    return {"frames": frames, "bitrates": bitrates, "srates": srates,
            "end": pos, "tail": n - pos}


def mp3_encode(data: bytes) -> bytes:
    """标准 MP3 → 存储态。严格校验(2026-07-12 起):
    _mp3_convert 遇到解析不了的地方会静默停止,产出"前半存储态/后半标准态"的
    半转换文件——客户端播到断点即崩溃或截断。这里转换后逐帧复核:
    覆盖必须到文件尾(允许 ≤512B 的 TAG/静默填充,且其中不得残留标准帧同步字);
    帧码率必须恒定(游戏不支持 VBR;官方语音 400 抽样实测全部 CBR)。"""
    if not (data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] >> 5 & 7) == 7)):
        raise ValueError("不是标准 MP3 文件(需 CBR·MPEG Layer3;先用 ffmpeg 转码: "
                         "ffmpeg -i in.xxx -c:a libmp3lame -b:a 96k -write_xing 0 out.mp3)")
    out = _mp3_convert(data, 2047, 1023)
    p = mp3_probe(out, 1023)
    if p["frames"] == 0:
        raise ValueError("MP3 里找不到任何有效音频帧(文件损坏或非 MPEG Layer3)")
    if p["tail"]:
        rest = out[p["end"]:]
        has_sync = any(rest[i] == 0xFF and i + 1 < len(rest) and rest[i + 1] >> 5 & 7 == 7
                       for i in range(len(rest) - 1))
        if has_sync or p["tail"] > 512:
            raise ValueError(
                f"MP3 转换不完整:{p['tail']} 字节未被识别"
                f"({'其中含未转换的音频帧,' if has_sync else ''}疑似 VBR/损坏/含杂质),"
                f"写入游戏会崩溃或截断,已拒绝。请用 ffmpeg 重转:"
                f"ffmpeg -i in.mp3 -c:a libmp3lame -b:a 96k -write_xing 0 out.mp3")
    if len(p["bitrates"]) > 1:
        rates = sorted(b // 1000 for b in p["bitrates"])
        raise ValueError(f"VBR 检测:帧码率不恒定 {rates} kbps,"
                         "游戏只支持 CBR。请用 ffmpeg 转 CBR(加 -write_xing 0)")
    return out


# ---------------------------------------------------------------- 资产定位(三根)

def roots(target_store: Path) -> dict[str, Path]:
    base = target_store.parent
    return {"upload": target_store,
            "medium": base / "medium_upload",
            "android": base / "android_upload"}


def locate(target_store: Path, logical: str) -> tuple[str, Path] | None:
    d = core.sha1_path(logical)
    for name, root in roots(target_store).items():
        p = root / d[:2] / d[2:]
        if p.exists():
            return name, p
    return None


def path_in_root(target_store: Path, root_name: str, logical: str) -> Path:
    d = core.sha1_path(logical)
    return roots(target_store)[root_name] / d[:2] / d[2:]


# ---------------------------------------------------------------- 角色资产清单

# (子路径模板, 分类, 说明/格式要求)
_CHAR_TEMPLATES = [
    ("ui/full_shot_1440_1920_0.png", "立绘", "基础立绘。PNG,设计画布 1440x1920(实际可裁边,建议与原图同尺寸,居中构图)"),
    ("ui/full_shot_1440_1920_1.png", "立绘", "进化/觉醒立绘。PNG,设计画布 1440x1920(同上)"),
    ("ui/skill_cutin_0.png", "技能cut-in", "技能演出横图。PNG 1024x512(战斗真机只读配对 ATF,替换时自动重编码)"),
    ("ui/skill_cutin_1.png", "技能cut-in", "进化后技能演出横图。PNG 1024x512(同上,ATF 自动重编码)"),
    ("ui/illustration_setting_sprite_sheet.png", "图标合集", "头像/队伍小图 sprite sheet(配 .atlas 切割,替换须保持同尺寸同布局)"),
    ("pixelart/sprite_sheet.png", "像素图", "战斗像素动画 sprite sheet(配 atlas/timeline,同尺寸同布局)"),
    ("pixelart/special_sprite_sheet.png", "像素图", "技能特殊动作 sprite sheet(同上)"),
    # 2026-07-06 补全:store 实测均为独立文件(medium 根),非图集切片
    ("ui/square_0.png", "头像", "方形头像(基础)。PNG,与原图同尺寸"),
    ("ui/square_1.png", "头像", "方形头像(进化)。PNG,同上"),
    ("ui/square_132_132_0.png", "头像", "132x132 方形头像(基础)"),
    ("ui/square_132_132_1.png", "头像", "132x132 方形头像(进化)"),
    ("ui/square_round_95_95_0.png", "头像", "95x95 圆角头像(基础)"),
    ("ui/square_round_95_95_1.png", "头像", "95x95 圆角头像(进化)"),
    ("ui/square_round_136_136_0.png", "头像", "136x136 圆角头像(基础)"),
    ("ui/square_round_136_136_1.png", "头像", "136x136 圆角头像(进化)"),
    ("ui/thumb_level_up_0.png", "缩略图", "升级/强化界面缩略图(基础)"),
    ("ui/thumb_level_up_1.png", "缩略图", "升级/强化界面缩略图(进化)"),
    ("ui/thumb_party_main_0.png", "缩略图", "编队主位缩略图(基础)"),
    ("ui/thumb_party_main_1.png", "缩略图", "编队主位缩略图(进化)"),
    ("ui/thumb_party_unison_0.png", "缩略图", "编队副位缩略图(基础)"),
    ("ui/thumb_party_unison_1.png", "缩略图", "编队副位缩略图(进化)"),
    ("ui/battle_control_board_0.png", "战斗UI", "战斗下方技能条立绘(基础)"),
    ("ui/battle_control_board_1.png", "战斗UI", "战斗下方技能条立绘(进化)"),
    ("ui/battle_member_status_0.png", "战斗UI", "战斗队员状态小头像(基础)"),
    ("ui/battle_member_status_1.png", "战斗UI", "战斗队员状态小头像(进化)"),
    ("ui/cutin_skill_chain_0.png", "连锁cut-in", "技能连锁 cut-in 头像(基础)"),
    ("ui/cutin_skill_chain_1.png", "连锁cut-in", "技能连锁 cut-in 头像(进化)"),
    ("ui/episode_banner_0.png", "剧情横幅", "角色剧情列表横幅(基础)"),
    ("ui/episode_banner_1.png", "剧情横幅", "角色剧情列表横幅(进化)"),
]

# 配套二进制数据(切割坐标/动画帧/时间轴):不可预览,只支持整文件替换(慎改)
_COMPANION_TEMPLATES = [
    ("ui/illustration_setting_sprite_sheet.atlas.amf3.deflate", "图标合集的切割坐标"),
    ("pixelart/sprite_sheet.atlas.amf3.deflate", "像素图切割坐标"),
    ("pixelart/special_sprite_sheet.atlas.amf3.deflate", "特殊动作切割坐标"),
    ("pixelart/pixelart.frame.amf3.deflate", "像素动画帧定义"),
    ("pixelart/pixelart.timeline.amf3.deflate", "像素动画时间轴"),
    ("pixelart/special.frame.amf3.deflate", "特殊动作帧定义"),
    ("pixelart/special.timeline.amf3.deflate", "特殊动作时间轴"),
    ("ui/skill_cutin_0.atf.deflate", "技能cut-in 的 ATF(ETC1)纹理——战斗真机实际读取的文件;替换 PNG 时 wf_atf 自动重生成"),
    ("ui/skill_cutin_1.atf.deflate", "同上(进化)"),
    ("battle/character_detail_skill_preview.battle.amf3.deflate", "角色详情页技能预览战斗数据"),
]

# 固定名语音(全角色同名,来自 dump 全量 + 路径清单交叉验证):直接探测 store,不依赖采集
_VOICE_FIXED = (
    "ally/evolution.mp3", "ally/join.mp3",
    "battle/battle_start_0.mp3", "battle/battle_start_1.mp3",
    "battle/normal_attack_0.mp3", "battle/normal_attack_1.mp3",
    "battle/outhole_0.mp3", "battle/outhole_1.mp3",
    "battle/power_flip_0.mp3", "battle/power_flip_1.mp3",
    "battle/skill_0.mp3", "battle/skill_1.mp3",
    "battle/skill_2.mp3", "battle/skill_3.mp3", "battle/skill_ready.mp3",
    "battle/win_0.mp3", "battle/win_1.mp3",
    "login/login_0.mp3", "login/login_1.mp3", "login/login_2.mp3",
)
_VOICE_CATS = ("ally", "battle", "home", "login")


def dump_voices(code_name: str) -> list[tuple[str, str, str]]:
    """语音 dump 目录 → [(分类, 文件名, 台词文本)]。目录不存在返回空。"""
    d = VOICE_DUMP / code_name
    if not d.exists():
        return []
    lines: dict = {}
    try:
        lines = json.loads((d / "voiceLines.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    out = []
    for cat in _VOICE_CATS:
        cd = d / cat
        if cd.exists():
            for f in sorted(os.listdir(cd)):
                if f.endswith(".mp3"):
                    out.append((cat, f, str(lines.get(f"{cat}/{f[:-4]}", "")).strip()))
    return out

_pathlist_cache: dict[str, list[str]] | None = None


def _pathlist_char_index() -> dict[str, list[str]]:
    """WF_PATHLIST_recovered.txt(约 10 万条,复原率约 75%)里 character/<code>/* 的路径,
    按 code_name 归组。用于枚举名字因角色而异的资产(ui/story 表情差分、voice/words 剧情语音)。
    清单是部分复原:缺的路径不代表 store 里没有,固定名资产仍以模板探测为准。"""
    global _pathlist_cache
    if _pathlist_cache is not None:
        return _pathlist_cache
    idx: dict[str, list[str]] = {}
    try:
        with (HERE / "WF_PATHLIST_recovered.txt").open(encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line.startswith("character/"):
                    continue
                parts = line.split("/", 2)
                if len(parts) == 3:
                    idx.setdefault(parts[1], []).append(line)
    except Exception:
        pass
    _pathlist_cache = idx
    return idx


_voice_vocab_cache: list[str] | None = None


def _voice_vocab() -> list[str]:
    """语音文件名词表 = dump 全部角色 <分类>/<文件名> 的并集(2400+ 条,含 home 变名)。
    某角色不在 dump 里(新角色/未解包)时,用词表对 store 逐条探测兜底——
    home 语音多为角色专属罗马音名,命中率低但探测便宜(sha1+stat),不漏才是重点。"""
    global _voice_vocab_cache
    if _voice_vocab_cache is not None:
        return _voice_vocab_cache
    vocab: set[str] = set(_VOICE_FIXED)
    try:
        for char_dir in VOICE_DUMP.iterdir():
            for cat in _VOICE_CATS:
                cd = char_dir / cat
                if cd.is_dir():
                    for f in os.listdir(cd):
                        if f.endswith(".mp3"):
                            vocab.add(f"{cat}/{f}")
    except Exception:
        pass
    _voice_vocab_cache = sorted(vocab)
    return _voice_vocab_cache


_harvest_voice_cache: dict[str, list[str]] | None = None


def _harvest_voice_index() -> dict[str, list[str]]:
    """HarvestedPaths.csv 里捕获过的 character/*/voice/* 路径,按 code_name 归组。"""
    global _harvest_voice_cache
    if _harvest_voice_cache is not None:
        return _harvest_voice_cache
    idx: dict[str, list[str]] = {}
    try:
        with (HERE / "HarvestedPaths.csv").open(encoding="utf-8", errors="replace") as f:
            for row in csv.reader(f):
                if not row or "/voice/" not in row[0] or not row[0].startswith("character/"):
                    continue
                parts = row[0].split("/")
                idx.setdefault(parts[1], []).append(row[0])
    except Exception:
        pass
    _harvest_voice_cache = idx
    return idx


def char_asset_manifest(target_store: Path, code_name: str) -> list[dict]:
    """角色的可预览/可替换资产清单(探测三根,含尺寸/格式要求/台词文本)。"""
    out = []
    seen = set()

    def add(logical: str, kind: str, req: str, text: str = ""):
        if logical in seen:
            return
        seen.add(logical)
        loc = locate(target_store, logical)
        item = {"logical": logical, "kind": kind, "req": req, "text": text,
                "exists": bool(loc), "root": loc[0] if loc else "",
                "size": loc[1].stat().st_size if loc else 0, "dims": None}
        if loc and logical.endswith(".png"):
            item["dims"] = png_dims(loc[1].read_bytes()[:64])
        out.append(item)

    for sub, kind, req in _CHAR_TEMPLATES:
        add(f"character/{code_name}/{sub}", kind, req)
    # 语音四路合并(store 探测过滤,只列真实存在的):
    #   ① datamine dump 清单(带台词文本) ② 固定名+词表全量探测(dump 缺角色/缺分类的兜底)
    #   ③ 运行时采集 ④ 路径清单(words/words_*/login 等变名分类,75% 复原)
    dumped = dump_voices(code_name)
    voice_req = "MP3(CBR,Layer3;VBR 不支持),建议与原文件同码率"
    for cat, f, textline in dumped:
        lg = f"character/{code_name}/voice/{cat}/{f}"
        if locate(target_store, lg):
            add(lg, f"语音·{cat}", voice_req, textline)
    for sub in _voice_vocab():
        lg = f"character/{code_name}/voice/{sub}"
        if locate(target_store, lg):
            add(lg, "语音·" + sub.split("/", 1)[0], voice_req)
    for lg in _harvest_voice_index().get(code_name, []):
        add(lg, "语音", voice_req)
    # 变名资产(剧情表情/剧情语音):路径清单枚举 + store 探测(只列真实存在的)
    for lg in _pathlist_char_index().get(code_name, []):
        if "/ui/story/" in lg and lg.endswith(".png"):
            if locate(target_store, lg):
                add(lg, "剧情表情", "剧情对话表情差分。PNG,与原图同尺寸")
        elif "/voice/" in lg and lg.endswith(".mp3"):
            cat = lg.split("/voice/", 1)[1].split("/", 1)[0]
            if locate(target_store, lg):
                add(lg, "语音·" + cat,
                    voice_req + ("(剧情台词语音)" if cat.startswith("words") else ""))
    for sub, desc in _COMPANION_TEMPLATES:
        add(f"character/{code_name}/{sub}", "配套数据",
            desc + "(AMF3 二进制,不可预览;仅支持整文件替换,改错会崩,慎动)")
    return out


def all_asset_logicals(target_store: Path, code_name: str) -> list[str]:
    """该角色现存的全部资产逻辑路径(清单里 exists 的项),供快照/克隆复制。"""
    return [a["logical"] for a in char_asset_manifest(target_store, code_name) if a["exists"]]
