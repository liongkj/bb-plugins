#!/usr/bin/env python3
"""Apply reviewed English UI strings to the vendored OXI plugin.

Untranslated Russian strings remain unchanged, to avoid corrupting template
expressions or changing quota/routing logic. Original text is kept in
locales/ru-original.json for future i18n work.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "plugins" / "account-pool-balanced"
MAPPING = json.loads((Path(__file__).parent / "account-pool-balanced-en.json").read_text())
TARGETS = [ROOT / "app.tsx"]
for path in TARGETS:
    if not path.exists():
        raise SystemExit(f"Missing vendored source: {path}")
    source = path.read_text()
    changed = 0
    for ru, en in sorted(MAPPING.items(), key=lambda pair: len(pair[0]), reverse=True):
        # Only replace exact string bodies, avoiding accidental identifier edits.
        for quote in ('"', "'", "`"):
            before = quote + ru + quote
            after = quote + en + quote
            n = source.count(before)
            source = source.replace(before, after)
            changed += n
    path.write_text(source)
    print(f"{path}: translated {changed} exact string occurrences")
locale = ROOT / "locales"
locale.mkdir(exist_ok=True)
(locale / "ru-original.json").write_text(json.dumps({en: ru for ru, en in MAPPING.items()}, ensure_ascii=False, indent=2) + "\n")
