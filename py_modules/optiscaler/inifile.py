"""Minimal INI reader/writer that preserves comments, ordering and spacing.

OptiScaler.ini is ~1400 lines of documentation interleaved with keys. Python's
ConfigParser would discard all of it on write, so we edit lines in place and
only ever touch the ``Key=Value`` line that actually changes.
"""

import re
from pathlib import Path

SECTION_RE = re.compile(r"^\s*\[([^\]]+)\]\s*$")


def _key_re(key):
    return re.compile(rf"^(\s*){re.escape(key)}(\s*)=(.*)$")


class IniFile:
    def __init__(self, path):
        self.path = Path(path)
        self.lines = []
        self.newline = "\n"
        self._load()

    def _load(self):
        if not self.path.exists():
            self.lines = []
            return
        text = self.path.read_text(encoding="utf-8", errors="replace")
        self.newline = "\r\n" if "\r\n" in text else "\n"
        self.lines = text.splitlines()

    # -- reading ---------------------------------------------------------
    def to_dict(self):
        """Return {section: {key: value}} for every assignment in the file."""
        out = {}
        section = None
        for line in self.lines:
            stripped = line.strip()
            if not stripped or stripped.startswith(";") or stripped.startswith("#"):
                continue
            m = SECTION_RE.match(line)
            if m:
                section = m.group(1)
                out.setdefault(section, {})
                continue
            if "=" in stripped and section is not None:
                key, value = stripped.split("=", 1)
                out.setdefault(section, {})[key.strip()] = value.strip()
        return out

    def get(self, section, key, default=None):
        return self.to_dict().get(section, {}).get(key, default)

    # -- writing ---------------------------------------------------------
    def set(self, section, key, value):
        """Set section/key to value, creating either if needed."""
        value = "auto" if value is None else str(value)
        pattern = _key_re(key)
        in_section = False
        section_end = None

        for idx, line in enumerate(self.lines):
            m = SECTION_RE.match(line)
            if m:
                if in_section:
                    section_end = idx
                    break
                in_section = m.group(1) == section
                continue
            if in_section and pattern.match(line):
                lead, pad, _ = pattern.match(line).groups()
                self.lines[idx] = f"{lead}{key}{pad}={value}"
                return

        if in_section:
            # Key missing from an existing section: append at its end, after
            # the last non-blank line so we do not orphan trailing whitespace.
            insert_at = section_end if section_end is not None else len(self.lines)
            while insert_at > 0 and not self.lines[insert_at - 1].strip():
                insert_at -= 1
            self.lines.insert(insert_at, f"{key}={value}")
            return

        if self.lines and self.lines[-1].strip():
            self.lines.append("")
        self.lines.append(f"[{section}]")
        self.lines.append(f"{key}={value}")

    def update(self, changes):
        """Apply {(section, key): value} or {section: {key: value}}."""
        if not changes:
            return
        first = next(iter(changes))
        if isinstance(first, tuple):
            for (section, key), value in changes.items():
                self.set(section, key, value)
        else:
            for section, entries in changes.items():
                for key, value in entries.items():
                    self.set(section, key, value)

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        text = self.newline.join(self.lines)
        if text and not text.endswith(self.newline):
            text += self.newline
        self.path.write_text(text, encoding="utf-8")
