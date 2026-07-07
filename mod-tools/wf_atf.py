#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wf_atf — skill_cutin 的 ATF(ETC1)纹理重编码器(纯标准库)。

背景(FileReader.as 逆向):`/ui/skill_cutin_` 是全客户端唯一的「平台相关」资产,
真机(assetReadKind≠0/3)渲染只读 `skill_cutin_N.atf.deflate`(android 根),
不读同名 PNG(medium 根,仅编辑器/特定模式用)。因此替换 cut-in 必须连 ATF
一起重生成,否则游戏内无变化——立绘等其他资产没有 ATF 配对,换 PNG 即生效。

原始 ATF 实测(alice, 1024x512):
  头 16B: 'ATF' 00 00 01 FF 03 | u32(总长-12) | format(0x05) log2w log2h mip数
  format 0x05 = RAW Compressed With Alpha,全 mip 链(11 级);
  每级 4 个平台槽 [DXT5, PVRTC, ETC1, ETC2](u32 长度前缀),仅 ETC1 槽有数据,
  内容 = [颜色纹理][alpha 纹理] 两段 ETC1 直拼(8B/4x4 块,alpha 以灰度编码)。

编码器:individual 模式(RGB444 基色)+ 8 张修正表全搜(亮度残差)+ flip 启发式
+ 块级缓存(实测官方图 50-75% 块重复)。质量弱于官方 png2atf(无差分模式/穷举),
但块内误差 ≤ 修正表步长,肉眼接近;alpha 掩码几乎无损。

用法:
  python wf_atf.py --selftest
  python wf_atf.py --regen character/alice/ui/skill_cutin_0.png   # 从 store 现有 PNG 重生成(备份+进 pending)
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
ATF_HEAD8 = b"ATF\x00\x00\x01\xff\x03"  # 新版头 + ATF v3(与官方 cutin 文件逐字节一致)
# ETC1 修正表(Khronos OES_compressed_ETC1_RGB8):每表 (小步长 a, 大步长 b),
# 像素 2bit 索引 (msb,lsb): 00=+a 01=+b 10=-a 11=-b
_MODS = ((2, 8), (5, 17), (9, 29), (13, 42), (18, 60), (24, 80), (33, 106), (47, 183))
_SUB_FLIP0 = (tuple(range(8)), tuple(range(8, 16)))              # 两个 2x4 竖条(i = x*4+y)
_SUB_FLIP1 = (tuple(i for i in range(16) if i % 4 < 2),          # 两个 4x2 横条
              tuple(i for i in range(16) if i % 4 >= 2))


def inflate(data: bytes) -> bytes:
    return zlib.decompress(data, -15)


def deflate(data: bytes) -> bytes:
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    return co.compress(data) + co.flush()


# ---------------------------------------------------------------- PNG 解码/编码

