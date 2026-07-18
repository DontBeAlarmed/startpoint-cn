#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重锚防孤儿硬门禁:被 active.json 丢弃的 charpkg 历史必须仍可达 tail。

2026-07-18 事故:链重锚把 active.json 的 base_version 从 1.4.133 抬到 1.4.164,
133→162 段的 charpkg 边全部从 release graph 消失(服务端按文件名隐藏 -charpkg-
zip,charpkg 边只来自 active.json),停在中间版本的真实客户端被告知"已最新",
永远收不到更新。修复手段是给被丢弃的边建 -charbridge- 命名的硬链接副本,使其
作为普通 legacy 边重新可见。本模块把这一步变成发布路径上的硬门禁:发布前若有
孤儿 charpkg 历史无法回到 tail,自动补 charbridge 副本;补完仍不可达则拒绝发布。
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Iterator

import wf_release


FULL_BASE_VERSION = "1.4.0"
CHARPKG_MARK = "-charpkg-"
CHARBRIDGE_MARK = "-charbridge-"


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def _archive_edge(name: str) -> tuple[str, str] | None:
    match = wf_release.LEGACY_ARCHIVE_RE.fullmatch(name)
    if match is None:
        return None
    return match.group(1), match.group(2)


def _iter_archive_files(directory: Path) -> Iterator[Path]:
    try:
        entries = sorted(directory.iterdir())
    except FileNotFoundError:
        return
    for path in entries:
        if path.is_file():
            yield path


def _active_chain_edges(cdn_root: Path) -> set[tuple[str, str]]:
    """宽松读 active.json 链上的边;损坏/缺失时视为空链,全部盘上历史都算孤儿。"""
    active_path = Path(cdn_root) / "character-releases" / "active.json"
    try:
        payload = json.loads(active_path.read_bytes())
    except (OSError, ValueError):
        return set()
    releases = payload.get("releases") if isinstance(payload, dict) else None
    edges: set[tuple[str, str]] = set()
    for release in releases if isinstance(releases, list) else ():
        if not isinstance(release, dict):
            continue
        source = release.get("from_version")
        target = release.get("version")
        if isinstance(source, str) and isinstance(target, str) \
                and wf_release.VERSION_RE.fullmatch(source) \
                and wf_release.VERSION_RE.fullmatch(target):
            edges.add((source, target))
    return edges


def _visible_edges(
    cdn_root: Path,
    repo_root: Path,
    chain_edges: set[tuple[str, str]],
) -> tuple[set[tuple[str, str]], set[tuple[str, str, str]]]:
    """客户端可见的更新边:非 charpkg 三根归档 + asset-patch active + active 链。

    返回 (合并边集, 按根目录归属的边集);后者用于检测某条边只在部分根可见的缺口。
    """
    merged: set[tuple[str, str]] = set(chain_edges)
    by_root: set[tuple[str, str, str]] = set()
    for root_dir in wf_release.ROOT_DIRS.values():
        for path in _iter_archive_files(Path(cdn_root) / root_dir):
            if CHARPKG_MARK in path.name:
                continue
            edge = _archive_edge(path.name)
            if edge is not None:
                merged.add(edge)
                by_root.add((root_dir, *edge))
    patch_dir = Path(repo_root) / "assets" / "asset-patch" / "active"
    for path in _iter_archive_files(patch_dir):
        if CHARPKG_MARK in path.name:
            continue
        edge = _archive_edge(path.name)
        if edge is not None:
            merged.add(edge)
    return merged, by_root


def _orphan_charpkg_archives(
    cdn_root: Path,
    chain_edges: set[tuple[str, str]],
) -> list[tuple[Path, str, tuple[str, str]]]:
    orphans: list[tuple[Path, str, tuple[str, str]]] = []
    for root_dir in wf_release.ROOT_DIRS.values():
        for path in _iter_archive_files(Path(cdn_root) / root_dir):
            if CHARPKG_MARK not in path.name:
                continue
            edge = _archive_edge(path.name)
            if edge is not None and edge not in chain_edges:
                orphans.append((path, root_dir, edge))
    return orphans


