# Pumpkin's book of wonders 🎃

A baby book with NFC tags hidden in its pages. Scan a page with a phone and it
opens a random fact about what's on that page, read aloud by a friend.

Live site: deployed from this repo by Vercel. Every push to `main` goes live in
about a minute.

## How the site is laid out

| URL | What it does |
|---|---|
| `/p/elephant` | **This is what goes on the tag.** Picks a random elephant fact and jumps to it. Won't repeat the last fact shown on that phone. |
| `/p/elephant/2` | One specific fact, with its audio and an "Another one" button. |
| `/` | A plain list of all pages, for us, not for the reader. |

## Adding or editing content (no coding needed)

Everything lives in the `content/` folder. One folder per book page:

```
content/
  elephant/
    page.md      the page title (first line, starting with "# ") and an optional one-line blurb
    01.md        one fact per file, numbered. Plain text; **bold** and *italic* work.
    01.mp3       the audio for fact 01 (optional; mp3, m4a, ogg or wav all fine)
    02.md
    02.mp3
    cover.jpg    optional picture shown above the fact
```

- **New fact:** add `05.md` next to the others. That's it.
- **Audio:** name the recording the same number as the fact, e.g. `03.m4a` goes with `03.md`. A fact with no audio just shows the text.
- **New page:** make a new folder, add `page.md` and at least one fact file. The tag URL is `/p/<folder name>`. Use lowercase letters and dashes for the folder name, since it ends up in the URL.
- **Renaming a folder changes its URL**, and the tags in the book are permanent. Once a tag is written, leave that folder name alone.

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
`rfid-thread-scanner/tools/ntag-writer`. Write the `/p/<page>` URL, never a
specific fact URL, so each scan gets a fresh fact.
