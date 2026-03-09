from __future__ import annotations

import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUNDLE_DIR = ROOT / "src-tauri" / "target" / "release" / "bundle"
PLATFORM = sys.argv[1] if len(sys.argv) > 1 else "unknown"
OUT = ROOT / f"SHA256SUMS-{PLATFORM}.txt"

ALLOWED = {
    ".dmg",
    ".msi",
    ".exe",
    ".AppImage",
    ".deb",
    ".rpm",
    ".gz",
}

files: list[pathlib.Path] = []
for path in BUNDLE_DIR.rglob("*"):
    if not path.is_file():
        continue
    suffixes = "".join(path.suffixes[-2:]) if len(path.suffixes) >= 2 else path.suffix
    if not path.name.startswith(("Ryvion.Operator", "Ryvion Operator")):
        continue
    if path.suffix in ALLOWED or suffixes == ".tar.gz":
        files.append(path)

if not files:
    raise SystemExit(f"no bundle artifacts found under {BUNDLE_DIR}")

lines = []
for path in sorted(files):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    lines.append(f"{digest}  {path.name}")

OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"wrote {OUT}")
