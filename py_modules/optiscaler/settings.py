"""Persistent plugin settings (custom libraries, per-game install targets)."""

import json
import threading
from pathlib import Path


class Settings:
    DEFAULTS = {
        "custom_libraries": [],   # [{"path": str, "name": str}]
        "game_targets": {},       # game_path -> chosen install directory
        "wiki_entries": {},        # game_path -> pinned compatibility entry name
        "expanded_libraries": [],
        "last_library": None,
        "prefs": {},              # small UI choices the user asked to remember
    }

    def __init__(self, path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._data = dict(self.DEFAULTS)
        self.load()

    def load(self):
        if not self.path.is_file():
            return
        try:
            stored = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(stored, dict):
            merged = dict(self.DEFAULTS)
            merged.update(stored)
            self._data = merged

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def get(self, key, default=None):
        with self._lock:
            return self._data.get(key, default if default is not None else self.DEFAULTS.get(key))

    def set(self, key, value):
        with self._lock:
            self._data[key] = value
            self.save()

    # -- remembered UI choices -------------------------------------------
    def get_pref(self, key, default=None):
        return self.get("prefs", {}).get(str(key), default)

    def set_pref(self, key, value):
        """Store one remembered answer. ``None`` forgets it, so that unticking
        "remember my choice" puts the question back."""
        with self._lock:
            prefs = dict(self._data.get("prefs", {}))
            if value is None:
                prefs.pop(str(key), None)
            else:
                prefs[str(key)] = value
            self._data["prefs"] = prefs
            self.save()

    # -- custom libraries ------------------------------------------------
    def add_library(self, path, name=None):
        path = str(Path(path))
        with self._lock:
            libraries = list(self._data.get("custom_libraries", []))
            if any(lib["path"] == path for lib in libraries):
                return False
            libraries.append({"path": path, "name": name or Path(path).name or path})
            self._data["custom_libraries"] = libraries
            self.save()
        return True

    def remove_library(self, path):
        path = str(Path(path))
        with self._lock:
            libraries = [lib for lib in self._data.get("custom_libraries", [])
                         if lib["path"] != path]
            changed = len(libraries) != len(self._data.get("custom_libraries", []))
            self._data["custom_libraries"] = libraries
            if changed:
                self.save()
        return changed

    # -- per game wiki entry --------------------------------------------
    def get_wiki_entry(self, game_path):
        if not game_path:
            return None
        return self.get("wiki_entries", {}).get(str(game_path))

    def set_wiki_entry(self, game_path, entry_name):
        with self._lock:
            entries = dict(self._data.get("wiki_entries", {}))
            if entry_name:
                entries[str(game_path)] = entry_name
            else:
                entries.pop(str(game_path), None)
            self._data["wiki_entries"] = entries
            self.save()

    # -- per game install target ----------------------------------------
    def get_target(self, game_path):
        return self.get("game_targets", {}).get(str(game_path))

    def set_target(self, game_path, target_dir):
        with self._lock:
            targets = dict(self._data.get("game_targets", {}))
            if target_dir:
                targets[str(game_path)] = str(target_dir)
            else:
                targets.pop(str(game_path), None)
            self._data["game_targets"] = targets
            self.save()
