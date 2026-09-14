#!/usr/bin/env python3
"""
DFU v1 serial flash with extended ACK timeout (10s vs stock 1s).
Implements Nordic DFU v1 HCI serial protocol compatible with
Adafruit Feather nRF52840 0.9.1 bootloader.
"""
import sys
import os
import time
import zipfile
import tempfile
import shutil
import glob
import struct
from datetime import datetime, timedelta

from serial import Serial
import dfu_common
from dfu_common import (
    calc_crc16, slip_parts_to_four_bytes, slip_encode_esc_chars,
    int16_to_bytes, int32_to_bytes
)

# ── DFU v1 protocol constants ─────────────────────────────────────────────────
DATA_INTEGRITY_CHECK_PRESENT = 1
RELIABLE_PACKET = 1
HCI_PACKET_TYPE = 14

DFU_INIT_PACKET       = 1
DFU_START_PACKET      = 3
DFU_DATA_PACKET       = 4
DFU_STOP_DATA_PACKET  = 5
DFU_UPDATE_MODE_APP   = 4

ACK_PACKET_TIMEOUT   = 10.0   # Extended from stock 1.0 → 10.0 seconds
FLASH_PAGE_SIZE       = 4096
FLASH_PAGE_ERASE_TIME = 0.0897   # 89.7ms per page (nRF52840 max)
FLASH_WORD_WRITE_TIME = 0.000100  # 100μs per word
FLASH_PAGE_WRITE_TIME = 0.500  # 500ms between page groups (conservative)
DFU_PACKET_MAX_SIZE   = 512
INTER_PACKET_DELAY    = 0.005  # 5ms between every packet

_seq = 0  # global HCI sequence counter


def _make_packet(data_ints):
    """Build a SLIP-encoded HCI packet from a list of ints. Returns bytes."""
    global _seq
    _seq = (_seq + 1) % 8

    # HCI header (4 bytes)
    header = slip_parts_to_four_bytes(
        _seq,
        DATA_INTEGRITY_CHECK_PRESENT,
        RELIABLE_PACKET,
        HCI_PACKET_TYPE,
        len(data_ints)
    )

    # Build payload (header + data)
    payload = list(header) + data_ints

    # CRC16 over header+data
    crc = calc_crc16(bytes(payload), crc=0xffff)
    payload_ints = payload + [crc & 0xFF, (crc >> 8) & 0xFF]

    # SLIP encode
    encoded = slip_encode_esc_chars(bytes(payload_ints))

    # Frame with 0xC0 delimiters
    return b'\xC0' + encoded + b'\xC0'


def _get_ack(ser, timeout=ACK_PACKET_TIMEOUT):
    """Wait for HCI ACK frame. Returns ACK seq number, or raises on timeout."""
    buf = []
    t0 = datetime.now()

    while buf.count(0xC0) < 2:
        chunk = ser.read(6)
        if chunk:
            buf += list(chunk)
        if (datetime.now() - t0).total_seconds() > timeout:
            elapsed = (datetime.now() - t0).total_seconds()
            raise TimeoutError(f"ACK timeout after {elapsed:.1f}s (limit={timeout}s)")

    # Decode SLIP escapes
    decoded = []
    i = 0
    while i < len(buf):
        b = buf[i]
        if b == 0xDB and i + 1 < len(buf):
            b2 = buf[i + 1]
            decoded.append(0xC0 if b2 == 0xDC else 0xDB if b2 == 0xDD else b2)
            i += 2
        else:
            decoded.append(b)
            i += 1

    # Strip 0xC0 delimiters
    while decoded and decoded[0] == 0xC0:
        decoded.pop(0)
    while decoded and decoded[-1] == 0xC0:
        decoded.pop()

    if not decoded:
        raise RuntimeError("Empty ACK frame")

    return (decoded[0] >> 3) & 0x07


def _warn_ack_mismatch(ack):
    """Warn if the ACK seq differs from the expected (_seq + 1) % 8 (HCI
    reliable-transport contract) — a stale/duplicate ACK may mean the
    bootloader never consumed the packet. WARNING only, never abort:
    aborting mid-DFU is how boards brick."""
    expected = (_seq + 1) % 8
    if ack != expected:
        print(f"\n  WARNING: ACK seq {ack} != expected {expected} "
              f"(stale/duplicate ACK?)")