def png_decode_rgba(data: bytes) -> tuple[int, int, bytearray]:
    """标准 PNG → (w, h, RGBA bytearray)。仅 8-bit 非隔行(常规导出即满足)。"""
    if data[:8] != PNG_MAGIC:
        raise ValueError("不是标准 PNG(魔数不对)")
    pos = 8
    w = h = bitd = ct = interlace = None
    idat = bytearray()
    plte = b""
    trns = b""
    while pos + 8 <= len(data):
        ln, typ = struct.unpack(">I4s", data[pos:pos + 8])
        pos += 8
        chunk = data[pos:pos + ln]
        pos += ln + 4  # 跳过 CRC
        if typ == b"IHDR":
            w, h, bitd, ct, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
        elif typ == b"PLTE":
            plte = chunk
        elif typ == b"tRNS":
            trns = chunk
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
    if w is None:
        raise ValueError("PNG 缺 IHDR")
    if bitd != 8:
        raise ValueError(f"仅支持 8-bit PNG(实际 {bitd}-bit),请用普通方式重新导出")
    if interlace:
        raise ValueError("不支持隔行扫描(interlaced)PNG,请重新导出")
    nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(ct)
    if nch is None:
        raise ValueError(f"不支持的 PNG 颜色类型 {ct}")
    raw = zlib.decompress(bytes(idat))
    stride = w * nch
    if len(raw) < (stride + 1) * h:
        raise ValueError("PNG 像素数据不完整")
    out = bytearray(w * h * nch)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b = prev[i]
                c = prev[i - nch] if i >= nch else 0
                pa = abs(b - c)
                pb = abs(a - c)
                pc = abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        elif f != 0:
            raise ValueError(f"未知 PNG filter {f}")
        out[y * stride:(y + 1) * stride] = line
        prev = line
    rgba = bytearray(w * h * 4)
    if ct == 6:
        rgba[:] = out
    elif ct == 2:
        for i in range(w * h):
            rgba[4 * i:4 * i + 3] = out[3 * i:3 * i + 3]
            rgba[4 * i + 3] = 255
    elif ct == 0:
        for i in range(w * h):
            g = out[i]
            rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = g
            rgba[4 * i + 3] = 255
    elif ct == 4:
        for i in range(w * h):
            g = out[2 * i]
            rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = g
            rgba[4 * i + 3] = out[2 * i + 1]
    else:  # ct == 3 调色板
        if not plte:
            raise ValueError("调色板 PNG 缺 PLTE")
        for i in range(w * h):
            j = out[i] * 3
            rgba[4 * i:4 * i + 3] = plte[j:j + 3]
            rgba[4 * i + 3] = trns[out[i]] if out[i] < len(trns) else 255
    return w, h, rgba


