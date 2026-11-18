#!/usr/bin/env node
// waddup: a small WhatsApp chat client for the terminal (links as a WhatsApp Web device via Baileys).
//
//   node chat.js                 -> link by scanning a QR code
//   node chat.js --pair 4479...  -> link with an 8-char pairing code instead
//   node chat.js --line          -> line mode (see below); also WA_UI=line
//
// Two looks, chosen at start:
//   full screen (default): your chats on the left, the open chat on the right, input below it.
//     With no chat open, the chat window is a live feed of all incoming messages.
//   line mode (--line): messages print like normal terminal output with a one-line chat band at
//     the bottom; the terminal's own scrollback and selection work. (ui-line.js)
//
// Commands:
//   /chats [n|all]       list recent chats (numbered), 25 by default
//   /to <n|name|number>  open chat #n (as shown in the sidebar / /chats), a chat name, or a
//                        phone number. Tab after "/to " completes chat names.
//   /<n>                 shortcut for /to <n>, e.g. /3
//   /show [n]            display the latest (or nth latest) image/sticker in the current chat
//   /images ...          on | off | <width in columns> | kitty | iterm | blocks | blocks256
//   /sidebar             show/hide the chat list
//   /mouse               turn mouse support (wheel scrolling, click to open a chat) on/off
//   /timestamp [on|off]  show/hide message times and date lines (on by default)
//   /renumber            renumber all chats 1..n by most recent activity
//   /whois               show the ids and known names of the current chat
//   /clear               clear the window (the feed or the open chat); nothing saved is deleted
//   /help                show commands
//   /logout              unlink this device and delete the session, store and media (asks to confirm)
//   /exit                leave the current chat (back to the feed); the app keeps running
//   /quit                quit the app (session is kept in ./auth)
// Anything else is sent as a text message to the current chat.
// Keys: PgUp/PgDn or the mouse wheel scroll, Esc back to the newest messages, ↑/↓ previous
//       inputs, Tab completes, Ctrl-C quits, Ctrl-L redraws. Click a chat in the list to open it;
//       hold Shift (Option in iTerm2) to select text with the mouse.
//
// Incoming images and stickers are drawn inline and saved to ./media: only real JPEG/PNG/WebP/GIF
// files up to 16 MB, named by a hash of the message's key, with the extension of what their bytes
// are rather than the sender's mimetype.
// Chats, names, chat numbers and the last 50 messages per chat are kept in ./store.json.
// Messages show their time, with a date line when the day changes. Opening a chat marks it read;
// while it's open, new messages are marked read only while you're there (window focus, or a key or
// click). See "read receipts" below.
// Text and names from WhatsApp are stripped of control characters and escape sequences before
// they are stored or shown (clean() in store.js); names are also kept to one line (cleanLine()),
// and a message's continuation rows are indented, so nothing from WhatsApp can start a row and
// pose as another message. Local files are created readable by this user only.
// Env: WA_IMG=kitty|iterm|blocks|blocks256|off to force a render mode, WA_IMG_WIDTH=<cols>,
//      WA_SIDEBAR=off to start without the chat list, WA_MOUSE=off to start without mouse support,
//      WA_TIMESTAMPS=off to start without message times, WA_DEBUG=1 to log library output to ./debug.log.

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  jidNormalizedUser,
  normalizeMessageContent,
  toNumber,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { appendFileSync, chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { IMAGE_EXTENSIONS, detectMode, imageExtension, renderImage } from './image.js';
import { createUI } from './ui.js';
import { createLineUI } from './ui-line.js';
import { Store, clean, cleanLine } from './store.js';
import { ORANGE, PURPLE, RED, sgr } from './theme.js';

const AUTH_DIR = new URL('./auth', import.meta.url).pathname;
const MEDIA_DIR = new URL('./media', import.meta.url).pathname;
const STORE_FILE = new URL('./store.json', import.meta.url).pathname;
const DEBUG_FILE = new URL('./debug.log', import.meta.url).pathname;

// Local data is private: files created from here on are readable by this user only, and anything
// left by an earlier version (or a looser umask) is tightened on every start.
process.umask(0o077);
function tighten(path) {
  try {
    if (!statSync(path).isDirectory()) return chmodSync(path, 0o600);
    chmodSync(path, 0o700);
    for (const d of readdirSync(path, { withFileTypes: true })) chmodSync(join(path, d.name), d.isDirectory() ? 0o700 : 0o600);
  } catch {} // doesn't exist yet
}
for (const p of [AUTH_DIR, MEDIA_DIR, STORE_FILE, DEBUG_FILE]) tighten(p);
const logger = pino({ level: 'silent' });
const pairIdx = process.argv.indexOf('--pair');
const pairNumber = pairIdx > -1 ? (process.argv[pairIdx + 1] || '').replace(/\D/g, '') : null;
if (pairIdx > -1 && !pairNumber) {
  console.error('Usage: node chat.js --pair <phone number in international format, e.g. 447911123456>');
  process.exit(1);
}

// Libraries (libsignal in particular) print to the console, which would scribble over the
// full-screen layout. Send that to ./debug.log when WA_DEBUG is set, otherwise drop it.
const realConsoleError = console.error.bind(console);
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  console[k] = (...args) => {
    if (!process.env.WA_DEBUG) return;
    try { appendFileSync(DEBUG_FILE, `${new Date().toISOString()} [${k}] ${args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4 }))).join(' ')}\n`, { mode: 0o600 }); } catch {}
  };
}

