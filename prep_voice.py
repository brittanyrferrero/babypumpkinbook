#!/usr/bin/env python3
"""
Turn a friend's raw recording into a voice reference for OmniVoice.

    python prep_voice.py <name> <recording> [--start S] [--end S]

Takes anything ffmpeg can read (iPhone .m4a voice memo, .wav, .mp3, a video)
and writes ~/claude/pumpkin-voices/<name>.wav:
  - mono, 44.1 kHz, 16-bit (what the existing malone/femme refs are)
  - leading/trailing silence trimmed
  - level-matched to -23 LUFS integrated, -3 dBTP ceiling (so voices.json gain stays 1.0)
Then prints the duration and a voices.json entry to paste in.

Good reference = 10-20 s of one person talking naturally in a quiet room,
no music, no other voices, phone held ~20 cm from the mouth. Use --start/--end
to cut the best stretch out of a longer memo. Runs anywhere ffmpeg exists.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

VOICES_JSON = Path(__file__).parent / "voices.json"
TARGET_LUFS = -23.0
TARGET_TP = -3.0


def ffprobe_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def measure(path):
    """First-pass loudnorm measurement; returns the JSON block ffmpeg prints."""
    out = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-af",
                          f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA=11:print_format=json",
                          "-f", "null", "-"], capture_output=True, text=True)
    blocks = re.findall(r"\{[^{}]*\}", out.stderr, re.S)
    if not blocks:
        sys.exit(f"could not measure loudness:\n{out.stderr[-800:]}")
    return json.loads(blocks[-1])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", help="short lowercase voice name, e.g. sam")
    ap.add_argument("recording", help="raw recording (m4a/wav/mp3/mov...)")
    ap.add_argument("--start", type=float, default=None, help="seconds into the recording to start")
    ap.add_argument("--end", type=float, default=None, help="seconds into the recording to stop")
    ap.add_argument("--out-dir", default=None, help="override voices_dir from voices.json")
    args = ap.parse_args()

    if not re.fullmatch(r"[a-z][a-z0-9_-]*", args.name):
        sys.exit("name must be lowercase letters/digits, e.g. sam")
    cfg = json.loads(VOICES_JSON.read_text())
    out_dir = Path(args.out_dir or cfg["voices_dir"]).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    src = Path(args.recording).expanduser()
    if not src.exists():
        sys.exit(f"no such file: {src}")
    out = out_dir / f"{args.name}.wav"
    tmp = out_dir / f".{args.name}.cut.wav"

    # 1) cut + mono + 44.1k + trim silence at both ends
    cut = []
    if args.start is not None:
        cut += ["-ss", str(args.start)]
    if args.end is not None:
        cut += ["-to", str(args.end)]
    trim = ("silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB,"
            "areverse,silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB,areverse")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *cut, "-i", str(src),
                    "-af", trim, "-ac", "1", "-ar", "44100", "-sample_fmt", "s16", str(tmp)], check=True)

    # 2) two-pass loudnorm so it's a true linear gain, not a dynamic squash
    m = measure(tmp)
    ln = (f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA=11:linear=true:"
          f"measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
          f"measured_thresh={m['input_thresh']}:offset={m['target_offset']}")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(tmp), "-af", ln,
                    "-ac", "1", "-ar", "44100", "-sample_fmt", "s16", str(out)], check=True)
    tmp.unlink()

    dur = ffprobe_duration(out)
    final = measure(out)
    print(f"wrote {out}")
    print(f"  duration {dur:.1f}s   was {float(m['input_i']):.1f} LUFS -> now {float(final['input_i']):.1f} LUFS, peak {float(final['input_tp']):.1f} dBTP")
    if dur < 8:
        print("  WARNING: under 8 s. Cloning gets thin; use a longer stretch (--start/--end).")
    elif dur > 25:
        print("  WARNING: over 25 s. Fine, but the model only needs 10-20 s; trim to the cleanest part.")
    print("\nAdd to voices.json (edit instruct to describe the real speaker):")
    print(json.dumps({
        "name": args.name, "person": args.name.capitalize(), "ref": out.name,
        "instruct": "female, moderate pitch, young adult", "gain": 1.0, "speed": 1.0, "enabled": True,
    }, indent=2))


if __name__ == "__main__":
    main()