def _graph_tail(edges: set[tuple[str, str]], full_base: str = FULL_BASE_VERSION) -> str:
    forward: dict[str, set[str]] = {}
    for source, target in edges:
        forward.setdefault(source, set()).add(target)
    best = full_base
    visited = {full_base}
    pending = [full_base]
    while pending:
        current = pending.pop()
        if _version_key(current) > _version_key(best):
            best = current
        for target in forward.get(current, ()):
            if target not in visited:
                visited.add(target)
                pending.append(target)
    return best


def _versions_reaching(edges: set[tuple[str, str]], target: str) -> set[str]:
    reverse: dict[str, set[str]] = {}
    for source, edge_target in edges:
        reverse.setdefault(edge_target, set()).add(source)
    visited = {target}
    pending = [target]
    while pending:
        current = pending.pop()
        for source in reverse.get(current, ()):
            if source not in visited:
                visited.add(source)
                pending.append(source)
    return visited


def charpkg_strand_report(cdn_root: Path, repo_root: Path) -> dict:
    """孤儿 charpkg 历史的可达性报告(只读)。

    一条孤儿归档被判定为搁浅(stranded),当且仅当:
    - 它的任一端点无法沿可见边走到 tail(停在该版本的客户端会被告知"已最新");或
    - 该边在合并图里可见,但所在根目录没有可见副本(其它根已桥接/有 legacy 重切,
      这个根的客户端会缺这段资源)。
    """
    cdn_root = Path(cdn_root)
    repo_root = Path(repo_root)
    chain_edges = _active_chain_edges(cdn_root)
    merged, by_root = _visible_edges(cdn_root, repo_root, chain_edges)
    orphans = _orphan_charpkg_archives(cdn_root, chain_edges)
    tail = _graph_tail(merged)
    reaching = _versions_reaching(merged, tail)
    stranded: list[Path] = []
    stranded_edges: set[str] = set()
    for path, root_dir, (source, target) in orphans:
        endpoints_ok = source in reaching and target in reaching
        root_covered = (root_dir, source, target) in by_root
        if not endpoints_ok or ((source, target) in merged and not root_covered):
            stranded.append(path)
            stranded_edges.add(f"{source}->{target}")
    return {
        "tail": tail,
        "orphan_edges": sorted({f"{s}->{t}" for _p, _r, (s, t) in orphans}),
        "stranded_edges": sorted(stranded_edges),
        "stranded_archives": sorted(str(path) for path in stranded),
    }


def ensure_charpkg_history_bridged(cdn_root: Path, repo_root: Path) -> dict:
    """重锚硬门禁:搁浅的孤儿 charpkg 归档自动补 charbridge 副本,补不齐则拒绝。

    charbridge 副本优先硬链接(零空间成本),文件系统不支持时退化为普通复制。
    幂等:已存在的副本不会重建。
    """
    report = charpkg_strand_report(cdn_root, repo_root)
    if not report["stranded_archives"]:
        report["bridged_archives"] = []
        return report
    bridged: list[str] = []
    for raw in report["stranded_archives"]:
        source = Path(raw)
        target = source.with_name(source.name.replace(CHARPKG_MARK, CHARBRIDGE_MARK, 1))
        if target.exists():
            continue
        try:
            os.link(source, target)
        except OSError:
            shutil.copy2(source, target)
        bridged.append(str(target))
    report = charpkg_strand_report(cdn_root, repo_root)
    report["bridged_archives"] = bridged
    if report["stranded_archives"]:
        raise wf_release.ReleaseError(
            "charpkg history is stranded even after charbridge copies: "
            + ", ".join(report["stranded_edges"])
            + f" cannot reach tail {report['tail']}"
        )
    return report