// ---------- state ----------
const store = new Store(STORE_FILE);
const sentIds = new Set();  // ids of messages sent from this CLI
const lidLookups = new Set(); // LIDs we already asked Baileys to resolve
let current = null;         // jid of the open chat (null: the all-chats feed)
let sock;
let pairingRequested = false;
let imgMode = detectMode();                               // how images are drawn
let imgAuto = imgMode !== 'off';                          // auto-show incoming images
let imgWidth = Number(process.env.WA_IMG_WIDTH) || 50;    // max width in terminal columns
let showTimes = process.env.WA_TIMESTAMPS !== 'off';     // message times + date lines (/timestamp)

// ---------- terminal UI ----------
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  me: (s) => `${sgr(RED)}${s}\x1b[0m`,          // MY_RED
  accent: (s) => `${sgr(PURPLE)}${s}\x1b[0m`,   // MY_PURPLE
  warn: (s) => `${sgr(ORANGE)}${s}\x1b[0m`,     // MY_ORANGE
  red: (s) => `\x1b[31m${s}\x1b[0m`,            // errors
};
const LINE_MODE = process.argv.includes('--line') || process.env.WA_UI === 'line';
const ui = (LINE_MODE ? createLineUI : createUI)({
  onSubmit: (line) => handleLine(line).catch((err) => print(c.red(`Error: ${err.message}`))),
  onTab: completeInput,
  onQuit: () => process.exit(0),
  onPick: (num) => { if (sock?.user) switchTo(String(num)).catch((err) => print(c.red(`Error: ${err.message}`))); },
  // You're at the keyboard (a key, a click, or the window got focus): the open chat is read.
  onActivity: () => { if (current) markRead(current); },
});
if (process.env.WA_SIDEBAR === 'off') ui.toggleSidebar(false);
if (process.env.WA_MOUSE === 'off') ui.setMouse(false);

