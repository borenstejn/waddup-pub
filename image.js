// Render an image buffer (jpeg/png/webp/gif…) as rows of text for the chat window.
//
// Modes:
//   kitty  – real images via the Kitty graphics protocol's "Unicode placeholders" (kitty ≥ 0.28,
//            Ghostty). The picture is uploaded once; it is then drawn wherever special
//            placeholder characters are printed, so it scrolls and redraws like normal text.
//   iterm  – real images via iTerm2's inline image protocol (iTerm2, WezTerm). The terminal
//            paints the picture over blank rows; the UI repaints it whenever it moves.
//   blocks – coloured half-block characters, works in any terminal (truecolor)
//   blocks256 – the same with 256 colours (e.g. macOS Terminal)
//   off    – no images
// Override with WA_IMG=kitty|iterm|blocks|blocks256|off.
//
// Inside tmux (3.3+) image sequences go through tmux's passthrough, which we switch on for our
// own pane (allow-passthrough). Kitty placeholders are plain text, so tmux handles them like any
// other character. For iTerm2 the cursor move is sent inside the passthrough too (tmux would
// otherwise paint at its own cursor), offset by where our pane sits on the screen.

import sharp from 'sharp';
import { execFileSync } from 'node:child_process';

const IN_TMUX = !!process.env.TMUX;

// Pictures come from anyone who can message you, so decoding is bounded: one that claims more
// pixels than this is refused rather than decompressed (32 MP is far above any phone photo).
const MAX_PIXELS = 32e6;
const open = (buf) => sharp(buf, { limitInputPixels: MAX_PIXELS });
// The raster formats WhatsApp sends, and the extension each is saved under.
const EXT_BY_FORMAT = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };
export const IMAGE_EXTENSIONS = Object.values(EXT_BY_FORMAT);

/**
 * What `buf` really is, judged by its bytes rather than by what the sender said. Returns the
 * extension to save it under; throws for anything that isn't one of the formats above or that
 * would be too big to decode.
 */
export async function imageExtension(buf) {
  let meta;
  try {
    meta = await open(buf).metadata(); // enforces MAX_PIXELS from the header alone
  } catch (err) {
    throw new Error(/pixel limit/i.test(err?.message) ? 'too big to decode' : 'not an image');
  }
  const ext = EXT_BY_FORMAT[meta.format];
  if (!ext) throw new Error(`unsupported image type (${meta.format || 'unknown'})`);
  return ext;
}

function tmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// The terminal tmux is running in: its TERM plus, when it answered tmux's query, its name/version.
function tmuxOuterTerminal() {
  try {
    return tmux(['display-message', '-p', '#{client_termname} #{client_termtype}']).toLowerCase();
  } catch {
    return '';
  }
}

let passthroughOn = false;
function enableTmuxPassthrough(env) {
  if (passthroughOn) return true;
  try {
    tmux(['set-option', '-p', ...(env.TMUX_PANE ? ['-t', env.TMUX_PANE] : []), 'allow-passthrough', 'on']);
    passthroughOn = true;
  } catch {
    // tmux older than 3.3: no passthrough
  }
  return passthroughOn;
}

const isKitty = (env, outer = '') =>
  env.TERM === 'xterm-kitty' || !!env.KITTY_WINDOW_ID || env.TERM === 'xterm-ghostty' || env.TERM_PROGRAM === 'ghostty' || /kitty|ghostty/.test(outer);
const isITerm = (env, outer = '') =>
  env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.LC_TERMINAL === 'iTerm2' || /iterm|wezterm/.test(outer);

export function detectMode(env = process.env) {
  let mode = (env.WA_IMG || '').toLowerCase();
  if (!mode) {
    if (env.TMUX) {
      const outer = tmuxOuterTerminal();
      mode = isKitty(env, outer) ? 'kitty' : isITerm(env, outer) ? 'iterm' : 'blocks';
    } else if ((env.TERM || '').startsWith('screen')) mode = 'blocks'; // GNU screen swallows graphics
    else if (isKitty(env)) mode = 'kitty';
    else if (isITerm(env)) mode = 'iterm';
    else if (env.TERM_PROGRAM === 'Apple_Terminal' && !/truecolor|24bit/i.test(env.COLORTERM || '')) mode = 'blocks256';
    else mode = 'blocks';
  }
  if ((mode === 'kitty' || mode === 'iterm') && env.TMUX && !enableTmuxPassthrough(env)) mode = 'blocks';
  return mode;
}

// Where our tmux pane starts on the real screen (0-based), for iTerm2 images. Cached; reset when
// the terminal is resized (which is also what happens when panes are split or resized).
let paneOffset = null;
process.stdout.on('resize', () => { paneOffset = null; });
function tmuxPaneOffset() {
  if (paneOffset) return paneOffset;
  paneOffset = { row: 0, col: 0 };
  try {
    const target = process.env.TMUX_PANE ? ['-t', process.env.TMUX_PANE] : [];
    const [top, left, status, position] = tmux(['display-message', '-p', ...target, '#{pane_top} #{pane_left} #{status} #{status-position}']).split(' ');
    const statusLines = status === 'off' ? 0 : status === 'on' ? 1 : Number(status) || 0;
    paneOffset = { row: Number(top) + (position === 'top' ? statusLines : 0), col: Number(left) };
  } catch {}
  return paneOffset;
}

/**
 * @param {Buffer} buf  image bytes
 * @param {{ mode?: string, maxCols?: number, maxRows?: number }} opts
 * @returns {Promise<{ lines: string[], upload: string, image?: { paint(row, col): string } }>}
 *   `lines`: the rows to print. `upload`: escape sequence to write to the terminal once
 *   before the rows are shown (kitty only; empty otherwise). `image` (iterm only): the rows are
 *   blank and `paint(row, col)` gives the sequence that draws the picture at that 1-based
 *   screen position.
 */
