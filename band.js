// A 1-line status band pinned to the bottom of the terminal.
//
// The terminal's scroll region is limited to rows 1..(rows-BAND_ROWS), so chat output and the
// readline prompt scroll above the band and the band itself never moves. Because the
// region still starts at row 1, lines scrolled off the top go into normal scrollback.

import { PURPLE, sgr } from './theme.js';

const ESC = '\x1b';
const BASE = `${ESC}[0m`; // terminal's own background and text colour
export const BAND_ROWS = 1;
const MIN_ROWS = 10; // below this the band is hidden (not enough room for chat)

const out = (s) => process.stdout.write(s);

export function createBand() {
  let enabled = false;
  let active = false; // region currently set up on screen
  let lines = ['', ''];

  const rows = () => process.stdout.rows || 24;
  const cols = () => process.stdout.columns || 80;
  const fits = () => process.stdout.isTTY && rows() >= MIN_ROWS;

  function setRegion() {
    // DECSTBM homes the cursor, so save/restore around it.
    out(`${ESC}7${ESC}[1;${rows() - BAND_ROWS}r${ESC}8`);
  }

  function activate() {
    if (active || !enabled || !fits()) return;
    // Make room: scroll the screen up so the cursor is above the band rows.
    out('\n'.repeat(BAND_ROWS) + `${ESC}[${BAND_ROWS}A`);
    setRegion();
    active = true;
    paint();
  }

  function deactivate() {
    if (!active) return;
    out(`${ESC}7${ESC}[r${ESC}[${rows() - BAND_ROWS + 1};1H${ESC}[0J${ESC}8`);
    active = false;
  }

  function paint() {
    if (!active) return;
    const r = rows();
    let s = `${ESC}7`;
    for (let i = 0; i < BAND_ROWS; i++) {
      s += `${ESC}[${r - BAND_ROWS + 1 + i};1H${BASE}${ESC}[2K${lines[i] || ''}${BASE}${ESC}[K${ESC}[0m`;
    }
    out(s + `${ESC}8`);
  }

  // Called after the terminal is resized; returns true if the caller should re-prompt.
  function resize() {
    if (!enabled) return false;
    if (!fits()) { deactivate(); return false; }
    if (!active) { activate(); return true; }
    setRegion();
    // Park the cursor on the last scrolling line so the prompt doesn't land in the band.
    out(`${ESC}[${rows() - BAND_ROWS};1H`);
    paint();
    return true;
  }

  return {
    get enabled() { return enabled; },
    get active() { return active; },
    cols,
    enable() { enabled = true; activate(); },
    disable() { enabled = false; deactivate(); },
    setLines(next) { lines = next; paint(); },
    paint,
    resize,
    teardown: deactivate,
  };
}

// ---- layout ----

const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/**
 * Lay out chat items over BAND_ROWS lines of `width` columns.
 * items: [{ num, name, unread, current }]
 * Returns the styled lines, or null if the items don't fit.
 */
export function layoutBand(items, width, hint = '') {
  const cells = items.map(formatItem);
  const lines = [];
  let line = ' ';
  for (const cell of cells) {
    const sep = line === ' ' ? '' : '  ';
    if (visibleLen(line) + sep.length + visibleLen(cell) > width - 1) {
      lines.push(line);
      if (lines.length === BAND_ROWS) return null;
      line = ' ' + cell;
    } else {
      line += sep + cell;
    }
  }
  lines.push(line);
  while (lines.length < BAND_ROWS) lines.push(' ');
  // Right-align the hint on the last line when there's room.
  const last = lines[BAND_ROWS - 1];
  const gap = width - visibleLen(last) - hint.length - 1;
  if (hint && gap >= 2) lines[BAND_ROWS - 1] = last + ' '.repeat(gap) + `${ESC}[38;5;244m${hint}${BASE}`;
  return lines;
}

// The name is bold while the chat has unread messages.
function formatItem({ num, name, unread, current }) {
  const short = name.length > 16 ? name.slice(0, 15) + '…' : name;
  if (current) return `${ESC}[1;48;5;${PURPLE};38;5;231m ${num} ${short} ${BASE}`;
  return `${sgr(PURPLE)}${num}${BASE} ${unread ? `${ESC}[1m${short}${BASE}` : short}`;
}
