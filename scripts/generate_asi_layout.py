#!/usr/bin/env python3
"""Generate the MSVC-ABI mirror of OptiScaler's Config object for the ASI.

The ASI has to read and write fields inside OptiScaler's live `Config` object,
which means it needs that object's exact memory layout. OptiScaler ships as an
MSVC build, so the layout is fixed by the MSVC C++ ABI and its standard library.

Rather than hand-copy offsets (one missed member silently shifts everything
after it), this parses the real `Config.h` member list and emits a C++ struct
built from MSVC-layout-compatible stand-ins. The *compiler* then computes the
offsets, and the ASI validates them at runtime before writing anything.

The INI key <-> member mapping is parsed out of `Config.cpp`'s Reload(), so the
plugin can address fields by the same (section, key) pairs it already uses.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "asi" / "optiscaler_ref"
OUT_HEADER = ROOT / "asi" / "generated" / "config_mirror.h"
OUT_JSON = ROOT / "py_modules" / "optiscaler" / "live_fields.json"

# C++ types we know how to mirror, with the spelling used in the mirror header.
SCALARS = {
    "bool": "bool",
    "float": "float",
    "int": "int32_t",
    "int32_t": "int32_t",
    "uint32_t": "uint32_t",
    "UINT": "uint32_t",
    "std::string": "msvc_string",
    "std::wstring": "msvc_wstring",
}

# Enum members: mirrored as their underlying type.
ENUM_UNDERLYING = {
    "Upscaler": "int32_t",
    "SharpenShader": "int32_t",
    "FSR4Support": "uint8_t",
    "Scaler": "uint32_t",
    "ForceReflex": "uint32_t",
    "LFXMode": "uint32_t",
    "LowLatencyInput": "uint32_t",
    "LowLatencyMode": "uint32_t",
    "FrameTimeSource": "uint32_t",
    "FGInput": "uint32_t",
    "FGOutput": "uint32_t",
    "FGNvngxReplacement": "uint32_t",
    "FpsOverlay": "uint32_t",
    "FpsOverlayPos": "uint32_t",
}

# Non-CustomOptional members that still take up space in the object.
PLAIN_TYPES = {
    "std::filesystem::path": "msvc_path",
    "std::wstring": "msvc_wstring",
    "std::string": "msvc_string",
}


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def class_body(text, name):
    match = re.search(r"\bclass\s+%s\b[^{]*\{" % name, text)
    if not match:
        raise SystemExit(f"class {name} not found")
    start = match.end()
    depth = 1
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i]
    raise SystemExit(f"class {name} body not closed")


def split_declarations(body):
    """Split a class body into statements, ignoring ; inside braces/parens/strings."""
    out, buf, depth, i = [], [], 0, 0
    while i < len(body):
        ch = body[i]
        if ch in "\"'":
            quote, buf_start = ch, i
            i += 1
            while i < len(body) and body[i] != quote:
                i += 2 if body[i] == "\\" else 1
            buf.append(body[buf_start : i + 1])
            i += 1
            continue
        if ch in "{([<":
            if ch != "<":
                depth += 1
        elif ch in "})]":
            depth -= 1
        if ch == ";" and depth == 0:
            out.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    if "".join(buf).strip():
        out.append("".join(buf).strip())
    return out


OPTIONAL_RE = re.compile(
    r"^CustomOptional\s*<\s*(?P<inner>[^,>]+?)\s*(?:,\s*(?P<mode>\w+)\s*)?>\s+"
    r"(?P<name>[A-Za-z_]\w*)\s*(?P<init>[={].*)?$",
    re.S,
)


def parse_members(header_text):
    """Ordered non-static data members of class Config."""
    body = strip_comments(class_body(header_text, "Config"))
    members, skipped = [], []
    for decl in split_declarations(body):
        decl = " ".join(decl.split())
        if not decl or decl.endswith(":"):
            continue
        if decl.startswith(("public", "private", "protected", "template", "static ")):
            continue
        if "inline static" in decl or decl.startswith("using "):
            skipped.append(decl)
            continue
        # Function declarations: a ( before any = initializer.
        paren, equals = decl.find("("), decl.find("=")
        if paren != -1 and (equals == -1 or paren < equals) and not decl.startswith("CustomOptional"):
            skipped.append(decl)
            continue

        match = OPTIONAL_RE.match(decl)
        if match:
            inner = match.group("inner").strip()
            if inner in SCALARS:
                mirror, kind = SCALARS[inner], inner
            elif inner in ENUM_UNDERLYING:
                mirror, kind = ENUM_UNDERLYING[inner], "enum:" + inner
            else:
                raise SystemExit(f"unknown CustomOptional inner type {inner!r} in: {decl}")
            members.append(
                {"name": match.group("name"), "kind": kind, "mirror": mirror,
                 "optional": True, "inner": inner}
            )
            continue

        # Plain (non-optional) data member.
        plain = re.match(r"^(?P<type>[\w:]+(?:\s*<[^>]*>)?)\s+(?P<name>[A-Za-z_]\w*)\s*(=.*)?$", decl)
        if plain and plain.group("type") in PLAIN_TYPES:
            members.append(
                {"name": plain.group("name"), "kind": plain.group("type"),
                 "mirror": PLAIN_TYPES[plain.group("type")], "optional": False,
                 "inner": plain.group("type")}
            )
            continue

        raise SystemExit(f"unrecognised declaration in class Config: {decl[:120]!r}")
    return members, skipped


READ_RE = re.compile(
    r"(?P<member>[A-Za-z_]\w*)\s*\.set_from_config\(\s*"
    r"read(?P<how>Bool|Int|Float|UInt|String|WString|Enum\s*<[^>]*>)\s*\(\s*"
    r"\"(?P<section>[^\"]+)\"\s*,\s*\"(?P<key>[^\"]+)\"",
    re.S,
)


# Some options are read into a local first so the value can be clamped or
# converted before being stored, e.g.
#   if (auto setting = readFloat("Sharpness", "Sharpness"); setting.has_value())
#       Sharpness.set_from_config(std::clamp(setting.value(), 0.0f, 1.3f));
DEFERRED_RE = re.compile(
    r"read(?P<how>Bool|Int|Float|UInt|String|WString|Enum\s*<[^>]*>)\s*\(\s*"
    # The tail is a lookahead so overlapping reads (a readBool nested inside one
    # set_from_config, immediately followed by another) both get seen.
    r"\"(?P<section>[^\"]+)\"\s*,\s*\"(?P<key>[^\"]+)\""
    r"(?=[^;]*;.{0,400}?(?P<member>[A-Za-z_]\w*)\s*\.set_from_config\()",
    re.S,
)


def parse_ini_map(source_text):
    """(section, key) -> member, as spelled in Config::Reload."""
    text = strip_comments(source_text)
    mapping = {}
    for match in READ_RE.finditer(text):
        how = match.group("how")
        how = "Enum" if how.startswith("Enum") else how
        mapping[f"{match.group('section')}.{match.group('key')}"] = {
            "member": match.group("member"),
            "read": how,
        }
    for match in DEFERRED_RE.finditer(text):
        ini_key = f"{match.group('section')}.{match.group('key')}"
        if ini_key in mapping:
            continue
        how = match.group("how")
        mapping[ini_key] = {
            "member": match.group("member"),
            "read": "Enum" if how.startswith("Enum") else how,
        }
    return mapping


def emit_header(members):
    lines = [
        "// GENERATED by scripts/generate_asi_layout.py -- do not edit.",
        "// Mirror of OptiScaler's Config object using MSVC-ABI-compatible stand-ins.",
        "#pragma once",
        "#include \"msvc_abi.h\"",
        "",
        "namespace optimirror {",
        "",
        "struct Config",
        "{",
    ]
    for m in members:
        if m["optional"]:
            lines.append(f"    CustomOptional<{m['mirror']}> {m['name']};")
        else:
            lines.append(f"    {m['mirror']} {m['name']};")
    lines += ["};", ""]

    # X-macro list so the ASI builds its field table with real offsetof(), never
    # a number this script guessed at.
    kind_of = {
        "bool": "OPTI_BOOL", "float": "OPTI_FLOAT",
        "int": "OPTI_I32", "int32_t": "OPTI_I32",
        "uint32_t": "OPTI_U32", "UINT": "OPTI_U32",
        "std::string": "OPTI_STR", "std::wstring": "OPTI_WSTR",
    }
    lines.append("// name, mirror C type, kind tag")
    lines.append("#define OPTI_CONFIG_FIELDS(X) \\")
    for m in members:
        if not m["optional"]:
            continue
        kind = kind_of.get(m["kind"]) or (
            "OPTI_U32" if m["mirror"] in ("uint32_t", "uint8_t") else "OPTI_I32"
        )
        if m["mirror"] == "uint8_t":
            kind = "OPTI_U8"
        lines.append(f"    X({m['name']}, {m['mirror']}, {kind}) \\")
    lines.append("    /* end */")
    lines += ["", "} // namespace optimirror", ""]
    return "\n".join(lines)


def main():
    header = (REF / "Config.h").read_text(encoding="utf-8", errors="replace")
    source = (REF / "Config.cpp").read_text(encoding="utf-8", errors="replace")

    members, skipped = parse_members(header)
    ini_map = parse_ini_map(source)

    by_name = {m["name"]: m for m in members}
    unresolved = sorted({v["member"] for v in ini_map.values()} - set(by_name))
    if unresolved:
        raise SystemExit(f"Config.cpp reads members absent from Config.h: {unresolved}")

    OUT_HEADER.parent.mkdir(parents=True, exist_ok=True)
    OUT_HEADER.write_text(emit_header(members), encoding="utf-8")

    fields = {}
    for ini_key, info in sorted(ini_map.items()):
        member = by_name[info["member"]]
        fields[ini_key] = {
            "member": member["name"],
            "kind": member["kind"],
            "read": info["read"],
        }
    OUT_JSON.write_text(json.dumps({"fields": fields}, indent=1, sort_keys=True), encoding="utf-8")

    print(f"members: {len(members)} (skipped {len(skipped)} non-data declarations)")
    print(f"ini keys mapped: {len(fields)}")
    print(f"wrote {OUT_HEADER.relative_to(ROOT)} and {OUT_JSON.relative_to(ROOT)}")
    for probe in ("FrameGen.Enabled", "Upscalers.Dx12Upscaler", "XeFG.InterpolationCount"):
        print(f"  {probe:28} -> {fields.get(probe)}")


if __name__ == "__main__":
    sys.exit(main())