def _send(ser, data_ints, label=""):
    """Send a DFU packet and wait for ACK. Returns elapsed ACK time."""
    pkt = _make_packet(data_ints)
    t0 = time.monotonic()
    ser.write(pkt)
    ack = _get_ack(ser)
    elapsed = time.monotonic() - t0
    _warn_ack_mismatch(ack)
    if label:
        print(f"  {label} → ACK={ack} ({elapsed*1000:.0f}ms)")
    return elapsed


def _ints_from(s):
    """Convert bytes from int32_to_bytes/int16_to_bytes to list of ints."""
    return list(s)


def flash_zip(port, zip_path, single_bank=True):
    # Unpack zip
    tmpdir = tempfile.mkdtemp(prefix='dfu_v1_')
    try:
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(tmpdir)

        # Find bin/dat files from manifest
        import json
        with open(os.path.join(tmpdir, 'manifest.json')) as f:
            manifest = json.load(f)
        app = manifest['manifest']['application']
        bin_path = os.path.join(tmpdir, app['bin_file'])
        dat_path = os.path.join(tmpdir, app['dat_file'])

        with open(bin_path, 'rb') as f:
            firmware = f.read()
        with open(dat_path, 'rb') as f:
            init_packet = f.read()
    finally:
        pass  # keep tmpdir alive

    app_size = len(firmware)
    total_pages = (app_size // FLASH_PAGE_SIZE) + 1
    # Erase is on-demand page-by-page as data arrives; the 500ms inter-page
    # delay covers each page erase (~89.7ms max). Only the first page needs
    # upfront time. Cap at 6s to avoid exceeding the bootloader activity timeout.
    erase_wait = min(max(0.5, total_pages * FLASH_PAGE_ERASE_TIME), 6.0)
    if single_bank:
        activate_wait = FLASH_PAGE_ERASE_TIME + FLASH_PAGE_WRITE_TIME
    else:
        activate_wait = erase_wait + total_pages * FLASH_PAGE_WRITE_TIME

    print(f"\nFlashing {os.path.basename(zip_path)}")
    print(f"  firmware: {app_size} bytes, {total_pages} pages")
    print(f"  erase wait: {erase_wait:.2f}s, activate wait: {activate_wait:.2f}s")
    print(f"  port: {port}, ACK timeout: {ACK_PACKET_TIMEOUT}s")

    global _seq
    _seq = 0

    with Serial(port=port, baudrate=115200, timeout=ACK_PACKET_TIMEOUT) as ser:
        time.sleep(0.2)

        # ── START DFU ──────────────────────────────────────────────────────
        frame  = _ints_from(int32_to_bytes(DFU_START_PACKET))
        frame += _ints_from(int32_to_bytes(DFU_UPDATE_MODE_APP))
        frame += _ints_from(int32_to_bytes(0))            # SD size
        frame += _ints_from(int32_to_bytes(0))            # BL size
        frame += _ints_from(int32_to_bytes(app_size))     # APP size
        _send(ser, frame, "START DFU")

        print(f"  waiting {erase_wait:.2f}s for flash erase...", flush=True)
        time.sleep(erase_wait)

        # ── INIT PACKET (.dat) ─────────────────────────────────────────────
        frame  = _ints_from(int32_to_bytes(DFU_INIT_PACKET))
        frame += list(init_packet)
        frame += _ints_from(int16_to_bytes(0x0000))  # padding
        _send(ser, frame, "INIT")

        # ── FIRMWARE DATA ──────────────────────────────────────────────────
        print("  sending firmware...", flush=True)
        total_pkts = (app_size + DFU_PACKET_MAX_SIZE - 1) // DFU_PACKET_MAX_SIZE
        slow_acks = []

        for pkt_i, offset in enumerate(range(0, app_size, DFU_PACKET_MAX_SIZE)):
            chunk = firmware[offset:offset + DFU_PACKET_MAX_SIZE]
            frame  = _ints_from(int32_to_bytes(DFU_DATA_PACKET))
            frame += list(chunk)

            t0 = time.monotonic()
            pkt_bytes = _make_packet(frame)
            ser.write(pkt_bytes)
            try:
                ack = _get_ack(ser)
            except TimeoutError:
                # Retry: roll back seq and rebuild packet so HCI seq is correct
                _seq = (_seq - 1) % 8
                time.sleep(1.0)
                ser.reset_input_buffer()
                pkt_bytes = _make_packet(frame)
                ser.write(pkt_bytes)
                ack = _get_ack(ser)
            elapsed = time.monotonic() - t0
            _warn_ack_mismatch(ack)
            time.sleep(INTER_PACKET_DELAY)

            if elapsed > 0.5:
                slow_acks.append((pkt_i, elapsed))

            print(f"\r  [{pkt_i+1:4d}/{total_pkts}] {(offset+len(chunk))/1024:.1f}KB  ACK={ack} {elapsed*1000:.0f}ms  ",
                  end='', flush=True)

            # Flash page write delay AFTER first packet of each new group (Adafruit timing)
            if pkt_i % 8 == 0:
                time.sleep(FLASH_PAGE_WRITE_TIME)

        time.sleep(FLASH_PAGE_WRITE_TIME)  # last page
        print()

        if slow_acks:
            print(f"  Slow ACKs (>500ms):")
            for p, t in slow_acks:
                print(f"    pkt {p}: {t*1000:.0f}ms")

        # ── STOP ───────────────────────────────────────────────────────────
        frame = _ints_from(int32_to_bytes(DFU_STOP_DATA_PACKET))
        _send(ser, frame, "STOP")

    print(f"  waiting {activate_wait:.2f}s for activation...")
    time.sleep(activate_wait)
    print("Flash SUCCESS ✓")

    shutil.rmtree(tmpdir, ignore_errors=True)


# ── Entry point: double-tap then flash ────────────────────────────────────────
# LabJack double-tap + port exclusions live in dfu_common (shared with
# update_bootloader.py and check_bootloader.py).
double_tap_reset = dfu_common.labjack_double_tap

EXCLUDE_PORTS = dfu_common.EXCLUDE_PORTS

def wait_for_port(timeout=10, exclude=EXCLUDE_PORTS, verbose=False):
    deadline = time.time() + timeout
    seen = set()
    while time.time() < deadline:
        all_ports = set(glob.glob("/dev/cu.usbmodem*"))
        new = all_ports - seen
        if new and verbose:
            print(f"  [port appeared: {new}]")
        seen |= all_ports
        ports = [p for p in all_ports if not any(x in p for x in exclude)]
        if ports:
            time.sleep(0.4)
            ports = dfu_common.list_candidate_ports(exclude)
            return ports[0] if ports else None
        time.sleep(0.2)
    if verbose:
        print(f"  [ports seen during wait: {seen}]")
    return None


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='Flash nRF52840 firmware via DFU')
    parser.add_argument('zip_path', help='DFU zip to flash (from make_dfu_zip.py)')
    parser.add_argument('--port', metavar='PORT', help='DFU serial port (skip auto-detect)')
    args = parser.parse_args()

    # Validate the zip BEFORE touching the board — a bad path must not leave
    # the board reset into DFU mode with nothing to flash.
    if not os.path.isfile(args.zip_path):
        print(f"ERROR: firmware zip not found: {args.zip_path}")
        sys.exit(1)
    try:
        with zipfile.ZipFile(args.zip_path) as z:
            if 'manifest.json' not in z.namelist():
                print(f"ERROR: no manifest.json in {args.zip_path} — not a DFU zip")
                sys.exit(1)
    except zipfile.BadZipFile:
        print(f"ERROR: not a valid zip: {args.zip_path}")
        sys.exit(1)

    # One DFU conversation at a time — concurrent DFU ops have bricked a board.
    # Handle must stay alive through flash + activation wait (process lifetime).
    _dfu_lock = dfu_common.acquire_dfu_lock()

    if args.port:
        port = args.port
    else:
        # If the board is already in DFU mode, use it immediately — no reset needed.
        pre_ports = dfu_common.list_candidate_ports()
        if pre_ports:
            port = pre_ports[0]
            print(f"Bootloader already present at {port} — skipping reset")
        else:
            # Board is in app mode. Watch for the DFU port in a background thread
            # BEFORE triggering the double-tap so we don't miss the window.
            import threading
            found_port = [None]
            stop_evt   = threading.Event()

            def _watch():
                found_port[0] = wait_for_port(timeout=30, verbose=True)
                stop_evt.set()

            watcher = threading.Thread(target=_watch, daemon=True)
            watcher.start()

            try:
                double_tap_reset()
            except Exception as e:
                print(f"LabJack not available ({e.__class__.__name__}): manual mode")
                print("Double-tap the reset button now to enter bootloader...")

            stop_evt.wait(timeout=30)
            port = found_port[0]
    if not port:
        print("ERROR: Bootloader port not found")
        sys.exit(1)
    print(f"Bootloader at {port}")

    flash_zip(port, args.zip_path, single_bank=True)
