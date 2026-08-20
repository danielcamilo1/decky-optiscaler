"""Turn a wiki compatibility entry into a set-up plan the plugin can apply.

The compatibility list and its per-game entries already say, in prose, almost
everything a person does by hand: which filename to install OptiScaler as,
whether the game needs OptiPatcher, which launch option forces the right
graphics API, which frame-generation input the game can actually feed, and
which OptiScaler.ini keys have to be changed for it to work at all. This module
reads that back out.

Two rules run through all of it:

* **Nothing is guessed.** A key is only taken when its name resolves to a real
  option in the generated schema and its value validates against that option's
  type; a frame-generation name is only taken when it matches one of the names
  OptiScaler's own overlay uses. Anything else is reported in ``unresolved`` so
  the user can see what the wiki asked for that this could not do — silently
  dropping half a wiki entry would be worse than not offering the feature.
* **The user's three choices are never overridden.** Automatic mode exists so
  that frame generation on/off, the frame multiplier and the upscaler stay the
  user's, with everything around them set from the wiki. Keys belonging to
  those three are dropped even when a wiki entry names them.
"""

import re

from . import schema
from .constants import DEFAULT_PROXY

# Extra arguments a wiki entry may tell the user to launch the game with. These
# go after %command% — they are the game's own arguments, not Proton's.
LAUNCH_FLAGS = ("-dx12", "-dx11", "-d3d12", "-vulkan")

# The keys automatic mode leaves to the user, whatever the wiki says about them.
USER_OWNED = {
    ("Upscalers", "Dx12Upscaler"),
    ("Upscalers", "Dx11Upscaler"),
    ("Upscalers", "VulkanUpscaler"),
    ("FSR", "Fsr4Update"),
    ("FSR", "UpscalerIndex"),
    ("FSR", "FGIndex"),
    ("FrameGen", "Enabled"),
    ("XeFG", "InterpolationCount"),
}

# Wiki fields worth mining, most authoritative first. "Settings" and
# "FG-Settings" are where entries put explicit ini keys; the prose fields carry
# the rest, and are searched afterwards so a specific field wins a conflict.
DETAIL_FIELDS = ("Settings", "FG-Settings", "Known Issues", "Notes")

# `Key = value`, with or without backticks. The key has to resolve in the
# schema and the value has to validate, so this can afford to be broad.
SETTING_RE = re.compile(r"`?\b([A-Za-z][A-Za-z0-9_]{2,})\s*=\s*([A-Za-z0-9._+-]+)\b`?")
# An AsciiDoc/markdown mention of an ini section, used to disambiguate a key
# name that several sections share: "[FrameGen] `FGType = optifg`".
SECTION_RE = re.compile(r"[`\[]\s*\[?([A-Za-z][A-Za-z0-9-]{2,})\]\s*`?")

# Frame-generation names as the wiki writes them, mapped to the ini values.
# Order matters: "Nukem's DLSSG" contains "DLSSG", and "OptiFG" would otherwise
# be swallowed by the FSR pattern.
FG_INPUT_PATTERNS = (
    ("nukems", r"nukem"),
    ("upscaler", r"\boptifg\b"),
    ("dlssg", r"\bdlss[\s\-]*g\b"),
    ("fsrfg30", r"\bfsr[\s\-]*3\.0[\s\-]*fg\b"),
    ("fsrfg", r"\bfsr[\s\-]*(?:3(?:\.1)?[\s\-/0-9]*)?[\s\-]*fg\b"),
)
FG_OUTPUT_PATTERNS = (
    ("xefg", r"\bxefg\b"),
    ("nukems", r"nukem"),
    ("fsrfg", r"\bfsr[\s\-]*[0-9.]*[\s\-]*fg\b"),
)
# What a wiki entry means by "no frame generation through OptiScaler".
FG_NONE_RE = re.compile(r"^\s*(none|n/?a|-|—)\b", re.I)

# The output each input pairs with when the entry does not say. These follow
# OptiScaler's own defaults: Nukem's is its own output, and everything else
# lands on FSR FG, which is the output that needs no extra hardware support.
FG_DEFAULT_OUTPUT = {
    "nukems": "nukems",
    "dlssg": "fsrfg",
    "fsrfg": "fsrfg",
    "fsrfg30": "fsrfg",
    "upscaler": "fsrfg",
}

# The overlay's own names, so a plan reads the way the in-game menu does.
FG_INPUT_LABELS = {
    "nofg": "No Frame Generation",
    "nukems": "Nukem's DLSSG",
    "fsrfg": "FSR 3.1 FG",
    "dlssg": "DLSSG via Streamline",
    "upscaler": "OptiFG (Upscaler)",
    "fsrfg30": "FSR 3.0 FG",
}
FG_OUTPUT_LABELS = {
    "nofg": "No Frame Generation",
    "nukems": "FSR3-FG via Nukem's",
    "fsrfg": "FSR FG",
    "xefg": "XeFG",
}