def png_encode_rgba(w: int, h: int, rgba: bytes) -> bytes:
    """RGBA → 标准 PNG(filter 0,测试/预览用)。"""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(typ: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + typ + body + struct.pack(
            ">I", zlib.crc32(typ + body) & 0xFFFFFFFF)

    return (PNG_MAGIC + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


# ---------------------------------------------------------------- mip 链

def half_rgba(rgba: bytearray, w: int, h: int) -> tuple[int, int, bytearray]:
    """2x2 均值降采样(边长 1 时该轴保持)。"""
    nw, nh = max(w // 2, 1), max(h // 2, 1)
    out = bytearray(nw * nh * 4)
    for y in range(nh):
        y0 = min(2 * y, h - 1) * w
        y1 = min(2 * y + 1, h - 1) * w
        ro = y * nw * 4
        for x in range(nw):
            x0 = min(2 * x, w - 1)
            x1 = min(2 * x + 1, w - 1)
            for c in range(4):
                out[ro + x * 4 + c] = (rgba[(y0 + x0) * 4 + c] + rgba[(y0 + x1) * 4 + c]
                                       + rgba[(y1 + x0) * 4 + c] + rgba[(y1 + x1) * 4 + c]) >> 2
    return nw, nh, out


# ---------------------------------------------------------------- ETC1 编码

def _enc_sub(px: list, idxs: tuple) -> tuple:
    """单子块:均值基色(RGB444)+ 8 修正表全搜亮度残差。返回 (r4,g4,b4,表号,2bit索引列表)。"""
    n = len(idxs)
    sr = sg = sb = 0
    for i in idxs:
        p = px[i]
        sr += p[0]
        sg += p[1]
        sb += p[2]
    r4 = (sr * 15 + n * 127) // (n * 255)
    g4 = (sg * 15 + n * 127) // (n * 255)
    b4 = (sb * 15 + n * 127) // (n * 255)
    base = (r4 + g4 + b4) * 17  # 亮度和(重建值 = c4*17)
    d = [px[i][0] + px[i][1] + px[i][2] - base for i in idxs]  # 3x 亮度残差
    best_err = 1 << 30
    best_k = 0
    best_cl = None
    for k in range(8):
        a, b = _MODS[k]
        a3, b3 = a * 3, b * 3
        err = 0
        cl = []
        for dv in d:
            e0 = dv - a3
            if e0 < 0:
                e0 = -e0
            e1 = dv - b3
            if e1 < 0:
                e1 = -e1
            e2 = dv + a3
            if e2 < 0:
                e2 = -e2
            e3 = dv + b3
            if e3 < 0:
                e3 = -e3
            if e0 <= e1 and e0 <= e2 and e0 <= e3:
                cl.append(0)
                err += e0
            elif e1 <= e2 and e1 <= e3:
                cl.append(1)
                err += e1
            elif e2 <= e3:
                cl.append(2)
                err += e2
            else:
                cl.append(3)
                err += e3
        if err < best_err:
            best_err, best_k, best_cl = err, k, cl
            if err == 0:
                break
    return r4, g4, b4, best_k, best_cl


def _encode_block(px: list) -> bytes:
    """一个 4x4 块(px[i], i = x*4+y)→ 8 字节 ETC1(individual 模式)。"""
    lum = [p[0] + p[1] + p[2] for p in px]
    c0 = abs(sum(lum[i] for i in _SUB_FLIP0[0]) - sum(lum[i] for i in _SUB_FLIP0[1]))
    c1 = abs(sum(lum[i] for i in _SUB_FLIP1[0]) - sum(lum[i] for i in _SUB_FLIP1[1]))
    flip = 0 if c0 >= c1 else 1
    subs = _SUB_FLIP0 if flip == 0 else _SUB_FLIP1
    r1, g1, b1, k1, cl1 = _enc_sub(px, subs[0])
    r2, g2, b2, k2, cl2 = _enc_sub(px, subs[1])
    msb = lsb = 0
    for idxs, cl in ((subs[0], cl1), (subs[1], cl2)):
        for i, c in zip(idxs, cl):
            msb |= ((c >> 1) & 1) << i
            lsb |= (c & 1) << i
    return bytes(((r1 << 4) | r2, (g1 << 4) | g2, (b1 << 4) | b2,
                  (k1 << 5) | (k2 << 2) | flip,
                  (msb >> 8) & 255, msb & 255, (lsb >> 8) & 255, lsb & 255))


def encode_etc1(rgba: bytearray, w: int, h: int, channel: str = "rgb") -> bytes:
    """整张纹理 → ETC1 字节。channel='rgb' 颜色纹理;'alpha' 用 A 通道灰度。"""
    nbx = max((w + 3) // 4, 1)
    nby = max((h + 3) // 4, 1)
    out = bytearray()
    cache: dict[bytes, bytes] = {}
    alpha = channel == "alpha"
    for by in range(nby):
        for bx in range(nbx):
            px = []
            for x in range(4):
                cx = min(bx * 4 + x, w - 1)
                for y in range(4):
                    cy = min(by * 4 + y, h - 1)
                    o = (cy * w + cx) * 4
                    if alpha:
                        a = rgba[o + 3]
                        px.append((a, a, a))
                    else:
                        px.append((rgba[o], rgba[o + 1], rgba[o + 2]))
            key = bytes(v for p in px for v in p)
            blk = cache.get(key)
            if blk is None:
                blk = _encode_block(px)
                cache[key] = blk
            out += blk
    return bytes(out)


# ---------------------------------------------------------------- ETC1 解码(验证用)

def decode_etc1(data: bytes, w: int, h: int) -> bytearray:
    """ETC1 → RGB bytearray(w*h*3)。用于自检与对拍官方文件。"""
    out = bytearray(w * h * 3)
    nbx = max((w + 3) // 4, 1)
    bi = 0
    for off in range(0, len(data), 8):
        b = data[off:off + 8]
        bx, by = bi % nbx, bi // nbx
        bi += 1
        flip = b[3] & 1
        k1, k2 = b[3] >> 5, (b[3] >> 2) & 7
        if (b[3] >> 1) & 1:  # differential 模式(官方文件可能用;自产不用)
            r1 = b[0] >> 3
            g1 = b[1] >> 3
            b1 = b[2] >> 3
            dr = (b[0] & 7) - ((b[0] & 4) << 1)
            dg = (b[1] & 7) - ((b[1] & 4) << 1)
            db = (b[2] & 7) - ((b[2] & 4) << 1)
            base1 = ((r1 << 3) | (r1 >> 2), (g1 << 3) | (g1 >> 2), (b1 << 3) | (b1 >> 2))
            r2, g2, b2 = r1 + dr, g1 + dg, b1 + db
            base2 = ((r2 << 3) | (r2 >> 2), (g2 << 3) | (g2 >> 2), (b2 << 3) | (b2 >> 2))
        else:
            base1 = ((b[0] >> 4) * 17, (b[1] >> 4) * 17, (b[2] >> 4) * 17)
            base2 = ((b[0] & 15) * 17, (b[1] & 15) * 17, (b[2] & 15) * 17)
        msb = (b[4] << 8) | b[5]
        lsb = (b[6] << 8) | b[7]
        subs = _SUB_FLIP0 if flip == 0 else _SUB_FLIP1
        for si, idxs in enumerate(subs):
            base = base1 if si == 0 else base2
            a, bb = _MODS[k1 if si == 0 else k2]
            for i in idxs:
                c = (((msb >> i) & 1) << 1) | ((lsb >> i) & 1)
                m = (a, bb, -a, -bb)[c]
                x, y = bx * 4 + i // 4, by * 4 + i % 4
                if x >= w or y >= h:
                    continue
                o = (y * w + x) * 3
                for ch in range(3):
                    v = base[ch] + m
                    out[o + ch] = 0 if v < 0 else (255 if v > 255 else v)
    return out


# ---------------------------------------------------------------- ATF 容器

def parse_atf(data: bytes) -> dict:
    """解析 cutin 型 ATF:{w, h, mips, pairs: [每级 ETC1 颜色+alpha 直拼字节]}。"""
    if data[:3] != b"ATF" or len(data) < 16 or data[6] != 0xFF:
        raise ValueError("不是新版头 ATF 文件")
    fmt = data[12]
    if fmt & 0x7F != 0x05:
        raise ValueError(f"ATF format=0x{fmt:02x},仅支持 0x05 RAW Compressed With Alpha")
    w, h, mips = 1 << data[13], 1 << data[14], data[15]
    o = 16
    pairs = []
    for _ in range(mips):
        row = []
        for _s in range(4):
            ln = int.from_bytes(data[o:o + 4], "big")
            row.append(data[o + 4:o + 4 + ln])
            o += 4 + ln
        if row[0] or row[1] or row[3]:
            raise ValueError("非 ETC1-only 布局(DXT/PVRTC/ETC2 槽有数据),不认识的变体")
        pairs.append(row[2])
    return {"w": w, "h": h, "mips": mips, "pairs": pairs}


def build_cutin_atf(png_data: bytes, ref_atf: bytes | None = None,
                    progress=None) -> bytes:
    """标准 PNG → cutin 型 ATF(RAW Compressed With Alpha,ETC1 颜色+alpha,全 mip 链)。

    ref_atf 提供时校验尺寸一致并沿用其 mip 数;否则按尺寸生成完整 mip 链。"""
    w, h, rgba = png_decode_rgba(png_data)
    if w & (w - 1) or h & (h - 1):
        raise ValueError(f"ATF 要求边长为 2 的幂,PNG 是 {w}x{h}")
    mips = max(w.bit_length(), h.bit_length())
    if ref_atf is not None:
        ref = parse_atf(ref_atf)
        if (ref["w"], ref["h"]) != (w, h):
            raise ValueError(f"PNG 尺寸 {w}x{h} 与原 ATF {ref['w']}x{ref['h']} 不一致"
                             f"(cut-in 必须同尺寸替换)")
        mips = ref["mips"]
    body = bytearray()
    cw, ch, cur = w, h, rgba
    zero4 = (0).to_bytes(4, "big")
    for lv in range(mips):
        if progress:
            progress(f"ETC1 编码 mip{lv} {cw}x{ch}")
        pair = encode_etc1(cur, cw, ch, "rgb") + encode_etc1(cur, cw, ch, "alpha")
        body += zero4 + zero4 + len(pair).to_bytes(4, "big") + pair + zero4
        if lv < mips - 1:
            cw, ch, cur = half_rgba(cur, cw, ch)
    return (ATF_HEAD8 + (4 + len(body)).to_bytes(4, "big")
            + bytes((0x05, w.bit_length() - 1, h.bit_length() - 1, mips)) + bytes(body))


# ---------------------------------------------------------------- CLI

def _regen(png_logical: str) -> None:
    """从 store 现有 PNG 重生成配对 ATF(备份 + 进 pending + 改动日志)。"""
    import time
    import shutil
    import wf_mod_tool as core
    import wf_assets
    import wf_gui  # add_pending / record_change(读 profiles 决定 store)

    store = core.default_target_store()
    ploc = wf_assets.locate(store, png_logical)
    aloc = wf_assets.locate(store, png_logical[:-4] + ".atf.deflate")
    if not ploc or not aloc:
        raise SystemExit(f"store 里找不到 {png_logical} 或其 .atf.deflate 配对")
    png_raw = wf_assets.png_decode(ploc[1].read_bytes())
    ref = inflate(aloc[1].read_bytes())
    print(f"源 PNG [{ploc[0]}] {len(png_raw)}B;原 ATF [{aloc[0]}] {len(ref)}B")
    atf = build_cutin_atf(png_raw, ref, progress=lambda s: print("  " + s))
    enc = deflate(atf)
    afp = aloc[1]
    bak = afp.with_name(afp.name + ".bak-wfmod-asset-" + time.strftime("%Y%m%d-%H%M%S"))
    if not bak.exists():
        shutil.copy2(afp, bak)
    afp.write_bytes(enc)
    wf_gui.add_pending(afp)
    summary = (f"{png_logical[:-4]}.atf.deflate: ETC1 重编码 {len(ref)}B→{len(atf)}B "
               f"[{aloc[0]}](CLI 重生成,战斗实际读取的纹理)")
    wf_gui.record_change(png_logical[:-4] + ".atf.deflate", summary, bak)
    print(summary)
    print("已写入 + 备份 + 加入 pending;发布后生效")


def _selftest() -> None:
    w, h = 64, 32
    rgba = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            o = (y * w + x) * 4
            rgba[o] = x * 255 // (w - 1)
            rgba[o + 1] = y * 255 // (h - 1)
            rgba[o + 2] = (x + y) * 255 // (w + h - 2)
            rgba[o + 3] = 255 if x < w // 2 else (w - 1 - x) * 255 // (w // 2)
    png = png_encode_rgba(w, h, bytes(rgba))
    w2, h2, back = png_decode_rgba(png)
    assert (w2, h2) == (w, h) and back == rgba, "PNG 编解码往返失败"
    atf = build_cutin_atf(png)
    p = parse_atf(atf)
    assert (p["w"], p["h"]) == (w, h) and p["mips"] == max(w.bit_length(), h.bit_length())
    half = len(p["pairs"][0]) // 2
    rgb = decode_etc1(p["pairs"][0][:half], w, h)
    alp = decode_etc1(p["pairs"][0][half:], w, h)
    ec = sum(abs(rgb[i * 3 + c] - rgba[i * 4 + c]) for i in range(w * h) for c in range(3)) / (w * h * 3)
    ea = sum(abs(alp[i * 3] - rgba[i * 4 + 3]) for i in range(w * h)) / (w * h)
    print(f"selftest: 颜色平均误差 {ec:.2f},alpha 平均误差 {ea:.2f}(阈值 12)")
    assert ec < 12 and ea < 12, "ETC1 编码质量异常"
    print("selftest OK")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--regen", metavar="PNG_LOGICAL",
                    help="如 character/alice/ui/skill_cutin_0.png:从 store PNG 重生成 ATF")
    args = ap.parse_args()
    if args.selftest:
        _selftest()
    elif args.regen:
        _regen(args.regen)
    else:
        ap.print_help()
