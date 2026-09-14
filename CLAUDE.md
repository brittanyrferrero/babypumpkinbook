# CLAUDE.md

Pumpkin's baby book: NFC stickers in a picture book open fact pages with
audio. Static site, deployed by Vercel from `main`.

- `README.md` — how the site is laid out, how to add pages/facts/audio, how
  the AI voices work. Read first.
- `TAG-WRITER.md` — how to write stickers with the USB "booper" board using
  `tools/ntag_write.py`. Read this when asked about tags, stickers, NFC, or
  the booper.
- `content/<N>-<name>/` — the book pages. The number is the tag URL (`/p/N`)
  and must never change once a sticker is written; the name is cosmetic.
- `build.mjs` — the whole build, no dependencies. `npm run build` → `dist/`.
- `generate_audio.py` / `prep_voice.py` / `voices.json` — AI narration. Runs
  only on Eamon's Mac (tinkerbox), which holds the voice references. Voice
  references are private recordings and must never be committed here; the
  repo is public.

Rules of thumb:
- Never rename or renumber a `content/` folder's leading number.
- Never commit `.wav`/`.webm` voice references or anything under
  `pumpkin-voices`.
- A human recording named like its fact (`03.m4a` next to `03.md`) always
  wins over the AI clip; delete the `.mp3` in the same commit.
- Pushing to `main` deploys. Preview locally with `npm run dev`.
