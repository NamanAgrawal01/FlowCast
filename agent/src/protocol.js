export const HEARTBEAT_INTERVAL_MS = 3000;
export const FILE_CHUNK_SIZE = 24 * 1024;

export const KEY_ALIASES = {
  Enter: "enter",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Space: "space",
  Meta: process.platform === "win32" ? "command" : "command",
  Control: "control",
  Alt: "alt",
  Shift: "shift"
};

export const BUTTON_ALIASES = {
  left: "left",
  right: "right",
  middle: "middle"
};

export function mapKey(value) {
  if (!value) {
    return "";
  }

  if (KEY_ALIASES[value]) {
    return KEY_ALIASES[value];
  }

  if (value.length === 1) {
    return value.toLowerCase();
  }

  return String(value).toLowerCase();
}

export function mapModifiers(modifiers = []) {
  return modifiers.map((modifier) => mapKey(modifier)).filter(Boolean);
}
