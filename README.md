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

## The dashboard (easiest way to edit)

Go to `/admin` on the site and log in with the admin password. From there you
can rename pages, add a picture, add, edit
or delete facts, and upload recordings (any audio file or a phone video; only
the sound is kept). Each save is a commit to this repo, so the site updates
about a minute later, the same as any other push. The header shows
"Publishing…" and then "Live".

Recordings uploaded there are converted in the browser to a mono mp3, trimmed
and level-matched to the AI clips, and saved as `NN.mp3`. They're listed in
`content/recordings.json` (key `<page number>/<NN>`, with who read it), which
is how the dashboard tells them apart from AI readings. **When re-voicing,
don't delete mp3s that are listed there.**

### Family recording page

`/record` is for family members. They log in with the family password
(`RECORDER_PASSWORD`) and their name, see every fact that doesn't have a
person's recording yet (AI-voiced facts count as not recorded), and pick one.
They record with the phone or laptop mic, listen back, record again as often as
they like, and then **Submit** it or **Delete** the take. Submitted recordings
go live straight away (converted the same way as uploads) and are credited in
`recordings.json`. Facts that already have a person's recording are listed at
the bottom, read-only. The family password can't use `/admin`: the server only
lets it add a recording to a fact with no person's recording (`api/record.js`).
You can still replace or remove any recording from `/admin`.

Setup (already done once; only needed for a new Vercel project): the
dashboard needs these environment variables in Vercel: `ADMIN_PASSWORD` (the
admin password), `RECORDER_PASSWORD` (the family password for `/record`; leave
it unset to turn that page off) and `GITHUB_TOKEN` (a fine-grained GitHub token
for this repo only, with Contents: read and write, and Commit statuses: read).
The code is `admin/index.html`, `record/index.html`, `admin/audio.js` (shared
mp3 conversion) and `api/`.

## Adding or editing content by hand

Everything lives in the `content/` folder. One folder per book page, named
`<page number>-<anything>`. The number is what the tag in the book points at;
the name after the dash is just for us:

```
content/
  3-ocean/
    page.md      "# Title" on the first line
    01.md        one fact per file, numbered. Plain text; **bold** and *italic* work.
    01.mp3       the audio for fact 01 (optional; mp3, m4a, mp4, ogg or wav; mp4 plays as sound only)
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

## Generating audio with the AI voices

Until (or instead of) a human recording, `generate_audio.py` reads every fact
that has no audio yet in one of the cloned voices in `voices.json` (Eamon and
Brittany today, same references as the wizards poker wand). Each fact gets one
voice, picked by a stable hash so reruns don't reshuffle. It never overwrites an
existing recording, so dropping a real `03.m4a` next to `03.md` wins. Runs on
tinkerbox:

```
cd ~/claude/babypumpkinbook
PATH=/opt/homebrew/bin:$PATH ~/claude/tts_eval/.venv-omni/bin/python generate_audio.py
git add content && git commit -m "audio" && git push
```

### Adding a friend's voice

The voice references are real people's recordings and stay **out of this
public repo**, in `~/claude/pumpkin-voices/` on tinkerbox. `voices.json` only
points at them by filename.

1. **Get a recording.** Phone voice memo is fine. Ask for 15 to 20 seconds of
   natural talking in a quiet room: no music, no other voices, phone about a
   hand's width from the mouth, and a normal reading pace. Reading one of the
   facts aloud works well. Warm, relaxed delivery clones better than
   "announcer voice".
2. **Prep it** (trims silence, makes it mono 44.1 kHz, level-matches it so no
   gain fiddling is needed):
   ```
   python prep_voice.py sam ~/Downloads/sam-memo.m4a            # whole memo
   python prep_voice.py sam ~/Downloads/sam-memo.m4a --start 4 --end 22
   ```
   It prints the duration and a ready-made `voices.json` entry.
3. **Add the entry to `voices.json`.** Set `instruct` to describe the real
   speaker, e.g. `"female, high pitch, young adult"` or `"male, low pitch,
   elderly"`. That string steers the model's pitch and age; it's the only pitch
   control there is. Leave `gain` at 1.0 for prepped voices.
4. **Voice the facts.** New facts pick from all enabled voices automatically. To
   re-voice existing facts with the new mix, delete their mp3s first
   (`rm content/*/*.mp3` for everything, or just the ones you want, but **not**
   the human recordings listed in `content/recordings.json`), then run
   `generate_audio.py`.

To take a voice out of rotation without deleting it, set `"enabled": false`.

### How the levels are handled

- The output pipeline trims leading silence and normalises every clip to
  -16 LUFS with a -1.5 dBTP ceiling, so all voices play at the same loudness
  on the phone regardless of how loud the reference was.
- The two original references were raw takes at very different levels
  (Eamon's about -29 LUFS, Brittany's about -38), which is why Brittany's entry
  carries a 1.45 gain. References made by `prep_voice.py` are normalised to
  -23 LUFS up front, so new voices don't need that knob.
- Pitch is never shifted. The clone follows the reference and the `instruct`
  hint.

## Running it locally

Needs Node 20 or newer, nothing else.

```
npm run build       # builds into dist/
npm run dev         # builds and serves at http://localhost:3000
```

`dist/tags.txt` lists every page with its tag URL. Set `SITE_URL` to get
absolute URLs: `SITE_URL=https://babypumpkinbook.vercel.app npm run build`.

## Writing the tags

See [TAG-WRITER.md](TAG-WRITER.md). Short version: plug in the booper, then

```
uv run tools/ntag_write.py --url https://babypumpkinbook-algb.vercel.app/p/3
```

and tap an NTAG213/215 sticker. Always the `/p/<number>` URL, never a specific
fact URL, so each scan gets a fresh fact.
