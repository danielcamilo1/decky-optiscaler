/** Virtual-key code names, for the shortcuts OptiScaler listens to. */
export const VK_NAMES: Record<number, string> = {
  0x08: "Backspace", 0x09: "Tab", 0x0d: "Enter", 0x13: "Pause",
  0x14: "Caps Lock", 0x1b: "Esc", 0x20: "Space",
  0x21: "Page Up", 0x22: "Page Down", 0x23: "End", 0x24: "Home",
  0x25: "Left", 0x26: "Up", 0x27: "Right", 0x28: "Down",
  0x2c: "Print Screen", 0x2d: "Insert", 0x2e: "Delete",
  0x70: "F1", 0x71: "F2", 0x72: "F3", 0x73: "F4", 0x74: "F5", 0x75: "F6",
  0x76: "F7", 0x77: "F8", 0x78: "F9", 0x79: "F10", 0x7a: "F11", 0x7b: "F12",
  0x90: "Num Lock", 0x91: "Scroll Lock",
};

export function keyName(value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") return "unset";
  const text = String(value).trim().toLowerCase();
  if (text === "auto") return "default";
  const code = text.startsWith("0x") ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
  if (!Number.isFinite(code)) return String(value);
  if (code < 0) return "disabled";
  if (VK_NAMES[code]) return VK_NAMES[code];
  if (code >= 0x30 && code <= 0x5a) return String.fromCharCode(code);
  return `key 0x${code.toString(16)}`;
}
