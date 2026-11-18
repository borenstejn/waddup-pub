# waddup

A small WhatsApp chat client for the terminal. It links to your account as a
"linked device" (like WhatsApp Web) using [Baileys](https://github.com/WhiskeySockets/Baileys),
so your phone stays your main device.

```

 ╭─ Chats ────────────────────╮ ╭─ Oliver · #2 ──────────────────────────╮
 │   2 Oliver                 │ │ Oliver: see you tonight                │
 │   3 Mum                    │ │ me: on my way                          │
 │   4 Football club ⚽       │ │ Oliver: great, I'll bring the wine     │
 │   1 Friends                │ │                                        │
 ╰────────────────────────────╯ ╰────────────────────────────────────────╯

                                  [Oliver] > _
```

> **Unofficial.** waddup is not affiliated with or endorsed by WhatsApp or Meta. Third-party
> clients are against WhatsApp's terms of service, and heavy or automated use can get a number
> banned. Use it for normal personal chatting, at your own risk.

## Two looks

| | Start with | |
|---|---|---|
| **Full screen** (default) | `npm start` or `node chat.js` | Framed chat list and chat window, its own scrolling (wheel, PgUp/PgDn), click a chat to open it |
| **Line mode** | `npm run line` or `node chat.js --line` | Messages print like normal terminal output, one-line chat band at the bottom; the terminal's own scrollback and text selection work |

`WA_UI=line` also starts line mode. Everything else (chats, names, numbers, commands,
images) is the same in both. The features below describe the full-screen look; in line mode
messages from other chats appear inline with the chat's name, and `/sidebar` turns the band
on/off.

## Features

- Full-screen layout: your chats on the left with fixed numbers, most recent first,
  chats with unread messages in bold, and the open chat on the right. `/3` opens chat 3. With no chat open, the
  chat window is a live feed of everything that arrives.
- The chat list and the chat each sit in a rounded frame, the chat's name in its top border. Messages wrap to fit; scroll back with the mouse wheel or Page Up / Page Down, Esc
  returns to the newest. Click a chat in the list to open it.
- Every message shows its time (`14:02`, your computer's time zone), with a date line
  (`── Thursday, November 6 ──`) wherever the day changes. `/timestamp` hides or shows them.
- Read receipts, like WhatsApp Web: opening a chat marks it read, on your phone too (see
  [Read receipts](#read-receipts)).
- Tab completion of chat names: `/to oli` + Tab → `/to Oliver`.
- Images and stickers drawn inline: real images in iTerm2, WezTerm, Kitty and Ghostty (also
  inside tmux), coloured blocks in any other terminal. In iTerm2/WezTerm an image that is cut
  off by the edge of the window shows a short note until you scroll it fully into view.
- Chats, contact names, chat numbers and recent messages are saved locally, so restarts
  don't lose your chat list.
- Control characters and escape sequences in incoming messages and names are stripped before
  anything is shown, so a message can't restyle the screen or talk to your terminal. Names are
  kept to one line, and every row of a message after its first is indented, so a message can't
  fake a line from you or from someone else.

## Requirements

- Node.js 20.9 or newer
- A phone with WhatsApp to link

## Setup

```bash
npm install
npm start            # or: node chat.js
```

Link it on your phone: **WhatsApp → Settings → Linked devices → Link a device**, then scan the
QR code. If scanning is awkward (e.g. over SSH), use a pairing code instead:

```bash
node chat.js --pair 447911123456   # your number, international format, digits only
```

and choose "Link with phone number instead" on the phone.

WhatsApp sends your chat list and contact names **only once, right after linking**. Give it
a minute on the first run.

## Commands

| Command | |
|---|---|
| `/chats [n\|all]` | List recent chats (25 by default) |
| `/to <n\|name\|number>` | Switch chat by number, name (Tab completes) or phone number |
| `/<n>` | Shortcut for `/to <n>`, e.g. `/3` |
| `/show [n]` | Display the latest (or nth latest) image in the current chat |
| `/images on\|off\|<width>\|kitty\|iterm\|blocks\|blocks256` | Image display settings |
| `/sidebar` | Show/hide the chat list |
| `/mouse` | Turn mouse support (wheel scrolling, click to open) on/off |
| `/timestamp [on\|off]` | Show/hide message times and date lines (on by default). In full-screen mode it changes what's already on screen too; in line mode, new messages |
| `/renumber` | Renumber chats 1..n by most recent activity |
| `/whois` | Ids and known names of the current chat |
| `/clear` | Clear the window: the all-chats feed, or the open chat (reopen it to see its messages again). Nothing saved is deleted, and unread chats stay bold. In line mode the cleared lines stay in the terminal's scrollback |
| `/logout` | Unlink this device and delete local data (`/logout confirm` to go ahead) |
| `/exit` | Leave the current chat (back to the all-chats feed) |
| `/quit` | Quit the app (you stay linked) |

Anything else is sent as a message to the current chat. A message that is just a command
word without its slash (`whois`, `chats`…) is held back; type it again to really send it.

Opening a chat shows all its saved messages. If there aren't enough to fill the window, the
app asks your phone for older ones (the phone must be online).

| Key | |
|---|---|
| Mouse wheel, Page Up / Page Down | Scroll the chat window |
| Click a chat in the list | Open it |
| Esc | Back to the newest messages |
| ↑ / ↓ | Previous inputs |
| Tab | Complete a chat name after `/to ` |
| Ctrl-A / Ctrl-E, Ctrl-U / Ctrl-K, Ctrl-W | Start / end of line, delete to start / end, delete word |
| Ctrl-L | Redraw the screen |
| Ctrl-C | Quit |

While mouse support is on, hold **Shift** (**Option** in iTerm2, **Fn** in macOS Terminal) to
select and copy text with the mouse, or turn it off with `/mouse`.

Pasting text with several lines keeps the line breaks (shown as `↵`) and sends it as one
message when you press Enter. The chat list hides itself when the terminal is narrower than
70 columns.

## Configuration

| Environment variable | |
|---|---|
| `WA_IMG` | Force image mode: `kitty`, `iterm`, `blocks`, `blocks256` or `off` |
| `WA_IMG_WIDTH` | Max image width in columns (default 50) |
| `WA_UI=line` | Start in line mode (same as `--line`) |
| `WA_SIDEBAR=off` | Start without the chat list (line mode: without the band) |
| `WA_MOUSE=off` | Start without mouse support |
| `WA_TIMESTAMPS=off` | Start without message times and date lines |
| `WA_DEBUG=1` | Write library output (normally hidden) to `debug.log` |

Colours are in `theme.js` (256-colour codes). Frame margins and padding are `MARGIN` and
`PADDING` at the top of `ui.js`.

## Read receipts

Opening a chat marks its unread messages read, so your phone and other devices stop showing
them as unread. While a chat is open, a new message in it is marked read straight away only while
the terminal window has focus. Otherwise it waits until you're back: a key, a click, or the
window getting focus. A message that arrives while you're away doesn't get blue ticks just because
waddup happened to be open on that chat; leave without coming back and the chat stays bold.

Most terminals tell waddup when their window gains or loses focus. tmux does only with
`focus-events on` (see below); without it, new messages wait for your next key or click.

Your WhatsApp privacy setting is respected: with **Read receipts** turned off on your phone,
only your own devices learn that you read a chat, and senders see no blue ticks. Messages
shown in the all-chats feed are not marked read; open the chat for that.

## Running in tmux

Run waddup in a tmux session to keep it connected in the background (`Ctrl-b d` to detach,
`tmux attach` to come back). Real images work inside tmux 3.3 or newer: waddup switches on
tmux's `allow-passthrough` for its own pane. To have it on everywhere, add this to
`~/.tmux.conf`:

```
set -g allow-passthrough on
set -g mouse on      # so the wheel and clicks reach waddup
set -g focus-events on   # so waddup knows when you're looking (read receipts)
```

- **Kitty and Ghostty:** real images, drawn through placeholder characters that tmux treats as
  ordinary text, so they survive redraws.
- **iTerm2 and WezTerm:** real images, painted at the right spot on screen (waddup accounts for
  where its pane sits). Switching tmux windows can clear one; `Ctrl-L` paints it again.
- **Other terminals,** or tmux older than 3.3: coloured blocks.

waddup asks tmux which terminal it's attached to. If detection gets it wrong, set `WA_IMG`.

## Local data

These are created next to `chat.js` and are git-ignored. They are created readable by your user
only. They are private: keep them out of backups you share.

| Path | Contents |
|---|---|
| `auth/` | Your linked-device session (keys). Anyone with it can read and send your messages. |
| `store.json` | Chat list, contact names, chat numbers, last 50 messages per chat |
| `media/` | Downloaded images and stickers: only real JPEG, PNG, WebP or GIF files up to 16 MB, named by a hash of the message, with the extension of what they really are rather than what the sender claimed |
| `debug.log` | Only with `WA_DEBUG=1`: library messages, may include contact ids |

`/logout` (after `/logout confirm`) deletes `auth/`, `store.json`, `media/` and `debug.log`.

## Files

| File | |
|---|---|
| `chat.js` | The app: WhatsApp connection, commands, what goes on screen |
| `ui.js` | Full-screen layout: chat window, chat list, input line, scrolling, keys, mouse |
| `ui-line.js` | Line mode: printed output, readline input, the bottom band |
| `band.js` | Line mode's one-line chat band (terminal scroll region + layout) |
| `store.js` | Local store: chats, names, numbers, messages; merges phone-number and LID ids |
| `image.js` | Image rendering (Kitty placeholders, iTerm2 inline images, half-block fallback) |
| `theme.js` | Colours |

## License

Copyright (c) 2026 kewlinside

Licensed under the MIT License: Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Thus, the maintainers of the project can't be held liable for any potential misuse of this project.