def _clean(text):
    """Strip the markup the wiki cells carry so patterns see plain words."""
    if not text:
        return ""
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)      # markdown links
    text = re.sub(r"https?://\S+\[([^\]]*)\]", r"\1", text)   # asciidoc links
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.I)
    return text.replace("’", "'").replace("–", "-").replace("—", "-")


def _texts(recommendation):
    """Every blob of wiki prose worth reading, each with where it came from."""
    detail = recommendation.get("detail") or {}
    out = []
    for label in DETAIL_FIELDS:
        value = _clean(detail.get(label, "")).strip()
        if value and value not in ("-", "N/A"):
            out.append((f"wiki entry, “{label}”", value))
    notes = _clean(recommendation.get("notes") or "").strip()
    if notes:
        out.append(("compatibility list notes", notes))
    return out


# -- ini settings ------------------------------------------------------------

def _mine_settings(sources):
    """INI keys the wiki names outright, resolved against the real schema."""
    settings = {}
    unresolved = []
    seen_unresolved = set()

    for origin, text in sources:
        for match in SETTING_RE.finditer(text):
            name, value = match.group(1), match.group(2)
            # The nearest preceding [Section] marker, when there is one, is what
            # lets a shared key name like "Enabled" be placed at all.
            section = None
            for marker in SECTION_RE.finditer(text, 0, match.start()):
                section = marker.group(1)
            meta, why = schema.resolve(name, section)
            if meta is None:
                # A section guess that did not pan out is not evidence that the
                # key is unplaceable; try again without it before giving up.
                if section:
                    meta, why = schema.resolve(name)
            if meta is None:
                note = f"{name}={value} ({why})"
                if note not in seen_unresolved:
                    seen_unresolved.add(note)
                    unresolved.append({"text": note, "source": origin})
                continue

            identity = (meta["section"], meta["key"])
            if identity in USER_OWNED or identity in settings:
                continue
            normalised = value.lower() if meta["type"] in ("bool", "enum") else value
            if not schema.valid(meta, normalised):
                note = f"{meta['section']}.{meta['key']}={value} (not a valid value)"
                if note not in seen_unresolved:
                    seen_unresolved.add(note)
                    unresolved.append({"text": note, "source": origin})
                continue
            settings[identity] = {
                "section": meta["section"],
                "key": meta["key"],
                "value": normalised,
                "label": meta.get("label") or meta["key"],
                "source": origin,
            }
    return list(settings.values()), unresolved


# -- frame generation --------------------------------------------------------

def _match_fg(text, patterns):
    for value, pattern in patterns:
        if re.search(pattern, text, re.I):
            return value
    return None


def _mine_framegen(recommendation, sources):
    """The frame-generation input and output the wiki recommends.

    The entry's own "FG Inputs" row is the statement of what the game can feed;
    "FG-Settings" is where a recommended pairing is written, usually with an
    arrow ("DLSSG via SL -> XeFG"), which is the only place an *output* is
    stated rather than implied.
    """
    detail = recommendation.get("detail") or {}
    inputs_field = _clean(detail.get("FG Inputs", "")).strip()
    fg_settings = _clean(detail.get("FG-Settings", "")).strip()

    if inputs_field and FG_NONE_RE.match(inputs_field):
        return {
            "input": "nofg",
            "output": "nofg",
            "input_label": FG_INPUT_LABELS["nofg"],
            "output_label": FG_OUTPUT_LABELS["nofg"],
            "source": "wiki entry, “FG Inputs”",
            "detail": inputs_field,
        }

    # "A -> B" states both halves at once and is the strongest evidence there is.
    for origin, text in (("wiki entry, “FG-Settings”", fg_settings),
                         ("wiki entry, “FG Inputs”", inputs_field)):
        if not text:
            continue
        arrow = re.search(r"(.{2,60}?)\s*-+>\s*(.{2,60})", text)
        if not arrow:
            continue
        chosen_input = _match_fg(arrow.group(1), FG_INPUT_PATTERNS)
        chosen_output = _match_fg(arrow.group(2), FG_OUTPUT_PATTERNS)
        if chosen_input and chosen_output:
            return _framegen(chosen_input, chosen_output, origin, text)

    for origin, text in (("wiki entry, “FG Inputs”", inputs_field),
                         ("wiki entry, “FG-Settings”", fg_settings)):
        chosen_input = _match_fg(text, FG_INPUT_PATTERNS) if text else None
        if chosen_input:
            return _framegen(chosen_input, FG_DEFAULT_OUTPUT[chosen_input], origin, text)

    # Last resort: the prose. Only an explicit recommendation counts here —
    # every entry mentions frame generation somewhere, and a passing mention is
    # not a recommendation.
    for origin, text in sources:
        hint = re.search(r"[Rr]ecommend\w*[^.]{0,80}", text)
        if not hint:
            continue
        chosen_input = _match_fg(hint.group(0), FG_INPUT_PATTERNS)
        chosen_output = _match_fg(hint.group(0), FG_OUTPUT_PATTERNS)
        if chosen_input:
            return _framegen(chosen_input, chosen_output or FG_DEFAULT_OUTPUT[chosen_input],
                             origin, hint.group(0).strip())
    return None


