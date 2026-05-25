from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml


def _persona_path() -> Path:
    return Path(os.environ.get("FA_PERSONA_PATH", "./persona.yaml")).resolve()


@lru_cache(maxsize=1)
def load_persona_text() -> str:
    p = _persona_path()
    if not p.exists():
        example = p.parent / "persona.example.yaml"
        if example.exists():
            return example.read_text(encoding="utf-8")
        raise FileNotFoundError(
            f"No persona at {p} and no persona.example.yaml fallback. "
            "Copy persona.example.yaml -> persona.yaml and edit."
        )
    return p.read_text(encoding="utf-8")


def reload_persona() -> str:
    load_persona_text.cache_clear()
    return load_persona_text()


def merge_overrides(base_yaml: str, overrides: dict | None) -> str:
    if not overrides:
        return base_yaml
    base = yaml.safe_load(base_yaml) or {}
    base.update(overrides)
    return yaml.safe_dump(base, sort_keys=False, allow_unicode=True)