const print = (text = '', opts) => ui.log(text, opts);
// ---------- times ----------
// Each message starts with its time ("14:02 "); a dim line with the date goes in whenever the day
// changes. Shown in this computer's time zone, 24-hour.
const TIME_WIDTH = 6; // "HH:MM "
const pad2 = (n) => String(n).padStart(2, '0');
const nowTs = () => Math.floor(Date.now() / 1000);
const timeOf = (ts) => { const d = new Date((ts || nowTs()) * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const dayOf = (ts) => new Date((ts || nowTs()) * 1000).toDateString();
function daySeparator(ts) {
  const d = new Date((ts || nowTs()) * 1000);
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return c.dim(`── ${d.toLocaleDateString(undefined, opts)} ──`);
}
// The day of the last message shown in each window, so a separator goes in when it changes.
// Line mode prints everything in one stream, so it only uses `chat`.
const shownDay = { chat: null, feed: null };
const windowNow = () => (ui.mode === 'line' || current ? 'chat' : 'feed');

// Print a chat message: its own line breaks are indented, and wrapped rows line up under the
// sender's name, after the time (see wrapText in ui.js). Lines are given to the UI as functions,
// worked out when drawn, so /timestamp can add or remove times and date lines already on screen
// (in full-screen mode; line mode prints them once).
const MESSAGE = { message: true, hang: () => (showTimes ? TIME_WIDTH : undefined) }; // undefined: the UI's usual indent
const dateLine = (ts) => () => (showTimes ? daySeparator(ts) : null); // null: takes no room
const messageLine = (jid, e, withChat) => () => formatEntry(jid, e, withChat);
function printMessage(jid, e, { withChat = false, toFeed = false } = {}) {
  const win = toFeed && ui.mode !== 'line' ? 'feed' : windowNow();
  const out = toFeed ? (text, opts) => ui.logFeed(text, opts) : print;
  if (shownDay[win] !== dayOf(e.ts)) {
    shownDay[win] = dayOf(e.ts);
    out(dateLine(e.ts));
  }
  out(messageLine(jid, e, withChat), MESSAGE);
}
function setPrompt() {
  ui.setPrompt(current ? c.accent(`[${nameOf(current)}] > `) : c.dim('[all chats] > '));
  // the frame's title: chat name, its number, and whether it's a group
  if (!current) return ui.setTitle(c.accent('All chats'));
  const num = store.peekNumber(current);
  ui.setTitle(c.accent(nameOf(current)) + c.dim(`${num ? ` · #${num}` : ''}${isJidGroup(current) ? ' · group' : ''}`));
}

// ---------- helpers ----------
const isUserChat = (jid) => jid && !isJidBroadcast(jid) && !isJidNewsletter(jid);
const phoneOf = (jid) => (jid?.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0].split(':')[0] : null);
function nameOf(jid) {
  if (!jid) return '?';
  const canon = store.canon(jid);
  const name = store.nameOf(canon);
  if (name) return name;
  if (phoneOf(canon)) return phoneOf(canon);
  if (isLidUser(canon)) return `unknown (${canon.split('@')[0].slice(-4)})`;
  if (isJidGroup(canon)) return 'unnamed group';
  return canon.split('@')[0];
}

// Ask Baileys (which keeps LID↔phone pairs in ./auth) for the phone number behind LIDs.
function resolveLids(jids) {
  const lids = [...new Set(jids.filter((j) => j && isLidUser(j) && !lidLookups.has(j)))];
  const repo = sock?.signalRepository?.lidMapping;
  if (!lids.length || !repo?.getPNsForLIDs) return;
  lids.forEach((l) => lidLookups.add(l));
  repo
    .getPNsForLIDs(lids)
    .then((pairs) => (pairs || []).forEach(({ lid, pn }) => store.learn(lid, pn)))
    .catch(() => {});
}

// The text shown for a message, with anything a terminal could act on stripped (see clean()).
function textOf(message) {
  const text = rawTextOf(message);
  return text == null ? null : clean(text) || null;
}
function rawTextOf(message) {
  const m = normalizeMessageContent(message);
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return `[image]${m.imageMessage.caption ? ' ' + m.imageMessage.caption : ''}`;
  if (m.videoMessage) return `[video]${m.videoMessage.caption ? ' ' + m.videoMessage.caption : ''}`;
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (m.documentMessage) return `[document] ${m.documentMessage.fileName || ''}`.trim();
  if (m.stickerMessage) return '[sticker]';
  if (m.locationMessage) return '[location]';
  if (m.contactMessage) return `[contact] ${m.contactMessage.displayName || ''}`.trim();
  if (m.reactionMessage) return m.reactionMessage.text ? `[reacted ${m.reactionMessage.text}]` : null;
  if (m.pollCreationMessage || m.pollCreationMessageV3) return `[poll] ${(m.pollCreationMessage || m.pollCreationMessageV3).name}`;
  if (m.protocolMessage || m.senderKeyDistributionMessage) return null; // internal noise
  return null;
}

// Store a message; returns the stored entry (or null if it carries nothing displayable).
function record(msg) {
  const k = msg?.key;
  if (!k || !isUserChat(k.remoteJid)) return null;
  // v7 tells us the "other" id of the chat / sender: learn LID ↔ phone pairs from it.
  store.learn(k.remoteJid, k.remoteJidAlt);
  store.learn(k.participant, k.participantAlt);
  const text = textOf(msg.message);
  if (!text) return null;
  const jid = store.canon(k.remoteJid);
  const senderJid = k.fromMe ? null : store.canon(k.participant || k.remoteJid);
  if (!k.fromMe && msg.pushName) store.setName(senderJid, 'push', msg.pushName);
  resolveLids([jid, senderJid]);
  const content = normalizeMessageContent(msg.message);
  const media = content?.imageMessage ? { imageMessage: content.imageMessage } : content?.stickerMessage ? { stickerMessage: content.stickerMessage } : null;
  const ts = toNumber(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
  const entry = {
    id: k.id,
    rj: k.remoteJid, // the chat id as WhatsApp sent it (needed to request older messages)
    p: k.participant || undefined, // in groups: the sender as WhatsApp sent it (needed for read receipts)
    ts,
    fromMe: !!k.fromMe,
    senderJid,
    text,
    sticker: !!content?.stickerMessage,
    // keep what's needed to download images/stickers later (also after a restart)
    msg: media ? { key: { remoteJid: k.remoteJid, id: k.id, fromMe: !!k.fromMe, participant: k.participant }, message: media } : undefined,
  };
  if (!store.addEntry(jid, entry)) return null;
  return { jid, ...entry };
}

function formatEntry(jid, e, withChat) {
  const time = showTimes ? c.dim(timeOf(e.ts)) + ' ' : '';
  const who = e.fromMe ? c.me('me') : c.bold(nameOf(e.senderJid || jid));
  // In the all-chats feed: say which chat ("Group | Sam:"), or just the name for a 1:1 chat.
  if (withChat && isJidGroup(jid)) return `${time}${c.warn(nameOf(jid))}${c.dim(' | ')}${who}: ${e.text}`;
  if (withChat && !e.fromMe) return `${time}${c.warn(nameOf(jid))}: ${e.text}`;
  return `${time}${who}: ${e.text}`;
}

// ---------- read receipts ----------
// A chat's unread messages are marked read when you open it, and while it's open, when you're
// there: a key or click, or the terminal window getting focus. New messages in the open chat are
// marked read straight away only while the window has focus (if the terminal reports it); until
// then they count as unread, so a chat you leave without reading stays bold. Baileys sends
// receipts the way your WhatsApp privacy setting says: with read receipts off, only your own
// devices learn the chat was read, and senders get no blue ticks.
function markRead(jid) {
  const chat = store.chats.get(jid);
  if (!sock?.user || !chat?.unread) return;
  const n = chat.unread;
  chat.unread = 0;
  store.changed();
  const keys = (store.history.get(jid) || [])
    .filter((e) => !e.fromMe && e.id)
    .slice(-n) // the newest n are the unread ones
    .map((e) => ({ remoteJid: e.rj || jid, id: e.id, participant: e.p, fromMe: false }))
    .filter((k) => !isJidGroup(k.remoteJid) || k.participant); // group messages saved before `p` existed can't be receipted
  if (keys.length) sock.readMessages(keys).catch((err) => console.error('read receipts failed', err)); // → debug log
}
// A message for the open chat raises its unread count (chats.update) and is stored
// (messages.upsert): two events in either order, so look once both are in.
let readTimer;
function readIfFocused() {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => { if (current && ui.focused === true) markRead(current); }, 300);
}

// ---------- images ----------
// Pictures come from anyone who can message you, so what gets downloaded, decoded and kept is
// bounded: at most MEDIA_MAX_BYTES (WhatsApp's own limit for images), and only bytes that sharp
// recognises as a plain raster image are saved, under the extension of that real format.
const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

// Reads a stream into a buffer, giving up as soon as it goes past `max` bytes.
async function readCapped(stream, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw new Error(`more than ${Math.round(max / 1048576)} MB`); // leaving the loop destroys the stream
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The file a message's picture is kept under (without extension). Its id alone won't do: the
// sender's app picks it, so it can repeat another chat's id or be anything at all (after
// stripping unsafe characters, an empty id would have named the file ./media.jpg, outside
// ./media). A hash of the whole key is unique per message and always a plain name inside ./media.
function mediaBase(key) {
  const fields = [key.remoteJid, key.participant || '', key.fromMe ? 1 : 0, key.id].map((v) => String(v ?? ''));
  return join(MEDIA_DIR, createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 32));
}

async function getMedia(msg) {
  const content = normalizeMessageContent(msg.message);
  const media = content.imageMessage || content.stickerMessage;
  const base = mediaBase(msg.key);
  for (const ext of IMAGE_EXTENSIONS) {
    const file = `${base}.${ext}`;
    if (existsSync(file)) return { buf: await readFile(file), file };
  }
  const claimed = toNumber(media.fileLength) || 0;
  if (claimed > MEDIA_MAX_BYTES) throw new Error(`${(claimed / 1048576).toFixed(1)} MB, more than the ${MEDIA_MAX_BYTES / 1048576} MB limit`);
  // reuploadRequest asks your phone to re-upload media whose download link has expired.
  const stream = await downloadMediaMessage(msg, 'stream', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  const buf = await readCapped(stream, MEDIA_MAX_BYTES); // the claimed size isn't trusted
  const file = `${base}.${await imageExtension(buf)}`; // throws unless it really is an image
  await mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
  await writeFile(file, buf, { mode: 0o600 });
  return { buf, file };
}

async function showImage(entry) {
  try {
    const { buf, file } = await getMedia(entry.msg);
    const img = await renderImage(buf, {
      mode: imgMode,
      maxCols: Math.min(entry.sticker ? Math.min(imgWidth, 24) : imgWidth, ui.chatWidth() - 2),
      maxRows: Math.max(5, Math.min(entry.sticker ? 12 : 30, ui.chatHeight() - 3)),
    });
    if (img.upload) ui.write(img.upload); // kitty: send the picture once; the rows below display it
    if (img.lines.length) await ui.logRows(img.lines, img.image); // img.image: iTerm2 pictures the screen paints
    if (!entry.sticker) print(c.dim(`  saved: ${relative(process.cwd(), file)}`));
  } catch (err) {
    print(c.red(`  (couldn't load image: ${clean(err.message)})`));
  }
}

// Live messages are shown through a queue so an image always appears right
// under its own message line, even while the next message is arriving.
let outQueue = Promise.resolve();
const enqueue = (fn) => (outQueue = outQueue.then(fn).catch(() => {}));

// ---------- chat numbers + sidebar ----------
const recentChats = () =>
  [...store.chats.values()].filter((ch) => isUserChat(ch.jid) && !store.communities.has(ch.jid)).sort((a, b) => b.lastTs - a.lastTs);

// The most recently active chats that fit, newest first (the open chat always included).
// Numbers stay fixed: a chat keeps its number wherever it appears in the list.
function renderSidebar() {
  if (!sock?.user) return ui.setSidebar(null);
  const cap = Math.max(1, ui.sidebarCapacity());
  const shown = recentChats().slice(0, cap);
  if (current && !shown.some((ch) => ch.jid === current)) shown[Math.min(shown.length, cap - 1)] = store.chat(current);
  ui.setSidebar(
    shown.map((ch) => ({
      num: store.numberOf(ch.jid), // numbers become permanent once shown
      name: nameOf(ch.jid),
      unread: ch.jid === current ? 0 : ch.unread || 0,
      current: ch.jid === current,
    })),
  );
}
let sidebarTimer;
function scheduleSidebar() {
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(() => {
    renderSidebar();
    setPrompt(); // names may have arrived for the open chat
  }, 100);
}
store.onChange = scheduleSidebar;
store.onMerge = (from, to) => {
  if (current === from) {
    current = to;
    setPrompt();
  }
};
process.stdout.on('resize', renderSidebar); // more or fewer rows for chats

// ---------- chat names: matching + tab completion ----------
// Case- and accent-insensitive: "yoann" matches "Yoann", "cafe" matches "Café".
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Chats whose name starts with `query`, or has a word starting with it; most recent first. */
function matchChats(query) {
  const q = fold(query.trim());
  const out = [];
  for (const ch of recentChats()) {
    const name = nameOf(ch.jid);
    const f = fold(name);
    const prefix = f.startsWith(q);
    if (prefix || f.split(/[\s\-_.,()'’]+/).some((w) => w.startsWith(q))) out.push({ jid: ch.jid, name, prefix });
  }
  return out;
}
const listMatches = (matches) =>
  matches.slice(0, 12).map((x) => `${store.numberOf(x.jid)} ${x.name}`).join(' · ') +
  (matches.length > 12 ? ` · … ${matches.length - 12} more` : '');

// Tab after "/to ": complete a chat name. Returns the new input line, or undefined.
function completeInput(line) {
  const m = /^\/to\s+(.*)$/i.exec(line);
  if (!m) return undefined;
  const query = m[1];
  const matches = matchChats(query);
  if (!matches.length) return void print(c.dim(`No chat matches "${query}".`));
  if (matches.length === 1) return `/to ${matches[0].name}`;
  print(c.dim(listMatches(matches)));
  if (matches.every((x) => x.prefix)) {
    // Extend to the longest prefix all matches share, e.g. "ma" → "Mar" for Marc / Marie.
    const folded = matches.map((x) => fold(x.name));
    let n = 0;
    while (folded.every((f) => n < f.length && f[n] === folded[0][n])) n++;
    if (n > fold(query).length) return `/to ${matches[0].name.slice(0, n)}`;
  }
  return undefined;
}

// ---------- commands ----------
function showHelp() {
  print(
    [
      c.bold('Commands:'),
      '  /chats [n|all]       list recent chats (25 by default)',
      '  /to <n|name|number>  open a chat: its number, a name (Tab completes it), or a phone number',
      '  /<n>                 shortcut for /to <n>, e.g. /3',
      '  /show [n]            view the latest (or nth latest) image in this chat',
      `  /images ...          on | off | <width> | kitty | iterm | blocks | blocks256  (now: ${imgAuto ? 'on' : 'off'}, ${imgMode}, ${imgWidth} cols)`,
      `  /sidebar             show/hide the chat list (now: ${ui.sidebarOn ? 'on' : 'off'})`,
      `  /mouse               mouse wheel scrolling + click to open a chat (now: ${ui.mouseOn ? 'on' : 'off'})`,
      `  /timestamp [on|off]  show/hide message times and date lines (now: ${showTimes ? 'on' : 'off'})`,
      '  /renumber            renumber chats 1..n by most recent activity',
      '  /whois               ids and known names of this chat',
      '  /clear               clear the window (nothing saved is deleted)',
      '  /logout              unlink this device and delete local data (asks to confirm)',
      '  /exit                leave this chat (back to the all-chats feed)',
      '  /quit                quit the app',
      '  anything else        send as a message to this chat',
      ...(ui.mode === 'full'
        ? [c.bold('Keys:') + ' PgUp/PgDn or wheel scroll · Esc newest · ↑/↓ previous inputs · Tab complete · Ctrl-C quit',
           c.bold('Mouse:') + ' click a chat to open it · hold Shift (Option in iTerm2) to select text']
        : [c.dim('Line mode. Start without --line for the full-screen layout.')]),
    ].join('\n'),
  );
}

function listChats(arg) {
  const all = recentChats();
  const limit = arg === 'all' ? all.length : Number(arg) || 25;
  const top = all.slice(0, limit);
  if (!top.length) return print(c.dim('No chats yet. Use /to <phone number> to start one.'));
  top.forEach((ch) => store.numberOf(ch.jid)); // unnumbered chats get numbers in recency order
  const lines = top.map((ch) => {
    const last = store.history.get(ch.jid)?.at(-1);
    const preview = last ? c.dim(` — ${last.fromMe ? 'me: ' : ''}${last.text.replace(/\s+/g, ' ').slice(0, 40)}`) : '';
    const grp = isJidGroup(ch.jid) ? c.dim(' (group)') : '';
    const name = ch.unread && ch.jid !== current ? c.bold(nameOf(ch.jid)) : nameOf(ch.jid); // bold: unread messages
    return `${String(store.numberOf(ch.jid)).padStart(3)}. ${name}${grp}${preview}`;
  });
  if (all.length > top.length) lines.push(c.dim(`  … ${all.length - top.length} more, /chats all to see everything`));
  print(lines.join('\n'));
  renderSidebar();
}

// The chat window's contents for a chat: its saved messages (the newest `limit`), with a date line
// wherever the day changes (its name is in the frame's title).
function chatItems(jid, limit = Infinity) {
  const list = (store.history.get(jid) || []).slice(-limit);
  shownDay.chat = null;
  if (!list.length) return [{ text: c.dim('(no messages saved for this chat yet)') }];
  const items = [];
  for (const e of list) {
    if (shownDay.chat !== dayOf(e.ts)) {
      shownDay.chat = dayOf(e.ts);
      items.push({ text: dateLine(e.ts) });
    }
    items.push({ text: messageLine(jid, e, false), ...MESSAGE });
  }
  return items;
}

// Line mode: { jid, held, left } while a chat's older messages are fetched before it's printed in
// one go. Its new messages are held back meanwhile (they'll be part of it); if you move on before
// it's printed, they're shown the way other chats' messages are.
let opening = null;
function leaveOpening() {
  if (!opening) return;
  const { held } = opening;
  opening.left = true;
  opening = null;
  held.forEach((e) => printMessage(e.jid, e, { withChat: true, toFeed: true }));
}
async function switchTo(arg) {
  if (!arg) return print(c.red('Usage: /to <n|name|phone number>  (Tab completes names)'));
  let target;
  if (/^\d{1,4}$/.test(arg)) {
    target = store.jidOf(Number(arg));
    if (!target) return print(c.red(`No chat #${arg}. Pick a number from the list or /chats.`));
  } else if (/\p{L}/u.test(arg)) {
    // A name: an exact match wins, otherwise it must match exactly one chat.
    const exact = matchChats(arg).filter((x) => fold(x.name) === fold(arg.trim()));
    const found = exact.length ? exact : matchChats(arg);
    if (!found.length) return print(c.red(`No chat named "${arg}". Try Tab after /to to see matches.`));
    if (found.length > 1) return print(c.warn(`Several chats match "${arg}": `) + c.dim(listMatches(found)) + c.warn(' Use the number.'));
    target = found[0].jid;
  } else {
    const digits = arg.replace(/\D/g, '');
    if (digits.length < 7) return print(c.red('Give a chat number from the list or /chats, or a full phone number with country code.'));
    try {
      const [res] = await sock.onWhatsApp(digits);
      if (!res?.exists) return print(c.red(`+${digits} is not on WhatsApp.`));
      target = store.canon(res.jid);
    } catch (err) {
      return print(c.red(`Lookup failed: ${err.message}`));
    }
  }
  leaveOpening();
  current = target;
  const chat = store.chat(current);
  if (!chat.lastTs) chat.lastTs = Math.floor(Date.now() / 1000);
  markRead(current);
  store.numberOf(current);
  setPrompt();
  renderSidebar();
  const opened = current;
  if (ui.mode === 'line') {
    // printed output can't be redrawn, so fetch older messages first and print the chat once
    const op = (opening = { jid: opened, held: [], left: false });
    try {
      await ensureHistory(current, 25);
    } finally {
      if (opening === op) opening = null;
    }
    if (!op.left && current === opened) ui.showChat(chatItems(current, 25));
    return;
  }
  ui.showChat(chatItems(current));
  if (await ensureHistory(current, Math.max(25, ui.chatHeight())) && current === opened) ui.showChat(chatItems(current));
}

// If fewer than `want` messages are saved, ask the phone for older ones (it must be online).
// They arrive as an on-demand history sync; we wait up to a few seconds for them.
// Resolves true if older messages arrived.
const historyWaiters = new Map(); // chat jid -> resolve()
const historyRequested = new Set(); // ask at most once per chat per session
async function ensureHistory(jid, want) {
  const list = store.history.get(jid) || [];
  if (list.length >= want || !list.length || historyRequested.has(jid)) return false;
  historyRequested.add(jid);
  const oldest = list[0];
  let got = false;
  const arrived = new Promise((resolve) => {
    historyWaiters.set(jid, () => { got = true; resolve(); });
    setTimeout(resolve, 6000);
  });
  print(c.dim('Fetching older messages from your phone…'));
  try {
    await sock.fetchMessageHistory(50, { remoteJid: oldest.rj || jid, id: oldest.id, fromMe: oldest.fromMe }, oldest.ts * 1000);
    await arrived;
  } catch {
    // not fatal: just show what we have
  } finally {
    historyWaiters.delete(jid);
  }
  return got;
}

async function showCmd(arg) {
  if (!current) return print(c.red('No chat open. Use /to <n> first.'));
  const images = (store.history.get(current) || []).filter((e) => e.msg);
  const n = Number(arg) || 1;
  const entry = images[images.length - n];
  if (!entry) return print(c.dim(images.length ? `Only ${images.length} image(s) saved in this chat.` : 'No images saved for this chat.'));
  printMessage(current, entry); // with its date if that's not the day on screen
  await showImage(entry);
}

function timestampCmd(arg) {
  const a = arg.toLowerCase();
  if (a && a !== 'on' && a !== 'off') return print(c.red('Usage: /timestamp [on|off]'));
  showTimes = a ? a === 'on' : !showTimes;
  if (ui.mode === 'line') shownDay.chat = null; // printed lines stay as they are; the next message brings its date line
  ui.refresh(); // full screen: times and date lines appear / disappear on everything shown
  print(c.dim(`Timestamps ${showTimes ? 'on' : 'off'}.`));
}

function imagesCmd(arg) {
  const a = arg.toLowerCase();
  if (a === 'on') imgAuto = true;
  else if (a === 'off') imgAuto = false;
  else if (/^\d+$/.test(a)) imgWidth = Math.max(8, Number(a));
  else if (['kitty', 'iterm', 'blocks', 'blocks256'].includes(a)) imgMode = detectMode({ ...process.env, WA_IMG: a });
  else if (a) return print(c.red('Usage: /images on|off|<width>|kitty|iterm|blocks|blocks256'));
  print(c.dim(`Images: auto-show ${imgAuto ? 'on' : 'off'}, mode ${imgMode}, width ${imgWidth} cols`));
}

function whois() {
  if (!current) return print(c.red('No chat open.'));
  const lids = [...store.lidToPn].filter(([, pn]) => pn === current).map(([lid]) => lid);
  const n = store.names.get(current) || {};
  print(
    [
      `${c.bold(nameOf(current))}  #${store.peekNumber(current) ?? '-'}`,
      `  id:    ${current}${lids.length ? `  (also ${lids.join(', ')})` : ''}`,
      ...Object.entries(n).map(([k, v]) => `  ${(k + ':').padEnd(6)} ${v}`),
    ].join('\n'),
  );
}

function leaveChat() {
  if (!current) return print(c.dim('Not in a chat. Use /quit to leave the app.'));
  const name = nameOf(current);
  leaveOpening();
  current = null;
  ui.showFeed();
  setPrompt();
  renderSidebar();
  print(c.dim(`Left ${name}.`));
}

// A message that is just a command word ("whois", "chats", …) is almost always a missing slash.
const COMMAND_WORDS = new Set(['help', 'chats', 'to', 'show', 'images', 'sidebar', 'mouse', 'renumber', 'whois', 'clear', 'timestamp', 'logout', 'quit', 'exit']);
let heldBack = null;
async function send(text) {
  if (COMMAND_WORDS.has(text.toLowerCase()) && heldBack !== text) {
    heldBack = text;
    return print(c.warn(`Not sent: did you mean /${text.toLowerCase()}? Type "${text}" again to send it as a message.`));
  }
  heldBack = null;
  if (!current) return print(c.red('No chat open. Use /to <n>, /to <name> or /to <phone number>.'));
  const to = current;
  try {
    const sent = await sock.sendMessage(to, { text });
    if (sent?.key?.id) sentIds.add(sent.key.id);
    record(sent); // usually already stored by Baileys' own event; this keeps history in sync
    if (current === to && ui.mode === 'full') printMessage(to, { fromMe: true, text, ts: nowTs() }); // line mode: it's on screen already
  } catch (err) {
    print(c.red(`Send failed: ${err.message}`));
  }
}

function wipeAndExit(message, code) {
  store.destroy();
  rmSync(AUTH_DIR, { recursive: true, force: true });
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  rmSync(DEBUG_FILE, { force: true });
  ui.stop();
  realConsoleError(message);
  process.exit(code);
}

async function handleLine(raw) {
  const line = raw.trim();
  if (!line) return;
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');
  if (cmd.startsWith('/') && ui.mode === 'full') print(c.dim(`› ${line}`)); // echo commands so their output has context
  if (!sock?.user && !['/quit', '/exit', '/help', '/clear', '/timestamp', '/timestamps'].includes(cmd)) return print(c.dim('Not connected yet…'));
  switch (cmd) {
    case '/help': return showHelp();
    case '/chats': return listChats(arg);
    case '/to': return switchTo(arg);
    case '/show': return showCmd(arg);
    case '/images': return imagesCmd(arg);
    case '/whois': return whois();
    case '/timestamp':
    case '/timestamps': return timestampCmd(arg);
    case '/clear': // the screen only: the store, the chat list and unread chats are untouched
      shownDay[windowNow()] = null; // the next message brings its date line back
      return ui.clear();
    case '/renumber':
      store.renumber(recentChats().map((ch) => ch.jid));
      renderSidebar();
      return print(c.dim('Chats renumbered by most recent activity.'));
    case '/sidebar':
    case '/band': {
      const on = ui.toggleSidebar(arg === 'on' ? true : arg === 'off' ? false : undefined);
      return print(c.dim(`Chat list ${on ? 'shown' : 'hidden'}.`));
    }
    case '/mouse': {
      if (ui.mode === 'line') return print(c.dim('Mouse support is part of the full-screen mode (start without --line).'));
      const on = ui.setMouse(arg === 'on' ? true : arg === 'off' ? false : undefined);
      return print(c.dim(on ? 'Mouse on: wheel scrolls, click a chat to open it (Shift-drag to select text).' : 'Mouse off: the terminal handles selection; scroll with PgUp/PgDn.'));
    }
    case '/logout':
      // Destructive and one line away from a typo: ask for the word "confirm" on the same line.
      if (arg !== 'confirm') return print(c.warn('This unlinks the device and deletes ./auth, ./store.json and ./media. Type /logout confirm to go ahead.'));
      await sock.logout().catch(() => {});
      return wipeAndExit('Logged out; session, store and media deleted.', 0);
    case '/exit': return leaveChat();
    case '/quit': return process.exit(0);
    default:
      if (/^\/\d{1,4}$/.test(cmd)) return switchTo(cmd.slice(1));
      if (cmd.startsWith('/')) return print(c.red(`Unknown command ${cmd}. Try /help`));
      return send(line);
  }
}

process.on('exit', () => {
  try { store.flush(); } catch {}
  ui.stop(); // leave the full-screen mode and give the terminal back
});
process.on('uncaughtException', (err) => {
  ui.stop();
  realConsoleError(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => console.error('unhandled rejection', err)); // → debug log

// ---------- WhatsApp connection ----------
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS('Desktop'), // "Desktop" gets a larger history sync
    syncFullHistory: false,
    markOnlineOnConnect: false,          // so your phone keeps getting notifications
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !pairNumber) {
      print(c.bold('Scan this QR in WhatsApp → Settings → Linked devices → Link a device:'));
      qrcode.generate(qr, { small: true }, (q) => ui.logRows(q.split('\n')));
    }
    if (qr && pairNumber && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(pairNumber);
        print(c.bold(`Pairing code: ${code.match(/.{1,4}/g).join('-')}`));
        print('On your phone: WhatsApp → Linked devices → Link a device → "Link with phone number instead".');
      } catch (err) {
        print(c.red(`Could not get pairing code: ${err.message}`));
      }
    }
    if (connection === 'open') {
      const me = sock.user;
      renderSidebar();
      print(c.me(`Connected as ${cleanLine(me?.name)} (${phoneOf(jidNormalizedUser(me?.id)) || me?.id}). Type /help.`));
      // History arrives in the first seconds after linking; only nag if it never came.
      setTimeout(() => {
        const n = recentChats().length;
        if (n < 5) print(c.warn(`Only ${n} chat(s) known. WhatsApp sends the full chat list only when a device is linked: /logout, then run again and re-link to fetch it.`));
      }, 15000).unref();
      setPrompt();
      // Fill in group names and phone numbers behind LIDs for chats we already know.
      sock.groupFetchAllParticipating()
        .then((groups) => Object.values(groups || {}).forEach((g) => {
          store.setName(g.id, 'subject', g.subject);
          if (g.isCommunity) store.setCommunity(g.id); // the community itself; its groups stay listed
        }))
        .catch(() => {});
      resolveLids([...store.chats.keys(), ...store.names.keys()]);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        // Garde la raison du refus (wipeAndExit efface debug.log).
        appendFileSync(new URL('./logout-reason.log', import.meta.url).pathname,
          `${new Date().toISOString()} ${inspect(lastDisconnect?.error, { depth: 6 })}\n`, { mode: 0o600 });
        wipeAndExit('Session was logged out from the phone. Deleted ./auth, ./store.json and ./media — run again to re-link.', 1);
      }
      // restartRequired (515) is normal right after linking; everything else: retry.
      if (code !== DisconnectReason.restartRequired) print(c.dim(`Connection closed (${code ?? 'unknown'}), reconnecting…`));
      pairingRequested = false;
      setTimeout(connect, code === DisconnectReason.restartRequired ? 0 : 2000);
    }
  });

  sock.ev.on('lid-mapping.update', ({ lid, pn }) => store.learn(lid, pn));

  // Names. Each source is kept separately; the saved address-book name wins over the
  // name people set for themselves, so a later update can't overwrite it.
  const takeContacts = (list) => {
    for (const ct of list || []) {
      if (!ct.id) continue;
      store.learn(ct.lid, ct.phoneNumber);
      store.learn(ct.id, ct.lid);
      store.learn(ct.id, ct.phoneNumber);
      if (isJidGroup(ct.id)) store.setName(ct.id, 'subject', ct.name);
      else store.setName(ct.id, 'saved', ct.name);
      store.setName(ct.id, 'push', ct.notify);
      store.setName(ct.id, 'verified', ct.verifiedName);
    }
  };
  sock.ev.on('contacts.upsert', takeContacts);
  sock.ev.on('contacts.update', takeContacts);

  // Chat list
  // chats.upsert / history carry the absolute unread count; chats.update carries
  // +n for new messages, 0 when read on another device and -1 when marked unread.
  const takeChats = (list, isUpdate = false) => {
    for (const ch of list || []) {
      if (!isUserChat(ch.id)) continue;
      store.learn(ch.id, ch.pnJid);
      store.learn(ch.id, ch.lidJid);
      const jid = store.canon(ch.id);
      store.setName(jid, isJidGroup(jid) ? 'subject' : 'chat', ch.name);
      const chat = store.chat(jid);
      chat.lastTs = Math.max(chat.lastTs, toNumber(ch.conversationTimestamp) || 0);
      const n = ch.unreadCount;
      // The open chat counts too: its new messages stay unread until you're there (see markRead).
      if (typeof n === 'number') {
        if (!isUpdate) chat.unread = Math.max(0, n);
        else if (n > 0) chat.unread += n;
        else if (n === 0) chat.unread = 0;
        else chat.unread = Math.max(chat.unread, 1);
      }
      resolveLids([jid]);
    }
    store.changed();
    readIfFocused();
  };
  sock.ev.on('chats.upsert', (list) => takeChats(list));
  sock.ev.on('chats.update', (list) => takeChats(list, true));

  // Group names
  const takeGroups = (gs) => (gs || []).forEach((g) => store.setName(g.id, 'subject', g.subject));
  sock.ev.on('groups.upsert', takeGroups);
  sock.ev.on('groups.update', takeGroups);

  // History sync (right after linking, and on-demand when a chat is opened)
  sock.ev.on('messaging-history.set', ({ chats: cs, contacts, messages, lidPnMappings }) => {
    for (const { lid, pn } of lidPnMappings || []) store.learn(lid, pn);
    takeContacts(contacts);
    takeChats(cs);
    const sorted = [...(messages || [])].sort((a, b) => toNumber(a.messageTimestamp) - toNumber(b.messageTimestamp));
    const touched = new Set();
    for (const m of sorted) if (record(m)) touched.add(store.canon(m.key.remoteJid));
    for (const jid of touched) historyWaiters.get(jid)?.(); // older messages someone is waiting for
  });

  // Live messages: shown in the window if they belong to the open chat (or in the feed when
  // no chat is open); otherwise they only bump the chat in the sidebar.
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) {
      const e = record(m);
      if (!e || type !== 'notify') continue;
      if (e.fromMe && sentIds.has(m.key.id)) continue; // already shown when we sent it
      if (e.jid === current) {
        if (!e.fromMe) readIfFocused();
        if (e.jid === opening?.jid) { opening.held.push(e); continue; } // line mode: printed with the chat in a moment
        enqueue(async () => {
          printMessage(e.jid, e);
          if (e.msg && imgAuto) await showImage(e);
        });
      } else if (!current) {
        if (e.fromMe) continue;
        enqueue(async () => {
          printMessage(e.jid, e, { withChat: true });
          if (e.msg && imgAuto) await showImage(e);
        });
      } else if (!e.fromMe) {
        printMessage(e.jid, e, { withChat: true, toFeed: true }); // there when you go back to the feed
      }
    }
  });
}

store.load();
ui.start();
setPrompt();
print(c.dim('Connecting to WhatsApp…'));
connect().catch((err) => {
  ui.stop();
  realConsoleError(err.stack || err.message);
  process.exit(1);
});
