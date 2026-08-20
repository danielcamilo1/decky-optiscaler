#!/usr/bin/env python3
"""Generate option metadata for every OptiScaler.ini key.

OptiScaler ships a self-documenting INI: each key is preceded by comment lines
describing it, where the LAST comment line is a type spec such as
``true or false - Default (auto) is false`` or
``nofg, dlssg, nukems, fsrfg, upscaler, fsrfg30 - Default (auto) is nofg``.

This script turns that into structured metadata consumed by both the Python
backend and the TypeScript frontend, so we never hand-maintain 288 options.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REFERENCE_INI = ROOT / "defaults" / "OptiScaler.reference.ini"

# Keys whose value is a virtual key code rather than a plain number.
KEYCODE_KEYS = {"ShortcutKey", "FpsShortcutKey", "FpsCycleShortcutKey", "FGShortcutKey"}

DEFAULT_RE = re.compile(r"-?\s*Default\s*(?:\(auto\))?\s*is\s*(.+)$", re.IGNORECASE)
RANGE_RE = re.compile(
    r"^\s*(-?\d+(?:\.\d+)?)\s*(?:to|-|–)\s*(-?\d+(?:\.\d+)?)\s*$", re.IGNORECASE
)
FROM_RANGE_RE = re.compile(
    r"^\s*From\s+(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?)\s*$", re.IGNORECASE
)
BETWEEN_RE = re.compile(
    r"value range between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)", re.IGNORECASE
)
# "0 = Trace / 1 = Debug"  or  "0 = FSR 4.0.2 | 1 = FSR 3.1.5"
NUM_CHOICE_RE = re.compile(r"(-?\d+)\s*=\s*([^/|]+?)(?=\s*(?:[/|]|$))")
ENUM_TOKEN_RE = re.compile(r"^[A-Za-z0-9_.]+$")


def split_spec(line):
    """Split a spec comment into (value-part, default-part)."""
    m = DEFAULT_RE.search(line)
    if not m:
        return line.strip(), None
    return line[: m.start()].rstrip(" -\t"), m.group(1).strip().rstrip(".")


def strip_parens(text):
    """Remove parenthetical asides: 'fsr22 (native DX11)' -> 'fsr22'."""
    out, depth = [], 0
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(ch)
    return "".join(out)


def split_top_level(text):
    """Split on commas that are not inside parentheses."""
    parts, depth, current = [], 0, []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def parse_enum(value_part):
    """Parse 'a (note), b, c' into (tokens, {token: label})."""
    pieces = split_top_level(value_part)
    if len(pieces) < 2:
        return None
    tokens, labels = [], {}
    for piece in pieces:
        m = re.match(r"^([A-Za-z0-9_.]+)\s*(?:\((.+)\))?$", piece)
        if not m:
            return None
        token, note = m.group(1), m.group(2)
        if token in tokens:
            return None
        tokens.append(token)
        if note:
            labels[token] = f"{token} — {note.strip()}"
    if not all(ENUM_TOKEN_RE.match(t) for t in tokens):
        return None
    return tokens, labels


def normalize_default(text):
    """'0 = Trace' -> '0';  '0 - FSR4 for RDNA4...' -> '0'."""
    if not text:
        return "auto"
    t = text.strip()
    m = re.match(r"^(-?\d+(?:\.\d+)?)\s*[-=]", t)
    if m:
        return m.group(1)
    m = re.match(r"^(-?\d+(?:\.\d+)?)$", t)
    if m:
        return m.group(1)
    first = t.split()[0].strip(".,")
    if re.fullmatch(r"-?\d+(?:\.\d+)?", first):
        return first
    if first.lower() in ("true", "false", "auto", "disabled"):
        return first.lower()
    return t


def find_numeric_choices(comments):
    """Find a '0 = A / 1 = B' style enumeration in any comment line."""
    for line in comments:
        if "=" not in line:
            continue
        pairs = NUM_CHOICE_RE.findall(line)
        if len(pairs) >= 2:
            opts = [p[0] for p in pairs]
            labels = {p[0]: p[1].strip().rstrip(".,") for p in pairs}
            if len(set(opts)) == len(opts):
                return opts, labels
    return None


def infer(key, comments):
    """Infer {type, options, min, max, default} for a key from its comments."""
    spec = comments[-1] if comments else ""
    value_part, default_part = split_spec(spec)
    low = value_part.lower().strip()

    info = {"default": normalize_default(default_part)}

    if key in KEYCODE_KEYS:
        info["type"] = "keycode"
        return info, comments[:-1] if default_part or low else comments

    choices = find_numeric_choices(comments)

    if low.startswith("true or false") and not (
        choices and info["default"] not in ("true", "false", "auto")
    ):
        info["type"] = "bool"
        return info, comments[:-1]

    # Numeric choice lists such as LogLevel / UpscalerIndex live in an earlier
    # comment line, so scan the whole block before falling through.
    if choices:
        opts, labels = choices
        info["type"] = "enum"
        info["options"] = opts
        info["optionLabels"] = labels
        keep = [c for c in comments if not NUM_CHOICE_RE.search(c) or len(NUM_CHOICE_RE.findall(c)) < 2]
        if default_part and keep and keep[-1] is spec:
            keep = keep[:-1]
        return info, keep

    enum = parse_enum(value_part)
    if enum:
        tokens, labels = enum
        info["type"] = "enum"
        info["options"] = tokens
        if labels:
            info["optionLabels"] = labels
        return info, comments[:-1]

    m = BETWEEN_RE.search(spec)
    if m:
        lo, hi = m.group(1), m.group(2)
        info["type"] = "float" if ("." in lo or "." in hi) else "int"
        info["min"] = float(lo) if info["type"] == "float" else int(lo)
        info["max"] = float(hi) if info["type"] == "float" else int(hi)
        return info, comments[:-1]

    m = RANGE_RE.match(low) or FROM_RANGE_RE.match(value_part)
    if m:
        lo, hi = m.group(1), m.group(2)
        is_float = "." in lo or "." in hi
        info["type"] = "float" if is_float else "int"
        info["min"] = float(lo) if is_float else int(lo)
        info["max"] = float(hi) if is_float else int(hi)
        return info, comments[:-1]

    if "max float" in low or low.startswith("float") or low.startswith("0.0 to infinite"):
        info["type"] = "float"
        m2 = re.match(r"^(-?\d+(?:\.\d+)?)\s+to\s+max float", low)
        if m2:
            info["min"] = float(m2.group(1))
        return info, comments[:-1]

    if low.startswith("uint") or "integer value" in low or low.startswith("int"):
        info["type"] = "int"
        if "> 0" in low or "above" in low:
            info["min"] = 1
        elif low.startswith("uint"):
            info["min"] = 0
        return info, comments[:-1]

    # A bare "Default (auto) is false" with no value spec is still a boolean.
    if info["default"] in ("true", "false"):
        info["type"] = "bool"
        return info, comments[:-1]

    info["type"] = "string"
    keep = comments[:-1] if default_part else comments
    return info, keep


def humanize(key):
    """FGInput -> 'FG Input', HUDFixExtended -> 'HUD Fix Extended'."""
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", key)
    s = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", s)
    return s.replace("_", " ").strip()


def parse_ini(path):
    options = []
    section = None
    buf = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            buf = []
            continue
        if line.startswith(";"):
            c = line.lstrip(";").strip()
            if c and set(c) <= set("- "):   # decorative divider
                continue
            if c:
                buf.append(c)
            continue
        if "=" in line and section:
            key = line.split("=", 1)[0].strip()
            if not buf and options and options[-1]["section"] == section:
                # Grouped keys (RectTop, AccentColorG, QualityRatio*, ...) document
                # only the first member; reuse the sibling's inferred metadata.
                prev = options[-1]
                info = {k: v for k, v in prev.items()
                        if k in ("type", "options", "optionLabels", "min", "max")}
                info["default"] = "auto"
                desc = []
                info["inheritedFrom"] = prev["key"]
            else:
                info, desc = infer(key, buf)
            options.append(
                {
                    "section": section,
                    "key": key,
                    "label": humanize(key),
                    "description": " ".join(desc).strip(),
                    **info,
                }
            )
            buf = []
    return options


def main():
    if not REFERENCE_INI.exists():
        sys.exit(f"missing reference ini: {REFERENCE_INI}")
    options = parse_ini(REFERENCE_INI)

    banner = (
        "# AUTO-GENERATED by scripts/generate_schema.py from defaults/"
        "OptiScaler.reference.ini\n# Do not edit by hand.\n"
    )
    py_out = ROOT / "py_modules" / "optiscaler" / "schema_generated.py"
    py_out.write_text(
        banner + "\nOPTIONS = " + json.dumps(options, indent=4) + "\n", encoding="utf-8"
    )

    ts_banner = (
        "// AUTO-GENERATED by scripts/generate_schema.py from defaults/"
        "OptiScaler.reference.ini\n// Do not edit by hand.\n"
        "import type { OptionMeta } from \"../types\";\n\n"
    )
    ts_out = ROOT / "src" / "config" / "generatedSchema.ts"
    ts_out.parent.mkdir(parents=True, exist_ok=True)
    ts_out.write_text(
        ts_banner
        + "export const GENERATED_OPTIONS: OptionMeta[] = "
        + json.dumps(options, indent=2)
        + ";\n",
        encoding="utf-8",
    )

    by_type = {}
    for o in options:
        by_type[o["type"]] = by_type.get(o["type"], 0) + 1
    print(f"{len(options)} options from {len(set(o['section'] for o in options))} sections")
    print("  types:", dict(sorted(by_type.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
