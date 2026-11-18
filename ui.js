// Full-screen terminal UI: a chat list on the left, the chat window on the right, and an input
// line under the chat window. The app draws every row itself on the terminal's alternate screen
// (like htop or vim), so it keeps its own scrollback: the mouse wheel or Page Up / Page Down
// scroll, Esc jumps back down.
//
//                                           (top margin)
//    ╭─ Chats ────────────────╮ ╭─ Olivier · #2 ─────────────────────╮
//    │   2 Olivier            │ │ Olivier: see you tonight           │
//    │   7 Football club ⚽   │ │ me: on my way                      │
//    │   3 Mum                │ ╰──────────── ↓ 9 more lines below ──╯
//    ╰────────────────────────╯                         (bottom margin)
//                                 [Olivier] > typing here_
//
// Both windows sit in rounded frames with a margin around them and padding inside. The chat's
// name is in its top border, the "more below" marker in the bottom one. On very small
// terminals the frames are dropped (the list then gets a plain divider).
//
// Only rows whose content changed are rewritten, so typing redraws a single line.
//
// Wrapped rows, and every line of a message after its first, are indented (HANG, or the item's own
// `hang`), so text from WhatsApp can never start a row and pass itself off as another message.
//
// Focus: the terminal is asked to report when its window gains or loses focus (ESC[?1004h; most
// terminals do, tmux only with `focus-events on`). `focused` is null until the first report.
//
// Images: text-based ones (coloured blocks, Kitty placeholders) are ordinary rows. iTerm2-style
// images are painted by the terminal over blank rows; the UI remembers where each one sits and
// paints it again whenever it moves or its rows get redrawn. An image cut by the frame's edge
// can't be painted partially, so it shows a short note until it is fully in view.
//
// Mouse: the terminal's mouse reporting (SGR mode) is switched on, so the wheel scrolls the chat
// window and a click on the chat list opens that chat. Hold Shift (Option in iTerm2) to select
// text with the mouse as usual. Mouse codes are filtered out before key handling.

import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { ORANGE, PURPLE, sgr } from './theme.js';

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const LIST_WIDTH = 30;     // the chat list's frame, borders included
const SIDEBAR_WIDTH = 28;  // the unframed list on tiny terminals, divider included
const GAP = 1;             // blank column between the list and the chat window
const MIN_COLS_FOR_SIDEBAR = 70;
const MAX_ITEMS = 3000;    // lines kept per view
// Space around the frames, and inside them between the border and the text.
const MARGIN = { top: 1, right: 1, bottom: 1, left: 1 };
const PADDING = 1;

const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;  // report clicks and wheel, SGR coordinates
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;
const FOCUS_ON = `${ESC}[?1004h`; // report focus in / out as ESC [ I / ESC [ O
const FOCUS_OFF = `${ESC}[?1004l`;
const WHEEL_LINES = 3;

const value = (v) => (typeof v === 'function' ? v() : v);
const segmenter = new Intl.Segmenter();
const graphemes = (s) => Array.from(segmenter.segment(s), (x) => x.segment);

/** Cut an ANSI-coloured string to `width` columns. */
export function truncate(str, width) {
  if (stringWidth(str) <= width) return str;
  let out = '';
  let w = 0;
  for (const part of str.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith(ESC)) { out += part; continue; }
    for (const g of graphemes(part)) {
      const gw = stringWidth(g);
      if (w + gw > width) return out + RESET;
      out += g;
      w += gw;
    }
  }
  return out;
}
const pad = (str, width) => {
  const s = truncate(str, width);
  return s + ' '.repeat(Math.max(0, width - stringWidth(s)));
};
const B = (s) => `${DIM}${s}${RESET}`; // border colour

// Continuation rows are indented by this much, so a row can only start at the left edge where
// the app put it: a message's first row ("Name: …") or a line the app wrote itself. Without it,
// a message could wrap or break so that one of its rows reads "me: …" or "Mum: …".
export const HANG = 2;

/**
 * Wrap to `width`, keeping indentation the text has on purpose but dropping the space a line
 * was broken at. Rows that wrapping created are indented by `hang` columns; with `message`, so is every
 * line after the first (a message's own line breaks), so none of its text reaches the left edge.
 */
