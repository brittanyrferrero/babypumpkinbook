# CLAUDE.md

Pumpkin's baby book: NFC stickers in a picture book open fact pages with
audio. Static site, deployed by Vercel from `main`.

- `README.md` — how the site is laid out, how to add pages/facts/audio, how
  the AI voices work. Read first.
- `TAG-WRITER.md` — how to write stickers with the USB "booper" board using
  `tools/ntag_write.py`. Read this when asked about tags, stickers, NFC, or
  the booper.
- `firmware/booper/` — the tag-writer board's Zephyr firmware, built image,
  and DFU flasher. Only needed if the board is wiped.
- `content/<N>-<name>/` — the book pages. The number is the tag URL (`/p/N`)
  and must never change once a sticker is written; the name is cosmetic.
- `build.mjs` — the whole build, no dependencies. `npm run build` → `dist/`.
  Pages use a Mason-style minimal design: always-dark gray, all sans serif (Figtree),
  hairline dividers instead of cards, sage green accent.
- `admin/index.html` + `api/` — the `/admin` dashboard. Password login
  (`ADMIN_PASSWORD`), and every save is a commit to `main` through the GitHub
  API (`GITHUB_TOKEN`). `record/index.html` is the family page at `/record`,
  open to anyone with no password: it can only add a person's recording to a
  fact that lacks one, via `api/record.js`. `api/_lib.js` only allows writes to `content/` page,
  fact, audio and picture files. Recordings are converted to mp3 in the browser
  (lamejs) and listed in `content/recordings.json`.
- `generate_audio.py` / `prep_voice.py` / `voices.json` — AI narration. Runs
  only on Eamon's Mac (tinkerbox), which holds the voice references. Voice
  references are private recordings and must never be committed here; the
  repo is public.

Rules of thumb:
- Never rename or renumber a `content/` folder's leading number.
- Never commit `.wav`/`.webm` voice references or anything under
  `pumpkin-voices`.
- A human recording named like its fact (`03.m4a` next to `03.md`) always
  wins over the AI clip; delete the `.mp3` in the same commit. Human
  recordings from the dashboard are `.mp3` and listed in
  `content/recordings.json`; never delete those when re-voicing.
- One Vercel project, `babypumpkinbook-algb`, serves both
  babypumpkinbook-algb.vercel.app (what the stickers use) and
  babypumpkinbook.vercel.app. Dashboard env vars live there.
- Pushing to `main` deploys. Preview locally with `npm run dev`.
