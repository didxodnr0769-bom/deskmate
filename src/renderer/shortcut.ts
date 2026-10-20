import type React from 'react';

export function displayShortcut(shortcut: string): string {
  return shortcut.split('+').map((part) => ({ CommandOrControl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Space: 'Space', Return: '↵' }[part] || part)).join(' ');
}

export function shortcutFromEvent(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null;
  if (!(event.metaKey || event.ctrlKey || event.altKey)) return null;
  const keys: Record<string, string> = {
    Space: 'Space', Escape: 'Escape', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    Tab: 'Tab', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  let key = keys[event.code];
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) key = event.code;
  if (!key) return null;
  return [event.metaKey && 'Command', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
}