export function wrapText(text, width, { message = false, hang = HANG } = {}) {
  hang = width > hang + 1 ? hang : 0;
  const indent = ' '.repeat(hang);
  return text.split('\n').flatMap((paragraph, p) =>
    wrapAnsi(paragraph, width - hang, { hard: true, trim: false })
      .split('\n')
      .map((line, i) => {
        if (i > 0) return indent + line.replace(/^((?:\x1b\[[0-9;]*m)*) /, '$1');
        return message && p > 0 ? indent + line : line;
      }),
  );
}

function topBorder(width, title) {
  const inner = width - 2;
  if (!title || inner < 8) return B('╭' + '─'.repeat(inner) + '╮');
  const t = truncate(title, inner - 4);
  // ╭─␣title␣───╮  →  3 + title + 1 + fill + 1 = width
  return B('╭─ ') + t + RESET + ' ' + B('─'.repeat(Math.max(0, inner - 3 - stringWidth(t))) + '╮');
}
function bottomBorder(width, marker) {
  const inner = width - 2;
  if (!marker || inner < stringWidth(marker) + 6) return B('╰' + '─'.repeat(inner) + '╯');
  // ╰───␣marker␣──╯  →  1 + fill + 1 + marker + 4 (" ──╯") = width
  return B('╰' + '─'.repeat(inner - stringWidth(marker) - 4) + ' ') + sgr(ORANGE) + marker + RESET + B(' ──╯');
}

/** One chat in the list: "num name", exactly `width` columns. The name is bold while the chat has unread messages. */
function listEntry(item, width) {
  const num = String(item.num).padStart(3);
  const nameWidth = width - 4;
  let name = item.name;
  if (stringWidth(name) > nameWidth) name = truncate(name, nameWidth - 1).replace(/\x1b\[0m$/, '') + '…';
  const gap = ' '.repeat(Math.max(0, nameWidth - stringWidth(name)));
  if (item.unread) name = `${ESC}[1m${name}${ESC}[22m`;
  return { num, name, gap };
}

export function createUI({ onSubmit, onTab, onQuit, onPick, onFocus = () => {}, onActivity = () => {} }) {
  const out = (s) => process.stdout.write(s);
  const views = { feed: newView(), chat: newView() };
  let active = 'feed';
  let promptText = '';
  let title = ''; // shown in the chat window's top border
  let sidebarRows = null; // [{ num, name, unread, current }] or null when hidden
  let sidebarWanted = true;
  let started = false;
  let frame = []; // last drawn row strings, to only rewrite what changed
  let renderQueued = false;
  let mouseWanted = true;
  let focused = null; // the terminal's last focus report: true, false, or null (none yet)
  let painted = new Map(); // painted images: item -> { top, left, rows }
  let generation = 0;       // bumped by refresh(): every item's rows are worked out again

  // input line state
  let input = [];      // graphemes
  let cursor = 0;      // index into input
  let hscroll = 0;     // first visible grapheme
  let pasting = false;
  const history = [];
  let histPos = -1;
  let draft = null;

  function newView() {
    return { items: [], scroll: 0, unseen: 0 };
  }

  // ---- layout ----
  const rows = () => process.stdout.rows || 24;
  const cols = () => process.stdout.columns || 80;
  const sidebarShown = () => !!sidebarRows && sidebarWanted && cols() >= MIN_COLS_FOR_SIDEBAR;

  // Where everything goes. Columns and rows are 0-based.
  function geom() {
    const R = rows();
    const C = cols();
    const side = sidebarShown();
    const framed = R >= 12 && C - MARGIN.left - MARGIN.right - (side ? LIST_WIDTH + GAP : 0) >= 30;
    if (!framed) {
      // too small for frames: plain list with a divider, text uses the rest, input on the last row
      const left = side ? SIDEBAR_WIDTH + GAP : 0;
      return { side, framed: false, left, textLeft: left, textWidth: C - left, textTop: 0, height: R - 1, inputLeft: left, inputWidth: C - left };
    }
    const top = MARGIN.top; // top border row of both frames
    const bottom = R - 1 - MARGIN.bottom - 1; // bottom border row (the input line is the last row)
    const listLeft = MARGIN.left;
    const frameLeft = side ? listLeft + LIST_WIDTH + GAP : MARGIN.left;
    const frameWidth = C - MARGIN.right - frameLeft;
    const textLeft = frameLeft + 1 + PADDING;
    const textWidth = frameWidth - 2 - 2 * PADDING;
    return { side, framed: true, listLeft, frameLeft, frameWidth, top, bottom, textLeft, textWidth, textTop: top + 1, height: bottom - top - 1, inputLeft: textLeft, inputWidth: textWidth };
  }
  const chatWidth = () => geom().textWidth;
  const chatHeight = () => geom().height;
  // rows available for chats in the list
  const sidebarCapacity = () => {
    const g = geom();
    return g.framed ? g.height : rows() - 1;
  };

  // ---- chat window ----
  // All display rows of a view at this width, each with the item it belongs to.
  // An item's `text` and `hang` may be functions, worked out when the item is drawn (so a
  // setting such as /timestamp can change lines already on screen; see refresh()). Text that
  // works out as null takes no rows at all.
  function displayRows(view, width) {
    const all = [];
    for (const item of view.items) {
      if (item.w !== width || item.gen !== generation) {
        const text = value(item.text);
        item.rows = item.pre
          ? item.pre.map((l) => truncate(l, width))
          : text == null ? [] : wrapText(String(text), width, { message: item.message, hang: value(item.hang) });
        item.w = width;
        item.gen = generation;
      }
      item.rows.forEach((text, idx) => all.push({ text, item, idx }));
    }
    return all;
  }

  function chatRows(g) {
    const view = views[active];
    const height = g.height;
    const all = displayRows(view, g.textWidth);
    const maxScroll = Math.max(0, all.length - height);
    view.scroll = Math.min(view.scroll, maxScroll);
    const end = all.length - view.scroll;
    const visible = all.slice(Math.max(0, end - height), end);
    while (visible.length < height) visible.unshift({ text: '' }); // messages sit at the bottom, like a chat app

    // Painted images: only when every row of the image is in view.
    const images = [];
    const shownRows = new Map();
    visible.forEach((r) => r.item?.image && shownRows.set(r.item, (shownRows.get(r.item) || 0) + 1));
    let noted = new Set();
    visible.forEach((r, i) => {
      if (!r.item?.image) return;
      if (shownRows.get(r.item) === r.item.rows.length) {
        if (r.idx === 0) images.push({ item: r.item, row: i });
        r.text = '';
      } else {
        r.text = noted.has(r.item) ? '' : `${DIM}[image · scroll to see it]${RESET}`;
        noted.add(r.item);
      }
    });

    let marker = '';
    if (view.scroll > 0) {
      const more = view.unseen ? `${view.unseen} new · ` : '';
      marker = `↓ ${more}${view.scroll} more line${view.scroll === 1 ? '' : 's'} below · PgDn / Esc`;
      if (!g.framed) visible[height - 1] = { text: `${DIM}── ${marker} ──${RESET}` };
    }
    return { visible: visible.map((r) => r.text), images, marker };
  }

  // ---- chat list ----
  // Framed list: one row of the frame (top border, a chat, or bottom border).
  function listFrameRow(i, g) {
    if (i === g.top) return topBorder(LIST_WIDTH, `${sgr(PURPLE)}Chats${RESET}`);
    if (i === g.bottom) return B('╰' + '─'.repeat(LIST_WIDTH - 2) + '╯');
    const inner = LIST_WIDTH - 2;
    const item = sidebarRows[i - g.top - 1];
    if (!item) return B('│') + ' '.repeat(inner) + B('│');
    const { num, name, gap } = listEntry(item, inner - 2 * PADDING);
    const p = ' '.repeat(PADDING);
    const body = item.current
      ? `${ESC}[1;48;5;${PURPLE};38;5;231m${p}${num} ${name}${gap}${p}${RESET}`
      : `${p}${sgr(PURPLE)}${num}${RESET} ${name}${gap}${p}`;
    return B('│') + pad(body, inner) + RESET + B('│');
  }
  // Unframed list (tiny terminals): header, chats, and a divider on the right.
  function listPlainCell(i) {
    const inner = SIDEBAR_WIDTH - 1;
    const sep = B('│');
    if (i === 0) return pad(` ${sgr(PURPLE)}Chats${RESET}`, inner) + sep;
    const item = sidebarRows[i - 1];
    if (!item) return ' '.repeat(inner) + sep;
    const { num, name, gap } = listEntry(item, inner - 2);
    const body = item.current
      ? `${ESC}[1;48;5;${PURPLE};38;5;231m ${num} ${name}${gap} ${RESET}`
      : ` ${sgr(PURPLE)}${num}${RESET} ${name}${gap} `;
    return pad(body, inner) + RESET + sep;
  }

  // ---- input line ----
  function inputLine(width) {
    const avail = Math.max(5, width - stringWidth(promptText) - 1);
    const shown = (g) => (g === '\n' ? '↵' : g);
    const widthOf = (from, to) => input.slice(from, to).reduce((n, g) => n + stringWidth(shown(g)), 0);
    if (cursor < hscroll) hscroll = cursor;
    while (widthOf(hscroll, cursor) >= avail) hscroll++;
    let text = '';
    let w = 0;
    for (let i = hscroll; i < input.length; i++) {
      const g = shown(input[i]);
      const gw = stringWidth(g);
      if (w + gw > avail) break;
      text += g === '↵' && input[i] === '\n' ? `${DIM}↵${RESET}` : g;
      w += gw;
    }
    const lead = hscroll > 0 ? `${DIM}…${RESET}` : '';
    return { line: promptText + lead + text, cursorCol: stringWidth(promptText) + (hscroll > 0 ? 1 : 0) + widthOf(hscroll, cursor) + 1 };
  }

  // ---- drawing ----
  function composeRows(g, visible, marker, line) {
    const R = rows();
    const C = cols();
    const next = [];
    for (let i = 0; i < R; i++) {
      if (i === R - 1) {
        const lead = g.side && !g.framed ? pad(listPlainCell(i), SIDEBAR_WIDTH) + RESET + ' '.repeat(GAP) : ' '.repeat(g.inputLeft);
        next.push(lead + pad(line, C - g.inputLeft) + RESET);
        continue;
      }
      if (!g.framed) {
        const lead = g.side ? pad(listPlainCell(i), SIDEBAR_WIDTH) + RESET + ' '.repeat(GAP) : '';
        next.push(lead + pad(visible[i], C - g.textLeft) + RESET);
        continue;
      }
      if (i < g.top || i > g.bottom) {
        next.push(' '.repeat(C));
        continue;
      }
      const lead = g.side ? ' '.repeat(g.listLeft) + listFrameRow(i, g) + ' '.repeat(GAP) : ' '.repeat(g.frameLeft);
      let body;
      if (i === g.top) body = topBorder(g.frameWidth, title);
      else if (i === g.bottom) body = bottomBorder(g.frameWidth, marker);
      else {
        const p = ' '.repeat(PADDING);
        body = B('│') + p + pad(visible[i - g.textTop], g.textWidth) + RESET + p + B('│');
      }
      next.push(lead + body + ' '.repeat(C - g.frameLeft - g.frameWidth) + RESET);
    }
    return next;
  }

  function render() {
    renderQueued = false;
    if (!started) return;
    const R = rows();
    const g = geom();
    const { visible, images, marker } = chatRows(g);
    const { line, cursorCol } = inputLine(g.inputWidth);
    const next = composeRows(g, visible, marker, line);

    // Where painted images go this time. An image that moved or disappeared must have its old
    // rows rewritten, so the old picture is cleared.
    const placements = new Map(images.map(({ item, row }) => [item, { top: g.textTop + row, left: g.textLeft, rows: item.rows.length }]));
    for (const [item, old] of painted) {
      const now = placements.get(item);
      if (!now || now.top !== old.top || now.left !== old.left) {
        for (let r = old.top; r < old.top + old.rows; r++) frame[r] = null;
      }
    }

    let s = `${ESC}[?2026h${ESC}[?25l`; // synchronized update (ignored where unsupported), hide cursor
    const rewritten = new Set();
    for (let i = 0; i < R; i++) {
      if (frame[i] !== next[i]) {
        s += `${ESC}[${i + 1};1H${next[i]}${RESET}`;
        rewritten.add(i);
      }
    }
    for (const [item, p] of placements) {
      const old = painted.get(item);
      let dirty = !old || old.top !== p.top || old.left !== p.left;
      for (let r = p.top; !dirty && r < p.top + p.rows; r++) dirty = rewritten.has(r);
      if (dirty) s += item.image.paint(p.top + 1, p.left + 1); // 1-based screen position
    }
    painted = placements;
    frame = next;
    s += `${ESC}[${R};${g.inputLeft + Math.min(cursorCol, g.inputWidth)}H${ESC}[?25h${ESC}[?2026l`;
    out(s);
  }
  function schedule() {
    if (renderQueued) return;
    renderQueued = true;
    setImmediate(render);
  }
  function redrawAll() {
    if (!started) return;
    frame = [];
    painted = new Map();
    out(`${ESC}[2J`);
    render();
  }

  // ---- content ----
  function push(view, item) {
    view.items.push(item);
    if (view.items.length > MAX_ITEMS) view.items.splice(0, view.items.length - MAX_ITEMS);
    if (view.scroll > 0) {
      // keep the reader's place while new lines arrive below
      const added = displayRows({ items: [item] }, chatWidth()).length;
      view.scroll += added;
      view.unseen += 1;
    }
    schedule();
  }

  // ---- keys ----
  function setInput(text) {
    input = graphemes(text);
    cursor = input.length;
    schedule();
  }
  function insert(text) {
    const g = graphemes(text.replace(/\r\n?/g, '\n'));
    input.splice(cursor, 0, ...g);
    cursor += g.length;
  }
  function scrollBy(n) {
    const view = views[active];
    const total = displayRows(view, chatWidth()).length;
    view.scroll = Math.max(0, Math.min(total - chatHeight(), view.scroll + n));
    if (view.scroll === 0) view.unseen = 0;
  }
  function wordLeft(i) {
    while (i > 0 && /\s/.test(input[i - 1])) i--;
    while (i > 0 && !/\s/.test(input[i - 1])) i--;
    return i;
  }

  function onKey(str, key = {}) {
    onActivity();
    const name = key.name;
    if (name === 'paste-start') { pasting = true; return; }
    if (name === 'paste-end') { pasting = false; return schedule(); }
    if (key.ctrl && name === 'c') return onQuit();
    if (key.ctrl && name === 'd' && !input.length) return onQuit();
    if (key.ctrl && name === 'l') return redrawAll();

    if (name === 'return' || name === 'enter') {
      if (pasting) { insert('\n'); return schedule(); }
      const text = input.join('');
      if (text.trim()) {
        history.push(text);
        if (history.length > 200) history.shift();
      }
      histPos = -1;
      draft = null;
      input = [];
      cursor = 0;
      hscroll = 0;
      scrollBy(-Infinity);
      schedule();
      return onSubmit(text);
    }
    if (name === 'tab') {
      const res = onTab(input.join(''));
      if (typeof res === 'string') setInput(res);
      return schedule();
    }
    if (name === 'pageup') { scrollBy(chatHeight() - 2); return schedule(); }
    if (name === 'pagedown') { scrollBy(-(chatHeight() - 2)); return schedule(); }
    if (name === 'escape') { scrollBy(-Infinity); return schedule(); }
    if (name === 'backspace' && (key.meta || key.ctrl)) { const to = wordLeft(cursor); input.splice(to, cursor - to); cursor = to; }
    else if (name === 'backspace') { if (cursor > 0) input.splice(--cursor, 1); }
    else if (name === 'delete') input.splice(cursor, 1);
    else if (name === 'left' && (key.meta || key.ctrl)) cursor = wordLeft(cursor);
    else if (name === 'left') cursor = Math.max(0, cursor - 1);
    else if (name === 'right') cursor = Math.min(input.length, cursor + 1);
    else if (name === 'home' || (key.ctrl && name === 'a')) cursor = 0;
    else if (name === 'end' || (key.ctrl && name === 'e')) cursor = input.length;
    else if (key.ctrl && name === 'u') { input.splice(0, cursor); cursor = 0; }
    else if (key.ctrl && name === 'k') input.splice(cursor);
    else if (key.ctrl && name === 'w') { const to = wordLeft(cursor); input.splice(to, cursor - to); cursor = to; }
    else if (name === 'up' || name === 'down') {
      if (!history.length) return;
      if (histPos === -1) { draft = input.join(''); histPos = history.length; }
      histPos = Math.max(0, Math.min(history.length, histPos + (name === 'up' ? -1 : 1)));
      setInput(histPos === history.length ? draft : history[histPos]);
      if (histPos === history.length) histPos = -1;
    } else if (str && !key.ctrl && !key.meta && !/^[\x00-\x1f\x7f]$/.test(str)) {
      insert(str);
    } else return;
    schedule();
  }

  // ---- mouse ----
  // SGR mouse report: ESC [ < button ; column ; row M (press) or m (release), 1-based.
  function onMouse(button, x, y, press) {
    onActivity();
    const b = button & ~(4 | 8 | 16); // ignore Shift / Alt / Ctrl bits
    if (b === 64 || b === 65) {
      scrollBy(b === 64 ? WHEEL_LINES : -WHEEL_LINES);
      return schedule();
    }
    if (b !== 0 || !press || !sidebarShown() || !onPick) return; // only left-button presses on the list
    const g = geom();
    const cx = x - 1;
    const cy = y - 1;
    let item;
    if (g.framed) {
      if (cx > g.listLeft && cx < g.listLeft + LIST_WIDTH - 1 && cy > g.top && cy < g.bottom) item = sidebarRows[cy - g.top - 1];
    } else if (cx < SIDEBAR_WIDTH && cy >= 1) {
      item = sidebarRows[cy - 1]; // row 0 is the "Chats" header
    }
    if (item) onPick(item.num);
  }

  // Pull mouse reports out of the raw input; everything else goes on to the key parser.
  const keyStream = new PassThrough();
  const decoder = new StringDecoder('utf8');
  let pendingInput = '';
  function onData(chunk) {
    let s = pendingInput + decoder.write(chunk);
    pendingInput = '';
    s = s.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_, b, x, y, kind) => {
      onMouse(Number(b), Number(x), Number(y), kind === 'M');
      return '';
    });
    s = s.replace(/\x1b\[([IO])/g, (_, kind) => {
      focused = kind === 'I';
      if (focused) onActivity();
      onFocus(focused);
      return '';
    });
    const partial = /\x1b\[(?:<[\d;]*)?$/.exec(s); // a mouse or focus report split across two reads
    if (partial) {
      pendingInput = partial[0];
      s = s.slice(0, partial.index);
    }
    if (s) keyStream.write(s);
  }

  // ---- lifecycle ----
  function start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('waddup needs an interactive terminal');
    }
    readline.emitKeypressEvents(keyStream);
    keyStream.on('keypress', onKey);
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.resume();
    process.stdout.on('resize', redrawAll);
    out(`${ESC}[?1049h${ESC}[?2004h${FOCUS_ON}${ESC}[2J${mouseWanted ? MOUSE_ON : ''}`); // alternate screen, bracketed paste, focus reports
    started = true;
    render();
  }
  function stop() {
    if (!started) return;
    started = false;
    try { process.stdin.setRawMode(false); } catch {}
    out(`${MOUSE_OFF}${FOCUS_OFF}${ESC}[?2004l${ESC}[?25h${RESET}${ESC}[?1049l`);
  }

  return {
    mode: 'full',
    start,
    stop,
    /**
     * Append text (may contain colours and newlines) to the visible window. `message`: it is a
     * chat message, so its own line breaks are indented too (see wrapText).
     */
    log(text, { message = false, hang } = {}) { push(views[active], { text: typeof text === 'function' ? text : String(text), message, hang }); },
    /**
     * Append rows that must not be re-wrapped (images, QR code). With `image`
     * ({ paint(row, col) → escape string }), the rows are blank space the terminal paints over.
     */
    logRows(lines, image) { push(views[active], { pre: lines, image }); },
    /** Also append to the all-chats feed when another view is showing. */
    logFeed(text, { message = false, hang } = {}) { if (active !== 'feed') push(views.feed, { text: typeof text === 'function' ? text : String(text), message, hang }); },
    showChat(items) {
      views.chat = newView();
      for (const it of items) views.chat.items.push(it);
      active = 'chat';
      schedule();
    },
    showFeed() { active = 'feed'; views.feed.scroll = 0; views.feed.unseen = 0; schedule(); },
    /** Empty the window that is showing (the feed or the open chat). Only the screen: nothing saved is touched. */
    clear() { views[active] = newView(); schedule(); },
    setPrompt(p) { promptText = p; schedule(); },
    setTitle(t) { title = t; schedule(); },
    setSidebar(items) { sidebarRows = items; schedule(); },
    toggleSidebar(on) { sidebarWanted = on ?? !sidebarWanted; redrawAll(); return sidebarWanted; },
    get sidebarOn() { return sidebarWanted; },
    setMouse(on) {
      mouseWanted = on ?? !mouseWanted;
      if (started) out(mouseWanted ? MOUSE_ON : MOUSE_OFF);
      return mouseWanted;
    },
    get mouseOn() { return mouseWanted; },
    /** Whether the terminal window has focus: true / false, or null if it never said. */
    get focused() { return focused; },
    sidebarCapacity,
    chatWidth,
    chatHeight,
    setInput,
    write: out, // raw output (image uploads)
    render: schedule,
    redraw: redrawAll,
    /** Work out every line again (text or hang given as functions) and redraw. */
    refresh() { generation++; schedule(); },
  };
}
