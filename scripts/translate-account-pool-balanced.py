#!/usr/bin/env python3
"""Translate reviewed Russian UI text in the vendored OXI plugin.

This changes display strings only; account routing and quota policy are untouched.
Unmatched Russian text remains as-is for follow-up localization.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "plugins" / "account-pool-balanced"
MAPPING = json.loads((Path(__file__).parent / "account-pool-balanced-en.json").read_text())
if not ROOT.exists():
    raise SystemExit(f"Missing vendored source: {ROOT}")

changed_total = 0
remaining = {}
for path in sorted(ROOT.glob("*.tsx")):
    if path.name.endswith(".test.tsx"):
        continue  # Preserve upstream tests; localize UI files only.
    source = path.read_text()
    changed = 0
    for ru, en in sorted(MAPPING.items(), key=lambda pair: len(pair[0]), reverse=True):
        # Avoid replacing part of a Russian word (e.g. Аккаунт in Аккаунтов).
        pattern = re.compile(r"(?<![А-Яа-яЁё])" + re.escape(ru) + r"(?![А-Яа-яЁё])")
        source, count = pattern.subn(lambda _: en, source)
        changed += count
    if changed:
        path.write_text(source)
    remaining[str(path.relative_to(ROOT))] = sum(bool(re.search(r"[А-Яа-яЁё]", line)) for line in source.splitlines())
    changed_total += changed
    print(f"{path.name}: {changed} replacements, {remaining[str(path.relative_to(ROOT))]} lines still containing Cyrillic")

locale = ROOT / "locales"
locale.mkdir(exist_ok=True)
(locale / "ru-original.json").write_text(
    json.dumps({en: ru for ru, en in MAPPING.items()}, ensure_ascii=False, indent=2) + "\n"
)
(locale / "translation-coverage.json").write_text(
    json.dumps({"translated_occurrences": changed_total, "remaining_cyrillic_lines": remaining}, indent=2) + "\n"
)
