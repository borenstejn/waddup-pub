// Line mode (`node chat.js --line`): the original waddup look. Messages are printed like normal
// terminal output above the input line, so the terminal's own scrollback and mouse selection
// keep working, and a one-line band at the bottom lists recent chats.
//
//   Olivier: see you tonight
//   Mum: Dinner on Sunday?            ← messages from other chats appear inline, with their name
//   [Olivier] > typing here_
//    1 Olivier   2 Mum   3 Football club ⚽  4 Sam             /<n> switch · /chats
//
// Same interface as ui.js (the full-screen mode), so chat.js can drive either.

import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { BAND_ROWS, createBand, layoutBand } from './band.js';
import { wrapText } from './ui.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BAND_CANDIDATES = 40; // chats offered to the band; it shows as many as fit

export function createLineUI({ onSubmit, onTab, onQuit, onFocus = () => {}, onActivity = () => {} }) {
  const out = (s) => process.stdout.write(s);
  const band = createBand();
  let rl = null;
  let started = false;
  let promptText = '';
  let title = '';
  let items = null; // chats for the band (most recent first), or null before connecting
  let bandWanted = true;
  let busy = null; // a picture being placed: other output waits for it
  let focused = null; // the terminal's last focus report (see ui.js): true, false, or null

  // ---- input ----
  // We ask the terminal where the cursor is (to place iTerm2 pictures) and to report focus
  // changes; both answers arrive as input, so they're taken out here before readline sees them.
  const keyStream = new PassThrough();
  const decoder = new StringDecoder('utf8');
  const cursorWaiters = [];
  function onData(chunk) {
    let s = decoder.write(chunk);
    if (cursorWaiters.length) {
      s = s.replace(/\x1b\[(\d+);(\d+)R/g, (m, row, col) => {
        const w = cursorWaiters.shift();
        if (!w) return m;
        w({ row: Number(row), col: Number(col) });
        return '';
      });
    }
    s = s.replace(/\x1b\[([IO])/g, (_, kind) => {
      focused = kind === 'I';
      if (focused) onActivity();
      onFocus(focused);
      return '';
    });
    if (s) keyStream.write(s);
  }
  function cursorPosition() {
    return new Promise((resolve) => {
      const done = (pos) => { clearTimeout(timer); resolve(pos); };
      const timer = setTimeout(() => {
        const i = cursorWaiters.indexOf(done);
        if (i >= 0) cursorWaiters.splice(i, 1);
        resolve(null);
      }, 500);
      cursorWaiters.push(done);
      out('\x1b[6n'); // "where is the cursor?"
    });
  }

  // ---- output ----
  // readline clears everything below the prompt when it redraws, so repaint the band after.
  function prompt(preserveCursor) {
    if (!rl) return;
    rl.prompt(preserveCursor);
    band.paint();
  }
  // Print above the input line without trashing what the user is typing.
  function print(text = '') {
    if (busy) return void busy.then(() => print(text));
    if (!started) return void out(text + '\n');
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    out(text + '\n');
    prompt(true);
  }
  // Text is wrapped here rather than by the terminal, so wrapped rows (and a message's own line
  // breaks) get the same indent as in full-screen mode and can't pose as another message. One
  // column is kept free so a full row never leaves the terminal in its pending-wrap state.
  // `text` and `hang` may be functions (see ui.js); printed output can't change later, so they're
  // worked out once, now. Text that works out as null isn't printed.
  const value = (v) => (typeof v === 'function' ? v() : v);
  const wrapped = (text, { message, hang } = {}) => {
    text = value(text);
    return text == null ? null : wrapText(String(text), Math.max(10, (process.stdout.columns || 80) - 1), { message, hang: value(hang) }).join('\n');
  };
  const printWrapped = (text, opts) => { const s = wrapped(text, opts); if (s != null) print(s); };

  // /clear: scroll everything above the prompt off the top of the screen, so it goes into the
  // terminal's scrollback (erasing with ESC[2J keeps it in some terminals and loses it in others),
  // then redraw the prompt on the top row. Only as many lines as there is output are scrolled, so
  // the scrollback doesn't fill with blank lines.
  async function clearScreen() {
    while (busy) await busy;
    busy = (async () => {
      readline.clearLine(process.stdout, 0);
      const pos = await cursorPosition();
      const bottom = (process.stdout.rows || 24) - (band.active ? BAND_ROWS : 0); // last row that scrolls
      const above = pos ? Math.min(bottom, Math.max(0, pos.row - 1)) : bottom;
      out(`\x1b[${bottom};1H${'\n'.repeat(above)}\x1b[H\x1b[J`);
      prompt(true); // also repaints the band
    })();
    await busy;
    busy = null;
  }

  // iTerm2 pictures: reserve the rows by printing blank lines, find where they start on screen,
  // and have the terminal paint the picture there. It then scrolls away with the text.
  async function paintImage(rows, image) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    out('\n'.repeat(rows) + `\x1b[${rows}A`);
    const pos = await cursorPosition();
    if (pos) out(image.paint(pos.row, 1) + `\x1b[${pos.row + rows};1H`);
    else out(`\x1b[${rows}B`);
    prompt(true);
  }

  // ---- band ----
  // As many of the most recent chats as fit on one line (the open chat always included),
  // ordered by their fixed number so entries don't jump around.
  function renderBand() {
    if (!band.active) return;
    const hint = '/<n> switch · /chats';
    if (!items?.length) return band.setLines([' No chats yet (history may still be syncing) · /to <phone number> to start one']);
    const ordered = [...items];
    const ci = ordered.findIndex((it) => it.current);
    if (ci > 0) ordered.unshift(ordered.splice(ci, 1)[0]);
    let shown = [];
    for (let k = 1; k <= ordered.length; k++) {
      const pick = ordered.slice(0, k).sort((a, b) => a.num - b.num);
      if (!layoutBand(pick, band.cols(), hint)) break;
      shown = pick;
    }
    band.setLines(layoutBand(shown, band.cols(), hint) || [' ']);
  }
  function updateBand() {
    if (items && bandWanted && started) band.enable();
    renderBand();
  }

  // ---- lifecycle ----
  function start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('waddup needs an interactive terminal');
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.resume();
    out('\x1b[?1004h'); // report focus in / out
    rl = readline.createInterface({
      input: keyStream,
      output: process.stdout,
      terminal: true,
      // readline can only append when completing, but "/to oli" → "/to Olivier" can change
      // case or match mid-name, so we rewrite the line ourselves.
      completer: (line, cb) => {
        cb(null, [[], line]);
        setImmediate(() => {
          const res = onTab(line);
          if (typeof res === 'string') setInput(res);
        });
      },
    });
    rl.setPrompt(promptText);
    rl.on('line', async (line) => {
      await onSubmit(line);
      prompt();
    });
    rl.on('SIGINT', onQuit);
    rl.on('close', onQuit);
    keyStream.on('keypress', () => { onActivity(); band.paint(); }); // readline redraws clear the band
    process.stdout.on('resize', () => {
      if (band.resize()) {
        renderBand();
        prompt(true);
      }
    });
    started = true;
    updateBand();
    prompt();
  }
  function stop() {
    if (!started) return;
    started = false;
    band.teardown(); // give the terminal its full scroll region back
    out('\x1b[?1004l');
    try { process.stdin.setRawMode(false); } catch {}
    out('\n');
  }
  function setInput(text) {
    rl.write(null, { ctrl: true, name: 'e' }); // to end of line
    rl.write(null, { ctrl: true, name: 'u' }); // delete it
    rl.write(text);
    band.paint();
  }

  return {
    mode: 'line',
    start,
    stop,
    log: (text, opts) => printWrapped(text, opts),
    async logRows(lines, image) { // pictures and the QR code: printed as they are, never wrapped
      if (!image) return print(lines.join('\n'));
      while (busy) await busy;
      busy = paintImage(lines.length, image);
      await busy;
      busy = null;
    },
    logFeed: (text, opts) => printWrapped(text, opts), // other chats' messages show inline, as they always did
    showChat(list) {
      print(wrapped(`${DIM}Now chatting with${RESET} ${title}`));
      const text = list.map((it) => (it.pre ? it.pre.join('\n') : wrapped(it.text, it))).filter((t) => t != null);
      if (text.length) print(text.join('\n'));
    },
    showFeed() {},
    clear: clearScreen,
    setPrompt(p) {
      if (p === promptText) return;
      promptText = p;
      if (rl) { rl.setPrompt(p); prompt(true); }
    },
    setTitle(t) { title = t; },
    setSidebar(list) { items = list; updateBand(); },
    toggleSidebar(on) {
      bandWanted = on ?? !bandWanted;
      if (bandWanted) updateBand();
      else band.disable();
      return bandWanted;
    },
    get sidebarOn() { return bandWanted; },
    setMouse: () => false,
    get mouseOn() { return false; },
    get focused() { return focused; },
    sidebarCapacity: () => BAND_CANDIDATES,
    chatWidth: () => (process.stdout.columns || 80) - 2,
    chatHeight: () => (process.stdout.rows || 24) - 4 - BAND_ROWS,
    setInput,
    write: out,
    render: renderBand,
    redraw() { renderBand(); prompt(true); },
    refresh() {}, // printed output stays as it was printed
  };
}
