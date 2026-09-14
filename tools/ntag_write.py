#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyserial>=3.5"]
# ///
"""
Host side of the NTAG writer board ("the booper"). See TAG-WRITER.md.

    uv run ntag_write.py --url https://example.com            # write one tag
    uv run ntag_write.py --url https://example.com --count 10 # write ten tags
    uv run ntag_write.py --read                               # dump next tag
    uv run ntag_write.py --read --loop                        # dump every tag
    uv run ntag_write.py --format                             # CC-format a blank tag

Port auto-detects the board (USB product string "NTAG Writer"); override
with --port /dev/ttyACM0.
"""
import argparse
import sys
import time

import serial
from serial.tools import list_ports


def find_port():
    """The board exposes two CDC ports (the Feather board dts adds one of its
    own); probe each candidate and keep the one that answers STATUS."""
    cands = []
    for p in list_ports.comports():
        desc = f"{p.product or ''} {p.description or ''} {p.manufacturer or ''}"
        if "NTAG Writer" in desc or "rfid-thread-scanner" in desc:
            cands.append(p.device)
    for dev in sorted(cands, reverse=True):
        try:
            with serial.Serial(dev, 115200, timeout=0.3) as ser:
                time.sleep(0.3)
                ser.reset_input_buffer()
                ser.write(b"s\n")
                ser.flush()
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if ser.readline().decode(errors="replace").startswith("STATUS"):
                        return dev
        except serial.SerialException:
            continue
    return None


def send(ser, line):
    ser.write((line + "\n").encode())
    ser.flush()


def expect(ser, prefixes, timeout):
    """Read lines until one starts with any prefix; return it (or None)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = ser.readline()
        if not raw:
            continue
        line = raw.decode(errors="replace").strip()
        if not line:
            continue
        print(f"  < {line}")
        for p in prefixes:
            if line.startswith(p):
                return line
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="serial port (default: auto-detect)")
    ap.add_argument("--url", help="URL to write")
    ap.add_argument("--count", type=int, default=1, help="number of tags to write (0 = until Ctrl-C)")
    ap.add_argument("--read", action="store_true", help="read tags instead of writing")
    ap.add_argument("--loop", action="store_true", help="with --read: keep reading until Ctrl-C")
    ap.add_argument("--format", action="store_true", help="write the NDEF capability container on a blank tag")
    ap.add_argument("--timeout", type=float, default=60.0, help="seconds to wait per tag")
    args = ap.parse_args()

    port = args.port or find_port()
    if not port:
        sys.exit("No NTAG Writer board found. Is it plugged in and running the ntag-writer firmware? Use --port.")
    print(f"port: {port}")

    with serial.Serial(port, 115200, timeout=0.2) as ser:
        time.sleep(0.3)
        send(ser, "x")
        send(ser, "s")
        if not expect(ser, ["STATUS"], 5):
            sys.exit("Board did not answer. Unplug/replug and retry.")

        if args.read:
            send(ser, "rl" if args.loop else "r")
            expect(ser, ["OK"], 2)
            try:
                while True:
                    if not expect(ser, ["URL", "ERR"], args.timeout):
                        print("timed out waiting for a tag")
                        break
                    if not args.loop:
                        break
            except KeyboardInterrupt:
                pass
            send(ser, "x")
            return

        if args.format:
            send(ser, "f")
            expect(ser, ["OK"], 2)
            expect(ser, ["FORMATTED", "ERR"], args.timeout)
            return

        if not args.url:
            sys.exit("--url is required unless --read or --format")

        send(ser, f"url {args.url}")
        ok = expect(ser, ["OK", "ERR"], 3)
        if not ok or not ok.startswith("OK"):
            sys.exit("board rejected the URL")

        send(ser, "wl" if args.count != 1 else "w")
        expect(ser, ["OK"], 2)
        done = 0
        try:
            while args.count == 0 or done < args.count:
                print(f"present tag {done + 1}" + (f"/{args.count}" if args.count else "") + " ...")
                line = expect(ser, ["WROTE", "ERR"], args.timeout)
                if line is None:
                    print("timed out waiting for a tag")
                    break
                if line.startswith("WROTE"):
                    done += 1
        except KeyboardInterrupt:
            pass
        finally:
            send(ser, "x")
        print(f"wrote {done} tag(s)")


if __name__ == "__main__":
    main()
