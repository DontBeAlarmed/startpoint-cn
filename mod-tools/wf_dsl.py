#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
技能 ActionDsl 数值编辑器。

文件:`<program_path>.action.dsl.amf3.deflate`(program_path 含 $,原样进 sha1),
raw-deflate(wbits=-15)压缩的 AMF3 序列化命令树(ActionDsl→Block→Command→...)。

编辑策略(2026-07-06 逆向落地):
  * 只改数值,不动结构 → 不需要完整 AMF3 写入器。
  * AMF3 U29 整数允许非规范前导 0x80 字节(读取算法 value=(value<<7)|(b&0x7f)),
    因此可以把新值**补位到与原编码等长**原地覆写;double 定长 8 字节直接覆写。
  * 新值最短编码超过原有字节数 → 拒绝(提示换模板/用整技能替换)。
解析器输出每个数值叶子的 (offset, len, value, 语境路径),语境 = 最近的字符串标签
(命令名/字段名),供人看懂"这是哪个效果的哪个数"。
"""
from __future__ import annotations

import zlib
from pathlib import Path

import wf_mod_tool as core

# 常见 DSL 命令/字段的中文标注(逐步补充;未知的显示原名)
DSL_CN = {
    "CreateHitArea": "攻击判定", "Rectangle": "矩形范围", "Circle": "圆形范围",
    "StopBall": "停球", "Stop": "停止", "CreateReferencePoint": "参考点",
    "EnemyDamage": "对敌伤害", "Damage": "伤害", "Heal": "治疗",
    "Condition": "状态效果", "GiveCondition": "赋予状态", "min": "最小", "max": "最大",
    "Single": "单段", "Multiple": "多段", "frame": "帧", "Wait": "等待(帧)",
    "MoveBall": "移动球", "Shot": "发射", "SpecialAttack": "特攻",
}


def dsl_logical(program_path: str) -> str:
    return f"{program_path}.action.dsl.amf3.deflate"


def _read_u29(b: bytes, i: int) -> tuple[int, int]:
    """返回 (值, 新偏移)。"""
    v = 0
    for n in range(3):
        c = b[i]
        i += 1
        if c & 0x80:
            v = (v << 7) | (c & 0x7F)
        else:
            return (v << 7) | c, i
    return (v << 8) | b[i], i + 1


def encode_u29_padded(v: int, length: int) -> bytes:
    """把 v 编码成恰好 length 字节的 U29(用非规范前导 0x80 补位)。放不下抛错。"""
    if not (0 <= v < (1 << 29)):
        raise ValueError("数值超出 AMF3 U29 范围(0~536870911)")
    if length == 4:
        if v >= (1 << 29):
            raise ValueError("放不下")
        b3 = v & 0xFF
        rest = v >> 8
        out = [((rest >> 14) & 0x7F) | 0x80, ((rest >> 7) & 0x7F) | 0x80,
               (rest & 0x7F) | 0x80, b3]
        return bytes(out)
    # 1-3 字节:7 位/字节
    if v >= (1 << (7 * length)):
        raise ValueError(f"数值 {v} 需要更多字节(原字段只有 {length} 字节)")
    out = []
    for k in range(length - 1, -1, -1):
        part = (v >> (7 * k)) & 0x7F
        out.append(part | (0x80 if k else 0))
    return bytes(out)


class _Parser:
    """AMF3 子集解析(带引用表),记录 int/double 叶子的偏移与语境。"""

    def __init__(self, data: bytes):
        self.b = data
        self.i = 0
        self.strings: list[str] = []
        self.traits: list[tuple[str, list[str], bool]] = []
        self.numbers: list[dict] = []   # {offset,len,value,type,ctx}
        self.ctx: list[str] = []

    def _label(self) -> str:
        return ".".join(self.ctx[-4:])

    def read_string(self) -> str:
        ref, self.i = _read_u29(self.b, self.i)
        if not (ref & 1):
            return self.strings[ref >> 1]
        ln = ref >> 1
        s = self.b[self.i:self.i + ln].decode("utf-8", errors="replace")
        self.i += ln
        if s:
            self.strings.append(s)
        return s

    def read_value(self):
        m = self.b[self.i]
        self.i += 1
        if m in (0x00, 0x01, 0x02, 0x03):     # undefined/null/false/true
            return {0x00: None, 0x01: None, 0x02: False, 0x03: True}[m]
        if m == 0x04:                          # int
            off = self.i
            v, self.i = _read_u29(self.b, self.i)
            if v & 0x10000000:                 # 29 位符号
                v -= 0x20000000
            self.numbers.append({"offset": off, "len": self.i - off, "value": v,
                                 "type": "int", "ctx": self._label()})
            return v
        if m == 0x05:                          # double
            off = self.i
            import struct
            v = struct.unpack(">d", self.b[self.i:self.i + 8])[0]
            self.i += 8
            self.numbers.append({"offset": off, "len": 8, "value": v,
                                 "type": "double", "ctx": self._label()})
            return v
        if m == 0x06:                          # string
            s = self.read_string()
            return s
        if m == 0x09:                          # array
            ref, self.i = _read_u29(self.b, self.i)
            if not (ref & 1):
                return f"<arrRef {ref >> 1}>"
            count = ref >> 1
            out = {}
            while True:                        # 关联部分
                k = self.read_string()
                if k == "":
                    break
                self.ctx.append(k)
                out[k] = self.read_value()
                self.ctx.pop()
            # DSL 惯例:['命令名'/标签串, 参数...] → 首元素若为字符串,作为其余元素的语境
            dense = []
            pushed = False
            for idx in range(count):
                v = self.read_value()
                if idx == 0 and isinstance(v, str) and v:
                    self.ctx.append(v)
                    pushed = True
                dense.append(v)
            if pushed:
                self.ctx.pop()
            return {"assoc": out, "dense": dense} if out else dense
        if m == 0x0A:                          # object
            ref, self.i = _read_u29(self.b, self.i)
            if not (ref & 1):
                return f"<objRef {ref >> 1}>"
            if not (ref & 2):                  # traits 引用
                cls, sealed, dyn = self.traits[ref >> 2]
            else:
                if ref & 4:
                    raise ValueError("不支持 externalizable 对象")
                dyn = bool(ref & 8)
                n_sealed = ref >> 4
                cls = self.read_string()
                sealed = [self.read_string() for _ in range(n_sealed)]
                self.traits.append((cls, sealed, dyn))
            obj = {}
            if cls:
                self.ctx.append(cls)
            for name in sealed:
                self.ctx.append(name)
                obj[name] = self.read_value()
                self.ctx.pop()
            if dyn:
                while True:
                    k = self.read_string()
                    if k == "":
                        break
                    self.ctx.append(k)
                    obj[k] = self.read_value()
                    self.ctx.pop()
            if cls:
                self.ctx.pop()
            return obj
        raise ValueError(f"未支持的 AMF3 标记 0x{m:02x} @ {self.i - 1}")


def _walk_label_arrays(v, parser):
    """DSL 数组首元素常是命令名字符串:回填语境(解析时无法前瞻,后处理不做,保留 ctx 近似)。"""
    return v


def parse_dsl(data: bytes) -> dict:
    """解压后的 AMF3 字节 → {tree, numbers[]}。"""
    p = _Parser(data)
    tree = p.read_value()
    return {"tree": tree, "numbers": p.numbers}


def load_dsl_file(target_store: Path, program_path: str) -> tuple[Path, bytes]:
    lg = dsl_logical(program_path)
    d = core.sha1_path(lg)
    fp = target_store / d[:2] / d[2:]
    if not fp.exists():
        raise ValueError(f"DSL 文件不存在: {lg}")
    return fp, zlib.decompress(fp.read_bytes(), -15)


def cn_ctx(ctx: str) -> str:
    return ".".join(DSL_CN.get(t, t) for t in ctx.split(".") if t)


def patch_numbers(data: bytes, edits: list[dict]) -> tuple[bytes, list[str]]:
    """edits: [{offset, len, type, value}] → 原地补丁。返回 (新字节, 日志)。"""
    import struct
    buf = bytearray(data)
    log = []
    for e in sorted(edits, key=lambda x: int(x["offset"])):
        off, ln, typ = int(e["offset"]), int(e["len"]), str(e["type"])
        if typ == "double":
            old = struct.unpack(">d", bytes(buf[off:off + 8]))[0]
            buf[off:off + 8] = struct.pack(">d", float(e["value"]))
            log.append(f"@{off} double {old:g} -> {float(e['value']):g}")
        else:
            v = int(e["value"])
            if v < 0:
                v += 0x20000000  # 29 位补码
            enc = encode_u29_padded(v, ln)
            old, _ = _read_u29(bytes(buf), off)
            buf[off:off + ln] = enc
            log.append(f"@{off} int {old} -> {int(e['value'])}")
    return bytes(buf), log


def save_dsl_file(fp: Path, data: bytes, backup_suffix: str) -> None:
    if fp.exists():
        bak = fp.with_name(fp.name + backup_suffix)
        if not bak.exists():
            import shutil
            shutil.copy2(fp, bak)
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    fp.write_bytes(co.compress(data) + co.flush())


if __name__ == "__main__":
    import io, sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    prof = core.resolve_profile()
    fp, data = load_dsl_file(prof.store, "battle/action/skill/action/rare5/fire_dragon$fire_dragon_1")
    r = parse_dsl(data)
    print("数值叶子:", len(r["numbers"]))
    for n in r["numbers"][:20]:
        print(f"  @{n['offset']:>5} {n['type']:6s} {n['value']:>12} ctx={cn_ctx(n['ctx'])}")
    # 往返:解析后不改,原字节不变(解析只读) + 补丁自测:把第一个 int 改成自己
    n0 = next(x for x in r["numbers"] if x["type"] == "int")
    patched, lg = patch_numbers(data, [{**n0}])
    print("等值补丁后一致:", patched == data or "长度不同" , lg)
