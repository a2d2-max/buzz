#!/usr/bin/env python3
"""Verify A2D2 provider patches and exact post-apply source deltas."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

KIT_ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = KIT_ROOT / "sources.lock.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_git(checkout: Path, *args: str) -> bytes:
    return subprocess.check_output(
        ["git", "-C", os.fspath(checkout), *args], stderr=subprocess.STDOUT
    )


def changed_paths(checkout: Path) -> list[str]:
    raw = run_git(
        checkout, "status", "--porcelain=v1", "-z", "--untracked-files=all"
    )
    entries = raw.split(b"\0")
    result: list[str] = []
    index = 0
    while index < len(entries) - 1:
        entry = entries[index]
        index += 1
        if not entry:
            continue
        status_code = entry[:2].decode("ascii")
        path = entry[3:].decode("utf-8", "surrogateescape")
        if status_code[0] in {"R", "C"}:
            path = entries[index].decode("utf-8", "surrogateescape")
            index += 1
        result.append(path)
    return sorted(result)


def verify_patches(lock: dict[str, object]) -> None:
    forbidden = [
        re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
        re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{24,}\b"),
        re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    ]
    for name in ("plane", "affine"):
        provider = lock["providers"][name]
        patch = KIT_ROOT / provider["patch"]
        if sha256(patch) != provider["patch_sha256"]:
            raise ValueError(f"{name} patch SHA-256 does not match sources.lock.json")
    for path in KIT_ROOT.rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        payload = path.read_bytes()
        if any(pattern.search(payload) for pattern in forbidden):
            raise ValueError(
                f"kit file contains a forbidden credential pattern: {path.relative_to(KIT_ROOT)}"
            )


def verify_checkout(name: str, checkout: Path, provider: dict[str, object]) -> None:
    if not checkout.is_dir():
        raise ValueError(f"{name} checkout does not exist: {checkout}")
    head = run_git(checkout, "rev-parse", "HEAD").decode().strip()
    if head != provider["upstream_commit"]:
        raise ValueError(f"{name} HEAD {head} is not the locked upstream commit")

    expected_files = provider["files"]
    expected_paths = sorted(item["path"] for item in expected_files)
    actual_paths = changed_paths(checkout)
    if actual_paths != expected_paths:
        missing = sorted(set(expected_paths) - set(actual_paths))
        extra = sorted(set(actual_paths) - set(expected_paths))
        raise ValueError(
            f"{name} changed-file set mismatch; missing={missing!r} extra={extra!r}"
        )

    actual_records: list[dict[str, object]] = []
    for expected in expected_files:
        path = checkout / expected["path"]
        if not path.is_file():
            raise ValueError(f"{name} expected source file is absent: {expected['path']}")
        record = {
            "bytes": path.stat().st_size,
            "mode": stat.S_IMODE(path.stat().st_mode),
            "path": expected["path"],
            "sha256": sha256(path),
        }
        if record != expected:
            raise ValueError(f"{name} source record mismatch: {expected['path']}")
        actual_records.append(record)

    canonical = json.dumps(
        actual_records, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    digest = hashlib.sha256(canonical).hexdigest()
    if digest != provider["source_delta_sha256"]:
        raise ValueError(f"{name} aggregate source delta digest mismatch")

    reverse = subprocess.run(
        ["git", "-C", os.fspath(checkout), "apply", "--check", "--reverse", os.fspath(KIT_ROOT / provider["patch"])],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if reverse.returncode != 0:
        raise ValueError(f"{name} checkout is not the exact applied patch")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--patches-only", action="store_true")
    parser.add_argument("--plane-checkout", type=Path)
    parser.add_argument("--affine-checkout", type=Path)
    parser.add_argument("--provider", choices=("plane", "affine"))
    parser.add_argument("--checkout", type=Path)
    parser.add_argument("--print-delta-sha", choices=("plane", "affine"))
    args = parser.parse_args()

    lock = json.loads(LOCK_PATH.read_text())
    verify_patches(lock)
    if args.print_delta_sha:
        print(lock["providers"][args.print_delta_sha]["source_delta_sha256"])
        return 0
    if args.patches_only:
        print("provider_patch_integrity=PASS")
        return 0
    if args.provider or args.checkout:
        if not args.provider or not args.checkout:
            parser.error("--provider and --checkout must be supplied together")
        verify_checkout(args.provider, args.checkout, lock["providers"][args.provider])
        print(f"provider_source_verification=PASS provider={args.provider}")
        return 0
    if not args.plane_checkout or not args.affine_checkout:
        parser.error("both --plane-checkout and --affine-checkout are required")
    verify_checkout("plane", args.plane_checkout, lock["providers"]["plane"])
    verify_checkout("affine", args.affine_checkout, lock["providers"]["affine"])
    print("provider_source_verification=PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.CalledProcessError, ValueError, json.JSONDecodeError) as error:
        print(f"provider_source_verification=FAIL: {error}", file=sys.stderr)
        raise SystemExit(1) from error
