// Local store: chats, names, chat numbers and recent messages, saved to ./store.json.
//
// WhatsApp only sends a linked device its chat list and contact names once, right after
// linking, so we keep them on disk to survive restarts.
//
// WhatsApp also addresses people either by phone number (…@s.whatsapp.net) or by a private
// "LID" (…@lid). The same person can show up under both, so every jid goes through canon(),
// which maps a LID to its phone-number jid whenever we know the pair, and learn() merges the
// two entries the moment a pair is discovered.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { BufferJSON, isJidGroup, isLidUser, isPnUser, jidNormalizedUser, proto } from '@whiskeysockets/baileys';

const MEM_LIMIT = 200; // messages kept in memory per chat
const DISK_LIMIT = 50; // messages saved per chat
// Name sources in priority order.
const DM_ORDER = ['saved', 'chat', 'push', 'verified'];
const GROUP_ORDER = ['subject', 'saved', 'chat'];
// WhatsApp sometimes sends a number (often masked, e.g. "+44∙∙∙∙∙∙∙∙30") as a contact's display
// name. Anything without a single letter is only used when there's no real name.
const looksLikeNumber = (v) => !/\p{L}/u.test(v);

// Strip what a terminal could act on if it were printed: whole escape sequences (CSI, OSC, DCS…)
// first, then any remaining C0 control except newline (tabs become spaces), DEL, C1 controls,
// line/paragraph separators, and the bidi overrides that reorder displayed text. Applied to
// everything that arrives from WhatsApp before it is stored or shown, so a message can't restyle
// the screen, pose as another sender or talk to the terminal.
export const clean = (s) =>
  String(s ?? '')
    .replace(/(?:\x1b\[|\x9b)[\x20-\x3f]*[\x40-\x7e]/g, '')   // CSI: ESC [ (or C1 CSI), parameters, final byte
    .replace(/\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC, DCS, SOS, PM, APC: up to BEL or ST
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f\x80-\x9f\u2028\u2029]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '');

// clean(), on one line: for names, which are shown inside other lines ("Name: text", the chat
// list, the prompt), where a line break would let a name end one row and fake the next.
export const cleanLine = (s) => clean(s).replace(/\s*\n\s*/g, ' ').trim();

// Message ids are only unique within a chat (the sender's app picks them, and a modified one can
// pick any), so "already stored" is tracked per chat: an id reused in another chat can't make
// a message there disappear.
const seenKey = (jid, id) => `${jid}\n${id}`;

export class Store {
  constructor(file) {
    this.file = file;
    this.lidToPn = new Map();  // lid jid -> phone-number jid
    this.names = new Map();    // jid -> { saved, chat, push, verified, subject }
    this.chats = new Map();    // jid -> { jid, lastTs, unread }
    this.history = new Map();  // jid -> [{ id, ts, fromMe, senderJid, text, sticker, msg }]
    this.seen = new Set();     // seenKey(chat jid, message id) of messages already stored
    this.numOf = new Map();    // jid -> chat number
    this.jidOfNum = new Map(); // chat number -> jid (two numbers can point to one merged chat)
    this.nextNum = 1;
    this.communities = new Set(); // community "parent" groups: not chats you can write in
    this.onChange = () => {};
    this.onMerge = () => {};
    this.saveTimer = null;
  }

  // ---- ids ----
  canon(jid) {
    if (!jid) return jid;
    const j = jidNormalizedUser(jid) || jid;
    return this.lidToPn.get(j) || j;
  }

  /** Record that two jids are the same person (one LID, one phone number). */
  learn(a, b) {
    if (!a || !b) return;
    a = jidNormalizedUser(a);
    b = jidNormalizedUser(b);
    let lid, pn;
    if (isLidUser(a) && isPnUser(b)) [lid, pn] = [a, b];
    else if (isLidUser(b) && isPnUser(a)) [lid, pn] = [b, a];
    else return;
    if (this.lidToPn.get(lid) === pn) return;
    this.lidToPn.set(lid, pn);
    this.merge(lid, pn);
    this.changed();
  }

  merge(from, to) {
    const chatA = this.chats.get(from);
    if (chatA) {
      const chatB = this.chats.get(to) || { jid: to, lastTs: 0, unread: 0 };
      chatB.lastTs = Math.max(chatA.lastTs, chatB.lastTs);
      chatB.unread = Math.max(chatA.unread || 0, chatB.unread || 0);
      this.chats.delete(from);
      this.chats.set(to, chatB);
    }
    const histA = this.history.get(from);
    if (histA) {
      const histB = this.history.get(to) || [];
      const ids = new Set(histB.map((e) => e.id));
      const merged = [...histB, ...histA.filter((e) => !e.id || !ids.has(e.id))].sort((x, y) => x.ts - y.ts);
      this.history.set(to, merged.slice(-MEM_LIMIT));
      this.history.delete(from);
      for (const e of histA) if (e.id) this.seen.add(seenKey(to, e.id)); // they now live under `to`
    }
    const namesA = this.names.get(from);
    if (namesA) {
      this.names.set(to, { ...namesA, ...this.names.get(to) });
      this.names.delete(from);
    }
    const numA = this.numOf.get(from);
    if (numA !== undefined) {
      if (!this.numOf.has(to)) this.numOf.set(to, numA);
      this.jidOfNum.set(numA, to); // the old number keeps working
      this.numOf.delete(from);
    }
    this.onMerge(from, to);
  }