def _framegen(chosen_input, chosen_output, source, detail):
    return {
        "input": chosen_input,
        "output": chosen_output,
        "input_label": FG_INPUT_LABELS.get(chosen_input, chosen_input),
        "output_label": FG_OUTPUT_LABELS.get(chosen_output, chosen_output),
        "source": source,
        "detail": detail[:200],
    }


# -- launch options ----------------------------------------------------------

def _mine_launch_flags(sources):
    """Game arguments the wiki says to launch with, e.g. -dx12."""
    found = []
    for origin, text in sources:
        for flag in LAUNCH_FLAGS:
            if flag in found:
                continue
            # A bare token: the leading lookbehind is what keeps "non-DX11
            # device error" from reading as an instruction to add -dx11, which
            # it did for every Luma Unreal Engine entry on the list.
            for match in re.finditer(r"(?<![\w])" + re.escape(flag) + r"\b", text, re.I):
                before = text[max(0, match.start() - 40):match.start()].lower()
                if re.search(r"\b(don'?t|do not|never|avoid|without|instead of)\b", before):
                    continue
                found.append(flag)
                break
    return found


def launch_options(filename, flags):
    """The full Steam launch options string for a filename and extra arguments.

    Proton's DLL override has to come before %command% because it is an
    environment variable for the process; the game's own arguments go after it,
    where Steam appends them to the command line.
    """
    if str(filename).lower().endswith(".asi"):
        head = "%command%"
    else:
        stem = filename[:-4] if filename.lower().endswith(".dll") else filename
        head = f'WINEDLLOVERRIDES="{stem}=n,b" %command%'
    return " ".join([head, *flags]) if flags else head


# -- the plan ----------------------------------------------------------------

def build(recommendation):
    """A complete set-up plan, or one that reports itself unavailable."""
    plan = {
        "available": False,
        "game": None,
        "source": None,
        "wiki_url": None,
        "filename": DEFAULT_PROXY,
        "filename_source": "default",
        "optipatcher": False,
        "launch_flags": [],
        "launch_options": launch_options(DEFAULT_PROXY, []),
        "settings": [],
        "framegen": None,
        "unresolved": [],
        "warnings": [],
    }
    if not recommendation or not recommendation.get("matched"):
        return plan

    sources = _texts(recommendation)
    settings, unresolved = _mine_settings(sources)
    flags = _mine_launch_flags(sources)
    filename = recommendation.get("filename") or DEFAULT_PROXY

    plan.update(
        available=True,
        game=recommendation.get("game"),
        # A dedicated entry has been written up by hand; a bare list row has
        # only its notes column, so say which one this came from.
        source="wiki entry" if recommendation.get("detail") else "compatibility list",
        wiki_url=recommendation.get("wiki_url"),
        filename=filename,
        filename_source=recommendation.get("filename_source") or "default",
        optipatcher=bool(recommendation.get("optipatcher")),
        launch_flags=flags,
        launch_options=launch_options(filename, flags),
        settings=settings,
        framegen=_mine_framegen(recommendation, sources),
        unresolved=unresolved,
    )

    if recommendation.get("compatibility") and "❌" in recommendation["compatibility"]:
        plan["warnings"].append(
            "The wiki lists this game as not working with OptiScaler.")
    if recommendation.get("detail", {}).get("Known Issues", "").strip() not in ("", "-"):
        plan["warnings"].append(
            "This game has known issues on the wiki that may need steps outside "
            "this plugin — read them on the Setup tab before playing.")
    return plan


def framegen_changes(plan):
    """The INI changes that select the wiki's recommended FG method."""
    framegen = (plan or {}).get("framegen")
    if not framegen or framegen["input"] == "nofg":
        return []
    return [
        {"section": "FrameGen", "key": "FGInput", "value": framegen["input"]},
        {"section": "FrameGen", "key": "FGOutput", "value": framegen["output"]},
    ]


def setting_changes(plan):
    """The INI changes for everything the wiki asked for bar the user's choices."""
    return [
        {"section": item["section"], "key": item["key"], "value": item["value"]}
        for item in (plan or {}).get("settings", [])
    ]
