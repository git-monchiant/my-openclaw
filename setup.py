from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from setuptools import setup


REPO_ROOT = Path(__file__).parent.resolve()


def _data_file_tree(root_name: str) -> list[tuple[str, list[str]]]:
    # Bundled data trees live under data/, but install targets keep their
    # original (un-prefixed) relative paths so consumers see skills/...
    root = REPO_ROOT / "data" / root_name
    grouped: defaultdict[str, list[str]] = defaultdict(list)
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel_path = path.relative_to(REPO_ROOT / "data")
        grouped[str(rel_path.parent)].append(str(path.relative_to(REPO_ROOT)))
    return sorted(grouped.items())


setup(
    data_files=[
        *_data_file_tree("skills"),
        *_data_file_tree("optional-skills"),
    ]
)
