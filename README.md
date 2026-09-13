# Pumpkin's book of wonders 🎃

A baby book with NFC tags hidden in its pages. Scan a page with a phone and it
opens a random fact about what's on that page, read aloud by a friend.

Live site: deployed from this repo by Vercel. Every push to `main` goes live in
about a minute.

## How the site is laid out

| URL | What it does |
|---|---|
| `/p/3` | **This is what goes on the tag.** Page 3 of the book. Picks a random fact for that page and jumps to it. Won't repeat the last fact shown on that phone. |
| `/p/3/2` | One specific fact, with its audio. |
| `/random` | A random fact from a random page. Nice for a tag on the cover, or just a link to share. |
| `/` | A plain list of all pages, for us, not for the reader. |

## Adding or editing content (no coding needed)

Everything lives in the `content/` folder. One folder per book page, named
`<page number>-<anything>`. The number is what the tag in the book points at;
the name after the dash is just for us:

```
content/
  3-ocean/
    page.md      "# Title" on the first line, an optional one-line blurb, and an optional "emoji: 🌊" line
    01.md        one fact per file, numbered. Plain text; **bold** and *italic* work.
    01.mp3       the audio for fact 01 (optional; mp3, m4a, ogg or wav all fine)
    02.md
    02.mp3
    cover.jpg    optional picture shown above the fact
```

- **New fact:** add `05.md` next to the others. That's it.
- **Audio:** name the recording the same number as the fact, e.g. `03.m4a` goes with `03.md`. A fact with no audio just shows the text.
- **New page:** make a folder `7-whatever`, add `page.md` and at least one fact file. Its tag URL is `/p/7`.
- **Changing what a page is about:** rename the folder (keep the number), swap the facts and audio. The tag in the book keeps working because it only knows the number. Never give two folders the same number.

Edit right on GitHub (open a file, click the pencil, commit) or clone the repo.
Vercel rebuilds automatically on every commit to `main`.

## Running it locally

Needs Node 20 or newer, nothing else.

```
npm run build       # builds into dist/
npm run dev         # builds and serves at http://localhost:3000
```

`dist/tags.txt` lists every page with its tag URL. Set `SITE_URL` to get
absolute URLs: `SITE_URL=https://babypumpkinbook.vercel.app npm run build`.

## Writing the tags

The tags are NTAG stickers written with an NDEF URL record. Any NFC phone app
(NFC Tools works) can write them, or the RC522 writer board in
`rfid-thread-scanner/tools/ntag-writer`. Write the `/p/<number>` URL, never a
specific fact URL, so each scan gets a fresh fact.
