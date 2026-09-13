#!/usr/bin/env python3
"""
Batch TTS for the fact pages. Same engine and voices as wizards-poker-wand.

Reads:  content/<N>-<name>/NN.md        (one fact per file)
Writes: content/<N>-<name>/NN.mp3       (44.1 kHz mono, 192 kbps, loudness-normalised)
Skips facts that already have audio of any kind (mp3/m4a/ogg/wav), so a
human recording dropped next to a fact is never overwritten. Safe to resume.

Voice: deterministic 50/50 malone2 / femme2, hashed on "<folder>/<NN>".

Runs on tinkerbox (needs the OmniVoice venv + ffmpeg):
    cd ~/claude/babypumpkinbook
    PATH=/opt/homebrew/bin:$PATH ~/claude/tts_eval/.venv-omni/bin/python generate_audio.py
    python generate_audio.py --only 3-ocean/02 4-bees/01     # just these
    python generate_audio.py --dry-run                        # show the plan
"""
import argparse
import hashlib
import re
import subprocess
import tempfile
import time
from pathlib import Path

CONTENT     = Path(__file__).parent / "content"
SCRIPTS_DIR = Path("~/claude/tts_eval/scripts").expanduser()
AUDIO_EXT   = {".mp3", ".m4a", ".ogg", ".wav"}

VOICES = [
    # (name, ref_wav, instruct, volume)  — identical to wizards-poker-wand/generate_audio.py
    ("malone2", SCRIPTS_DIR / "malone_2.wav",      "male, low pitch, middle-aged",        1.0),
    ("femme2",  SCRIPTS_DIR / "femme_fatal_2.wav", "female, moderate pitch, middle-aged", 1.45),
]

TRAILING_SILENCE = 0.6  # seconds


def voice_for(key):
    h = int(hashlib.md5(key.encode()).hexdigest(), 16)
    return h % 2  # 0 = malone2, 1 = femme2


def plain_text(md):
    """Strip the little markdown we allow so the reader doesn't say 'asterisk'."""
    t = md.strip()
    t = re.sub(r"\[(.+?)\]\(https?://[^)\s]+\)", r"\1", t)
    t = t.replace("**", "").replace("*", "")
    t = re.sub(r"\s*\n\s*\n\s*", " ", t)      # paragraph breaks -> pause via punctuation already there
    t = re.sub(r"\s*\n\s*", " ", t)
    return t


def find_facts():
    facts = []
    for folder in sorted(p for p in CONTENT.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))):
        for md in sorted(folder.glob("[0-9]*.md")):
            stem = md.stem
            has_audio = any((folder / f"{stem}{ext}").exists() for ext in AUDIO_EXT)
            facts.append((f"{folder.name}/{stem}", md, folder / f"{stem}.mp3", has_audio))
    return facts


def load_model_and_prompts():
    import torch
    from omnivoice import OmniVoice
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"[omni] loading model on {device}...", flush=True)
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=device, torch_dtype=torch.float16)
    prompts = []
    for name, ref_path, _, _vol in VOICES:
        print(f"[omni] encoding voice ref {ref_path.name}...", flush=True)
        prompts.append(model.create_voice_clone_prompt(str(ref_path)))
    return model, prompts


def generate_clip(model, prompt, instruct, text, out_mp3, volume=1.0):
    import numpy as np
    import soundfile as sf
    sr = model.sampling_rate
    arrays = model.generate(text=text, voice_clone_prompt=prompt, instruct=instruct,
                            language="en", postprocess_output=True)
    audio = np.concatenate([a for a in arrays if a is not None])
    audio = audio * volume
    audio = np.concatenate([audio, np.zeros(int(sr * TRAILING_SILENCE))])

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    sf.write(tmp_path, audio, sr)
    subprocess.run(
        ["ffmpeg", "-y", "-i", tmp_path,
         "-af", "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,"
                "loudnorm=I=-16:TP=-1.5:LRA=11",
         "-ar", "44100", "-ac", "1", "-b:a", "192k",
         "-id3v2_version", "0", "-write_id3v1", "0",
         str(out_mp3)],
        check=True, capture_output=True,
    )
    Path(tmp_path).unlink()
    return len(audio) / sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="+", help="fact keys like 3-ocean/02")
    ap.add_argument("--dry-run", action="store_true", help="list what would be generated")
    args = ap.parse_args()

    facts = find_facts()
    if args.only:
        facts = [f for f in facts if f[0] in set(args.only)]
    todo = [f for f in facts if not f[3]]
    print(f"Facts: {len(facts)} total, {len(facts) - len(todo)} already have audio, {len(todo)} to generate")
    for key, md, _, _ in todo:
        print(f"  {key:16s} [{VOICES[voice_for(key)][0]}]  {plain_text(md.read_text())[:70]}")
    if not todo or args.dry_run:
        return

    model, prompts = load_model_and_prompts()
    t_start = time.monotonic()
    for i, (key, md, out_mp3, _) in enumerate(todo, 1):
        vi = voice_for(key)
        name, _, instruct, volume = VOICES[vi]
        t0 = time.monotonic()
        dur = generate_clip(model, prompts[vi], instruct, plain_text(md.read_text()), out_mp3, volume)
        elapsed = time.monotonic() - t0
        eta = (time.monotonic() - t_start) / i * (len(todo) - i)
        print(f"[{i}/{len(todo)}] {key} [{name}]  {dur:.1f}s audio  {elapsed:.0f}s gen  ETA {eta/60:.0f}m", flush=True)
    print(f"\nDone. {len(todo)} clips in {(time.monotonic() - t_start) / 60:.1f} min")


if __name__ == "__main__":
    main()
