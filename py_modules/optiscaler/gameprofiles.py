"""Small, source-backed exceptions which must also work without the wiki cache."""

from pathlib import Path
from .constants import OPTISCALER_VERSION

PBZ_WIKI = "https://github.com/optiscaler/OptiScaler/wiki/Phantom-Blade-Zero"
PBZ_TARGET = "PBZ/platform/steam"
PBZ_STEPS = [
    "Install beside the main PBZ.exe in PBZ/platform/steam (not the usual Unreal Binaries folder).",
    "Keep the game's Super Resolution Output Scale at 100%; change only the upscaler preset.",
]


def is_pbz(name):
    value = str(name or "").strip()
    key = "".join(character for character in value.casefold() if character.isalnum())
    return key in {"影之刃零", "phantombladezero", "pbz"}


def has_pbz_identity(game_path=None, name=None, wiki_identity=None, extra_names=None):
    root_name = Path(game_path).name if game_path else None
    return any(is_pbz(value) for value in [name, root_name, wiki_identity, *(extra_names or [])])


def target_for(game_path, name=None, wiki_identity=None, extra_names=None):
    root = Path(game_path)
    # The selected compatibility entry is an explicit identity for renamed
    # Steam shortcuts and custom library roots. Keep the comparison exact
    # after normalization: words like "PBZ" inside an unrelated title do not
    # make it a Phantom Blade Zero install.
    if not has_pbz_identity(game_path, name, wiki_identity, extra_names):
        return None
    candidates = [root / "platform" / "steam", root / "PBZ" / "platform" / "steam"]
    if root.name.lower() == "steam" and root.parent.name.lower() == "platform":
        candidates.append(root)  # Non-Steam shortcuts can already point beside PBZ.exe.
    for candidate in candidates:
        if not candidate.is_dir() or not candidate.resolve().is_relative_to(root.resolve()):
            continue
        if any(p.is_file() and p.name.lower() == "pbz.exe" for p in candidate.iterdir()):
            return str(candidate)
    return None


def recommendation(result, name, extra_names=None, wiki_identity=None, game_path=None):
    """Retain online detail, filling critical PBZ instructions from a reviewed pin."""
    if not has_pbz_identity(game_path, name, wiki_identity, extra_names):
        return result
    result = dict(result or {})
    matched_pbz_row = is_pbz(result.get("game"))
    detail = dict(result.get("detail") or {}) if matched_pbz_row else {}
    detail.setdefault("Known Issues", "Requires OptiScaler 0.9.5+ and the non-standard PBZ/platform/steam installation folder.")
    detail.setdefault("Notes", "Keep Super Resolution Output Scale at 100%; only change the upscaler preset.")
    detail.setdefault("FG Inputs", "DLSSG via SL")
    result.update(matched=True, game="Phantom Blade Zero", filename="dxgi.dll",
                  filename_source="reviewed wiki profile", wiki_url=PBZ_WIKI,
                  compatibility=(result.get("compatibility") if matched_pbz_row else None) or "✅",
                  notes=result.get("notes") if matched_pbz_row else None,
                  inputs=result.get("inputs") if matched_pbz_row else None,
                  alternatives=result.get("alternatives", []) if matched_pbz_row else [],
                  optipatcher=result.get("optipatcher", False) if matched_pbz_row else False,
                  page=result.get("page") if matched_pbz_row else None,
                  detail=detail, detail_pending=False, required_version="0.9.5",
                  required_target=PBZ_TARGET, manual_steps=list(PBZ_STEPS))
    return result


def constrain(plan, result):
    result = result or {}
    if not (is_pbz(result.get("game")) and result.get("required_target") == PBZ_TARGET):
        return plan
    # The reviewed official release contains the PBZ ExtendedSearch and input fixes.
    supported = OPTISCALER_VERSION == "0.9.5"
    plan.update(required_version="0.9.5", required_target=PBZ_TARGET,
                manual_steps=list(PBZ_STEPS), runtime_supported=supported,
                blocked_reason=None if supported else "Phantom Blade Zero requires the pinned 0.9.5+ compatibility fixes. Upgrade this plugin first.")
    return plan
