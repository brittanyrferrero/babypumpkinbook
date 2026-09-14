# Writing tags with the booper

The booper is a small circuit board (nRF52840 + RC522 reader) that writes a
web address onto NFC stickers. You plug it into a computer over USB, tell it a
URL, and tap a sticker on it. From then on, tapping that sticker with a phone
opens that URL.

If you're using Claude Code or similar: point it at this file. Everything it
needs is here and in `tools/ntag_write.py`.

## What you need

- The booper, plugged into a USB port with a **data** cable (many charging
  cables are power-only and the board will simply not show up).
- **NTAG213 or NTAG215 stickers.** Nothing else works. Tags sold as "MIFARE",
  "S50", "1K" or "125 kHz" look identical but phones can't read them; the
  booper will refuse them with `not a Type 2 tag`.
- `uv` installed (Mac: `brew install uv`, or
  `curl -LsSf https://astral.sh/uv/install.sh | sh`). It fetches the one
  Python dependency by itself.

## The one command

From the repo folder:

```
uv run tools/ntag_write.py --url https://babypumpkinbook-algb.vercel.app/p/3
```

It finds the board, prints `present tag 1/1 ...`, and waits. Tap a sticker
flat on the reader and hold it for a second. You'll see:

```
  < WROTE uid=04:A3:4C:34:DC:2A:81 type=NTAG215 bytes=43 pages=11 n=1
wrote 1 tag(s)
```

`WROTE` means it wrote the URL and read it back to double-check. Mark the
sticker right away (a dot of Sharpie with the page number), because written
stickers look exactly like blank ones.

### Several tags of the same URL

```
uv run tools/ntag_write.py --url https://babypumpkinbook-algb.vercel.app/p/3 --count 5
```

Tap five stickers one after another, lifting each off before the next.

### Check what's on a tag

```
uv run tools/ntag_write.py --read
```

Tap a tag; it prints the tag type and the URL on it (or `URL (none)`).

## Which URL goes on which tag

| Book page | URL |
|---|---|
| 1 | `https://babypumpkinbook-algb.vercel.app/p/1` |
| 2 | `https://babypumpkinbook-algb.vercel.app/p/2` |
| … | … |
| 8 | `https://babypumpkinbook-algb.vercel.app/p/8` |
| cover / anywhere | `https://babypumpkinbook-algb.vercel.app/random` |

Always the `/p/<number>` form, never a specific fact like `/p/3/2`, or that
tag will show the same fact forever. Adding a page 9 to the book means adding
a `9-something` folder under `content/` (see README) and writing `/p/9` on
its sticker.

Rewriting a sticker with a different URL is fine; it just overwrites.

## If something's off

- **"No NTAG Writer board found"**: swap to a data cable, try another port,
  unplug and replug. On a Mac the board appears as two `/dev/cu.usbmodem…`
  ports; the script probes both and picks the right one. If it can't, pass
  `--port /dev/cu.usbmodemXXXX` (the higher-numbered of the two is usually
  the console).
- **Nothing happens when you tap**: centre the sticker over the coil (the
  square loop on the green reader board) and hold still. If it's the same
  sticker you just wrote, lift it well away first; the board ignores a tag
  until it leaves and comes back.
- **`ERR ... is not a Type 2 tag (MIFARE Classic?)`**: wrong kind of sticker.
- **`ERR cc=... not NDEF and not blank; refusing`**: a tag that was formatted
  for something else. Use a fresh sticker.
- **Board light is pulsing slowly and nothing responds**: it's in bootloader
  mode (someone double-tapped the reset button). Unplug and replug.

## Talking to it by hand

The script is a thin wrapper. The board speaks plain text at 115200 baud
(`screen /dev/cu.usbmodemXXXX 115200`):

```
url https://babypumpkinbook-algb.vercel.app/p/3   set the URL
w        write the next tag, then stop
wl       write every tag until x
r / rl   read the next tag / every tag
x        stop
s        status
?        help
```

## Reflashing (Eamon)

The firmware and DFU flow live in the `rfid-thread-scanner` repo under
`tools/ntag-writer/`. It's the same nice!nano bootloader double-tap dance as
the scanners; `ntag_writer_v2.zip` is the built image. Not something the
booper should ever need in normal use.