export async function renderImage(buf, { mode = detectMode(), maxCols = 60, maxRows = 30 } = {}) {
  if (mode === 'off') return { lines: [], upload: '' };
  const meta = await open(buf).metadata();
  const w = meta.width || 1;
  const h = meta.pageHeight || meta.height || 1; // pageHeight: first frame of animated webp/gif
  if (mode === 'kitty') maxRows = Math.min(maxRows, ROW_DIACRITICS.length);

  // Terminal cells are roughly twice as tall as they are wide.
  let cols = Math.min(maxCols, w);
  let rows = Math.ceil((cols * h) / w / 2);
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.max(1, Math.round((rows * 2 * w) / h));
  }

  if (mode === 'kitty') {
    // Downscale big photos so we don't push megabytes of base64 through the tty.
    const png = await open(buf).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return kittyPlaceholders(png.toString('base64'), cols, rows);
  }

  if (mode === 'iterm') {
    // Sized for the cells it fills (it's sent again on every repaint, so keep it small):
    // JPEG for photos, PNG when there's transparency (stickers).
    const fitted = open(buf).resize({ width: cols * 12, height: rows * 24, fit: 'inside', withoutEnlargement: true });
    const data = meta.hasAlpha ? await fitted.png().toBuffer() : await fitted.jpeg({ quality: 82 }).toBuffer();
    const osc = `\x1b]1337;File=inline=1;size=${data.length};width=${cols};height=${rows};preserveAspectRatio=1:${data.toString('base64')}\x07`;
    const paint = (row, col) => {
      if (!IN_TMUX) return `\x1b[${row};${col}H${osc}`;
      const o = tmuxPaneOffset();
      return tmuxWrap(`\x1b[${row + o.row};${col + o.col}H${osc}`);
    };
    return { lines: Array(rows).fill(' '.repeat(cols)), upload: '', image: { paint } };
  }

  // Half blocks: each cell shows two vertical pixels ('▀' fg = top, bg = bottom).
  const { data, info } = await open(buf)
    .resize({ width: cols, height: rows * 2, fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const color = mode === 'blocks256' ? ansi256 : truecolor;
  const px = (x, y) => {
    if (y >= info.height) return null;
    const i = (y * info.width + x) * 4;
    return data[i + 3] < 128 ? null : [data[i], data[i + 1], data[i + 2]];
  };
  const lines = [];
  for (let y = 0; y < info.height; y += 2) {
    let line = '';
    for (let x = 0; x < info.width; x++) {
      const top = px(x, y);
      const bot = px(x, y + 1);
      if (top && bot) line += `${color(38, top)}${color(48, bot)}▀`;
      else if (top) line += `\x1b[49m${color(38, top)}▀`;
      else if (bot) line += `\x1b[49m${color(38, bot)}▄`;
      else line += '\x1b[0m ';
    }
    lines.push(line + '\x1b[0m');
  }
  return { lines, upload: '' };
}

// tmux passthrough: DCS "tmux;" + the sequence with every ESC doubled + ST.
const tmuxWrap = (seq) => `\x1bPtmux;${seq.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;

// Kitty "Unicode placeholder" images. The image is uploaded with a virtual placement (U=1)
// under an id; each cell of the picture is then the character U+10EEEE, coloured with the id
// (as a 256-colour index) and marked with combining diacritics for its row and column. Cells
// after the first in a row inherit row and column+1, so only the first cell needs diacritics.
// These are the first entries of kitty's diacritics table (hence at most 30 rows).
const PLACEHOLDER = '\u{10EEEE}';
const ROW_DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a,
  0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365,
  0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f,
].map((cp) => String.fromCodePoint(cp));
// Ids 16..255: a 256-colour index tmux passes through unchanged (0-15 may be rewritten as basic colours).
let nextImageId = 16;

function kittyPlaceholders(b64, cols, rows) {
  const id = nextImageId;
  nextImageId = nextImageId >= 255 ? 16 : nextImageId + 1;
  let upload = '';
  for (let i = 0; i < b64.length; i += 4096) {
    const more = i + 4096 < b64.length ? 1 : 0;
    const ctrl = i === 0 ? `a=T,U=1,i=${id},f=100,q=2,c=${cols},r=${rows},m=${more}` : `m=${more}`;
    const seq = `\x1b_G${ctrl};${b64.slice(i, i + 4096)}\x1b\\`;
    upload += IN_TMUX ? tmuxWrap(seq) : seq;
  }
  const lines = [];
  for (let r = 0; r < rows; r++) {
    lines.push(`\x1b[38;5;${id}m${PLACEHOLDER}${ROW_DIACRITICS[r]}${ROW_DIACRITICS[0]}${PLACEHOLDER.repeat(cols - 1)}\x1b[39m`);
  }
  return { lines, upload };
}

const truecolor = (layer, [r, g, b]) => `\x1b[${layer};2;${r};${g};${b}m`;
function ansi256(layer, [r, g, b]) {
  // Use the grey ramp for near-greys, the 6x6x6 cube otherwise.
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    const grey = Math.round(((r + g + b) / 3 - 8) / 10);
    const idx = grey < 0 ? 16 : grey > 23 ? 231 : 232 + grey;
    return `\x1b[${layer};5;${idx}m`;
  }
  const q = (v) => Math.round((v / 255) * 5);
  return `\x1b[${layer};5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m`;
}
