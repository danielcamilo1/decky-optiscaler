"""Indexes and validation over the generated OptiScaler option schema.

`schema_generated.py` is produced by scripts/generate_schema.py from the
comments in defaults/OptiScaler.reference.ini, so it is the closest thing this
plugin has to a definition of what OptiScaler will accept. Anything that writes
an INI key goes through `valid()` first — the config writer for keys the user
picked in the UI, and the wiki plan builder for keys mined out of prose, where
the need is greater still.
"""

from .live import FFX_FG_MAX, FFX_UPSCALER_MAX
from .schema_generated import OPTIONS

#: (section, key) -> option metadata.
SCHEMA = {(o["section"], o["key"]): o for o in OPTIONS}

#: lowercased key name -> every option with that name. Most are unique, but a
#: dozen (Enabled, DebugView, MakeDepthCopy...) appear in several sections, and
#: a key mined from prose that lands on one of those cannot be resolved without
#: a section to go with it.
BY_KEY_NAME = {}
for _option in OPTIONS:
    BY_KEY_NAME.setdefault(_option["key"].lower(), []).append(_option)


def option(section, key):
    return SCHEMA.get((section, key))


def resolve(key_name, section=None):
    """Find the option a bare key name refers to.

    Returns (option, reason). ``reason`` is None on success and otherwise says
    why nothing was returned, so a caller can report "the wiki named a setting
    we could not place" instead of silently dropping it.
    """
    candidates = BY_KEY_NAME.get(str(key_name).strip().lower())
    if not candidates:
        return None, "not an OptiScaler setting"
    if section:
        wanted = str(section).strip().lower()
        exact = [o for o in candidates if o["section"].lower() == wanted]
        if exact:
            return exact[0], None
        return None, f"no [{section}] section has this setting"
    if len(candidates) > 1:
        sections = ", ".join(sorted(o["section"] for o in candidates))
        return None, f"ambiguous — exists in {sections}"
    return candidates[0], None


#: Options whose reference-ini enum is a snapshot rather than a closed set.
#:
#: ``FSR.FGIndex`` is written "0 = FSR 4.0.0 | 1 = FSR 3.1.6" in the shipped ini
#: because that is what the reference build's FidelityFX SDK offered. The list
#: is per-game — OptiScaler asks the SDK what it can provide and reports the
#: answer through the live channel, which is what the FFX FG control lists — so
#: validating a pick against the ini's two entries rejects any third generator a
#: game actually has. The write is then dropped *and never pushed live*, so the
#: control ends up showing a choice that reached neither the file nor the game.
#: The real constraint is that it is an index, bounded by the same ceiling the
#: live channel uses.
#:
#: ``FSR.UpscalerIndex`` is the same snapshot one step over: the ini documents
#: "0 = FSR 4.0.2 | 1 = FSR 3.1.5 | 2 = FSR 2.3.4" while the game in front of
#: you reports 4.1.1 and however many others its FidelityFX runtime carries.
INDEX_RANGES = {
    ("FSR", "FGIndex"): (0, FFX_FG_MAX - 1),
    ("FSR", "UpscalerIndex"): (0, FFX_UPSCALER_MAX - 1),
}


def valid(meta, value):
    """Validate a value against one option's metadata; 'auto' is always allowed."""
    if value == "auto":
        return True
    bounds = INDEX_RANGES.get((meta.get("section"), meta.get("key")))
    if bounds is not None:
        number = _as_int(value)
        return number is not None and bounds[0] <= number <= bounds[1]
    kind = meta.get("type")
    if kind == "bool":
        return value.lower() in ("true", "false")
    if kind == "enum":
        options = meta.get("options") or []
        return not options or value in options
    if kind == "keycode":
        # Virtual-key codes are written in hex in OptiScaler's own reference ini
        # ("set ShortcutKey=0x08"), and the wiki quotes them the same way.
        return _as_int(value) is not None
    if kind == "int":
        number = _as_int(value)
        return number is not None and _in_range(meta, number)
    if kind == "float":
        try:
            number = float(value)
        except ValueError:
            return False
        return _in_range(meta, number)
    return True


def _as_int(value):
    """An int written in decimal or as 0x hex, or None."""
    text = str(value).strip()
    for base in (0, 10):
        try:
            return int(text, base)
        except ValueError:
            continue
    return None


def _in_range(meta, number):
    if meta.get("min") is not None and number < meta["min"]:
        return False
    if meta.get("max") is not None and number > meta["max"]:
        return False
    return True