  // ---- names ----
  setName(jid, source, value) {
    if (!jid || typeof value !== 'string') return;
    value = cleanLine(value);
    if (!value) return;
    jid = this.canon(jid);
    const n = this.names.get(jid) || {};
    if (n[source] === value) return;
    n[source] = value;
    this.names.set(jid, n);
    this.changed();
  }

  /** Best known name, or null. */
  nameOf(jid) {
    jid = this.canon(jid);
    const n = this.names.get(jid);
    if (!n) return null;
    const order = isJidGroup(jid) ? GROUP_ORDER : DM_ORDER;
    return order.map((k) => n[k]).find((v) => v && !looksLikeNumber(v)) || order.map((k) => n[k]).find(Boolean) || null;
  }

  setCommunity(jid) {
    if (this.communities.has(jid)) return;
    this.communities.add(jid);
    this.changed();
  }

  // ---- chats + messages ----
  chat(jid) {
    jid = this.canon(jid);
    let ch = this.chats.get(jid);
    if (!ch) {
      ch = { jid, lastTs: 0, unread: 0 };
      this.chats.set(jid, ch);
    }
    return ch;
  }

  /** Adds a message entry; returns false if it was already stored. */
  addEntry(jid, entry) {
    jid = this.canon(jid);
    if (entry.id) {
      const key = seenKey(jid, entry.id);
      if (this.seen.has(key)) return false;
      this.seen.add(key);
    }
    const list = this.history.get(jid) || [];
    // History sync can deliver older messages after newer ones: keep the list sorted.
    if (list.length && list.at(-1).ts > entry.ts) {
      const i = list.findIndex((e) => e.ts > entry.ts);
      list.splice(i, 0, entry);
    } else list.push(entry);
    if (list.length > MEM_LIMIT) list.splice(0, list.length - MEM_LIMIT);
    this.history.set(jid, list);
    const ch = this.chat(jid);
    ch.lastTs = Math.max(ch.lastTs, entry.ts);
    this.changed();
    return true;
  }

  // ---- numbers ----
  numberOf(jid) {
    jid = this.canon(jid);
    if (!this.numOf.has(jid)) {
      this.numOf.set(jid, this.nextNum);
      this.jidOfNum.set(this.nextNum, jid);
      this.nextNum++;
      this.changed();
    }
    return this.numOf.get(jid);
  }
  peekNumber(jid) {
    return this.numOf.get(this.canon(jid));
  }
  jidOf(num) {
    const jid = this.jidOfNum.get(num);
    return jid && this.canon(jid);
  }
  /** Throw away all numbers and renumber the given chats 1..n. */
  renumber(jids) {
    this.numOf.clear();
    this.jidOfNum.clear();
    this.nextNum = 1;
    jids.forEach((j) => this.numberOf(j));
  }

  // ---- persistence ----
  changed() {
    this.onChange();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 2000);
  }

  load() {
    let data;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'), BufferJSON.reviver);
    } catch {
      return false; // no store yet (or unreadable): start fresh
    }
    for (const [lid, pn] of data.lidToPn || []) this.lidToPn.set(lid, pn);
    // Names and texts are cleaned again here, so a store written before clean() existed is safe too.
    for (const [jid, n] of data.names || []) {
      const names = Object.fromEntries(Object.entries(n || {}).map(([k, v]) => [k, cleanLine(v)]).filter(([, v]) => v));
      if (Object.keys(names).length) this.names.set(jid, names);
    }
    for (const [jid, ch] of data.chats || []) this.chats.set(jid, { ...ch, unread: 0 });
    for (const [num, jid] of data.jidOfNum || []) this.jidOfNum.set(num, jid);
    for (const [jid, num] of data.numOf || []) this.numOf.set(jid, num);
    this.nextNum = data.nextNum || this.numOf.size + 1;
    for (const jid of data.communities || []) this.communities.add(jid);
    for (const [jid, list] of data.history || []) {
      const kept = [];
      for (const e of list || []) {
        if (e.id) this.seen.add(seenKey(jid, e.id));
        e.text = clean(e.text);
        if (!e.text) continue;
        // Media messages are stored as JSON; rebuild the protobuf so it can be downloaded.
        if (e.msg?.message) {
          try { e.msg.message = proto.Message.fromObject(e.msg.message); } catch { delete e.msg; }
        }
        kept.push(e);
      }
      this.history.set(jid, kept);
    }
    return true;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const data = {
      v: 1,
      lidToPn: [...this.lidToPn],
      names: [...this.names],
      chats: [...this.chats].map(([jid, ch]) => [jid, { jid: ch.jid, lastTs: ch.lastTs }]),
      numOf: [...this.numOf],
      jidOfNum: [...this.jidOfNum],
      nextNum: this.nextNum,
      communities: [...this.communities],
      history: [...this.history].map(([jid, list]) => [jid, list.slice(-DISK_LIMIT)]),
    };
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, BufferJSON.replacer), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Save now if there are unsaved changes (used on exit). */
  flush() {
    if (this.saveTimer) this.save();
  }

  destroy() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    rmSync(this.file, { force: true });
    rmSync(this.file + '.tmp', { force: true });
  }
}
