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


def emit_profile(profile):
    lines = ["// GENERATED by scripts/generate_asi_layout.py; fixed release identity.",
             "#pragma once", "#include <stdint.h>", "namespace runtime_profile {"]
    for key in ("profile_id", "build_id", "source_commit", "core_sha256"):
        lines.append(f'inline constexpr char {key}[] = "{profile[key]}";')
    for group in ("pe", "sizes", "rva", "state_offsets", "feature_offsets", "limits", "fg_offsets", "xefg_offsets", "xefg_gates", "dlss_version", "ifg_state"):
        for key, value in profile[group].items():
            lines.append(f"inline constexpr uint32_t {group}_{key} = {value}u;")
    for key in ("guid_bytes",):
        values = ",".join("0x" + profile["rsds"][key][i:i+2] for i in range(0,32,2))
        lines.append(f"inline constexpr unsigned char rsds_{key}[16] = {{{values}}};")
    lines.append(f'inline constexpr uint32_t rsds_age = {profile["rsds"]["age"]}u;')
    for key, hook in profile["hook"].items():
        lines.append(f'inline constexpr uint32_t hook_{key}_rva = {hook["rva"]}u;')
        values = ",".join("0x" + hook["prologue"][i:i+2] for i in range(0,len(hook["prologue"]),2))
        lines.append(f"inline constexpr unsigned char hook_{key}_prologue[] = {{{values}}};")
    bootstrap = profile["bootstrap"]
    lines.append(f'inline constexpr uint32_t bootstrap_return_rva = {bootstrap["return_rva"]}u;')
    for key in ("call_before_return", "return_prologue"):
        value = bootstrap[key]
        if not value or len(value) % 2 or not re.fullmatch(r"[0-9a-fA-F]+", value):
            raise SystemExit(f"invalid bootstrap byte sequence: {key}")
        values = ",".join("0x" + value[i:i+2] for i in range(0, len(value), 2))
        lines.append(f"inline constexpr unsigned char bootstrap_{key}[] = {{{values}}};")
    lines += ["struct BackendType { uint32_t api;const char* code;uint32_t interface_vtable_rva, physical_offset, cd_offset; };",
              "inline constexpr BackendType backend_types[] = {"]
    for item in profile["backend_types"]:
        lines.append(f'    {{{item["api"]}u,"{item["code"]}",{item["interface_vtable_rva"]}u,{item["physical_offset"]}u,{item["cd_offset"]}u}},')
    lines += ["};", "} // namespace runtime_profile"]
    return "\n".join(lines) + "\n"


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
    OUT_HEADER.write_text(emit_header(members), encoding="utf-8", newline="\n")
    profile = json.loads((ROOT / "defaults" / "live-profile.json").read_text())
    facts = json.loads((REF / "pdb_layout.json").read_text())
    feature_facts = json.loads((REF / "pdb_feature_layout.json").read_text())
    expected = facts["classes"]["Config"]
    if set(expected["fields"]) != {m["name"] for m in members}:
        raise SystemExit("the independent matching PDB must describe every Config member")
    assertions = ["// GENERATED against matching PDB facts, independently of Config.h.",
                  "#pragma once", "#include <stddef.h>", "#include \"config_mirror.h\"",
                  "namespace optimirror {",
                  f'static_assert(sizeof(Config) == {expected["size"]}, "PDB Config size");']
    for name, offset in expected["fields"].items():
        assertions.append(f'static_assert(offsetof(Config, {name}) == {offset}, "PDB Config::{name}");')
    assertions.append("} // namespace optimirror")
    (OUT_HEADER.parent / "pdb_assertions.h").write_text("\n".join(assertions) + "\n", newline="\n")
    if facts["pdb_guid"] != profile["rsds"]["guid"] or facts["pdb_age"] != profile["rsds"]["age"]:
        raise SystemExit("PDB facts identity must match the runtime profile")
    if (feature_facts["pdb_guid"] != profile["rsds"]["guid"] or
            feature_facts["pdb_sha256"] != facts["pdb_sha256"]):
        raise SystemExit("feature PDB facts must match the runtime PDB identity")
    bootstrap = profile.get("bootstrap", {})
    if (bootstrap.get("return_rva") != 2791536 or
            bootstrap.get("call_before_return") != "ffd7" or
            bootstrap.get("return_prologue") != "4885db"):
        raise SystemExit("InitializeASI bootstrap must match the pinned LoadAsiPlugins callsite")
    for name, offset in profile["state_offsets"].items():
        if facts["classes"]["State"]["fields"][name] != offset:
            raise SystemExit(f"State::{name} differs from the matching PDB")
    ifg_fields = feature_facts["classes"]["IFGFeature"]["fields"]
    if profile["ifg_state"] != {key: ifg_fields[field] for key, field in {"active": "_isActive", "waiting": "_waitingNewFrameData", "frames": "_frameCount", "target": "_targetFrame"}.items()}:
        raise SystemExit("FG activity offsets differ from the matching PDB")
    dlss_version = profile["dlss_version"]
    proof = feature_facts["live_apply_proofs"]
    version_proof = proof["feature_version"]
    member_proof = proof["dlss_feature_version"]
    expected_version_fields = [["major", 0, "0x75"], ["minor", 4, "0x75"], ["patch", 8, "0x75"]]
    if (version_proof["size"] != 12 or version_proof["fields"] != expected_version_fields or
            member_proof["member"] != "_version" or member_proof["member_offset"] != 8 or
            member_proof["member_type_index"] != version_proof["type_index"] or
            feature_facts["classes"]["DLSSFeature"]["fields"]["_version"] != member_proof["member_offset"]):
        raise SystemExit("DLSS feature_version TPI field facts do not match the PDB layout")
    if not member_proof.get("source"):
        raise SystemExit("DLSS feature_version PDB provenance is required")
    for backend in profile["backend_types"]:
        if backend["code"] != "dlss":
            continue
        derived = member_proof["derived_classes"].get(backend["class_name"])
        pdb_class = feature_facts["classes"].get(backend["class_name"])
        if (not derived or not pdb_class or derived["class_size"] != pdb_class["size"] or
                derived["interface_offset"] != backend["physical_offset"] or
                derived["interface_offset"] - derived["dlss_base_offset"] - member_proof["member_offset"] !=
                dlss_version["behind_interface"]):
            raise SystemExit(f"{backend['class_name']} DLSS version offset differs from the matching PDB")
    if (set(member_proof["derived_classes"]) != {b["class_name"] for b in profile["backend_types"] if b["code"] == "dlss"} or
            dlss_version["major_offset"] != 0):
        raise SystemExit("DLSS version profile must cover all API layouts and major offset")
    gates = json.loads((REF / "xefg_gates_layout.json").read_text())
    gate_expected = {
        "ifg_constants_flags": gates["ifg_constants_offset"] + gates["FG_Constants"]["fields"]["flags"]["offset"],
        "flags_size": gates["bitset_storage"]["FG_Flags"]["sizeof"],
        "display_mv_bit": gates["FG_Flags"]["values"]["DisplayResolutionMVs"],
        "quirk_force_render_mv_bit": gates["GameQuirk_ForceFGRenderSizeMVs"],
        "swapchain_format_offset": gates["windows_sdk_proof"]["DXGI_SWAP_CHAIN_DESC.BufferDesc"] + gates["windows_sdk_proof"]["DXGI_MODE_DESC.Format"],
    }
    if gates["pdb_guid"] != profile["rsds"]["guid"] or profile["xefg_gates"] != gate_expected:
        raise SystemExit("XeFG gates differ from the independently matched PDB/Windows SDK facts")
    if len(members) != 300 or profile["sizes"]["config"] != 6672:
        raise SystemExit("the pinned release layout requires exactly 300 Config members")
    (OUT_HEADER.parent / "runtime_profile.h").write_text(emit_profile(profile), encoding="utf-8", newline="\n")

    fields = {}
    for ini_key, info in sorted(ini_map.items()):
        member = by_name[info["member"]]
        fields[ini_key] = {
            "member": member["name"],
            "kind": member["kind"],
            "read": info["read"],
        }
    OUT_JSON.write_text(json.dumps({"fields": fields}, indent=1, sort_keys=True), encoding="utf-8", newline="\n")

    print(f"members: {len(members)} (skipped {len(skipped)} non-data declarations)")
    print(f"ini keys mapped: {len(fields)}")
    print(f"wrote {OUT_HEADER.relative_to(ROOT)} and {OUT_JSON.relative_to(ROOT)}")
    for probe in ("FrameGen.Enabled", "Upscalers.Dx12Upscaler", "XeFG.InterpolationCount"):
        print(f"  {probe:28} -> {fields.get(probe)}")


if __name__ == "__main__":
    sys.exit(main())
