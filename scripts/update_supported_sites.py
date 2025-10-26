#!/usr/bin/env python3
"""Regenerate data/yt_dlp_supported_hosts.json from yt-dlp extractors."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Set

from yt_dlp.extractor import gen_extractors

DOMAIN_PATTERN = re.compile(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}', re.IGNORECASE)


def extract_domains(pattern: str | Iterable[str] | None) -> Set[str]:
    if not pattern:
        return set()
    if isinstance(pattern, (list, tuple, set)):
        domains: Set[str] = set()
        for entry in pattern:
            domains.update(extract_domains(entry))
        return domains
    simplified = pattern.replace(r"\.", ".")
    # Replace character classes with a dot so the regex can discover hostnames spanning them
    simplified = re.sub(r"\[[^\]]+\]", ".", simplified)
    candidates = set(DOMAIN_PATTERN.findall(simplified))
    results: Set[str] = set()
    for candidate in candidates:
        normalized = candidate.lower().strip('.')
        if not normalized:
            continue
        results.add(normalized)
        if normalized.startswith("www."):
            results.add(normalized[4:])
    return results


def build_host_data() -> dict:
    hostnames: Set[str] = set()
    tokens: Set[str] = set()
    for extractor in gen_extractors():
        try:
            key = extractor.ie_key()
        except Exception:  # pragma: no cover - safeguard
            continue
        if key:
            tokens.add(key.lower())
        hostnames.update(extract_domains(getattr(extractor, "_VALID_URL", "")))
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "hostnames": sorted(hostnames),
        "tokens": sorted(tokens),
    }
    return payload


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    output_path = project_root / "data" / "yt_dlp_supported_hosts.json"
    payload = build_host_data()
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Updated {output_path.relative_to(project_root)} with {len(payload['hostnames'])} hostnames and {len(payload['tokens'])} tokens.")


if __name__ == "__main__":
    main()
