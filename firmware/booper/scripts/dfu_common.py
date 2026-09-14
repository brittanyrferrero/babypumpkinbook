#!/usr/bin/env python3
"""
Shared plumbing for the bench flashing tools (dfu_flash.py, check_bootloader.py,
update_bootloader.py, make_dfu_zip.py):

  - advisory DFU lock — one DFU conversation at a time (a scanner board has
    already been bricked by concurrent DFU operations)
  - serial-port candidate listing (TC66 power meter excluded)
  - LabJack U3 double-tap DFU trigger
  - CRC16-CCITT + HCI/SLIP framing helpers, vendored (as native-bytes ports)
    from the archived pc-nrfutil's nordicsemi.dfu — the only five functions we
    ever used. Vendoring removes the fragile `nrfutil>=5.2,<7` pin and the
    bytes-vs-str API probing it forced on every caller.
"""
import fcntl
import glob
import os
import sys
import time

# ── Advisory DFU lock ─────────────────────────────────────────────────────────
DFU_LOCK_PATH = '/tmp/booper-dfu.lock'


def acquire_dfu_lock(path=DFU_LOCK_PATH):
    """Take the global DFU lock (non-blocking). Call BEFORE any DFU trigger or
    serial open, and keep the returned file handle alive for the whole DFU
    conversation — dropping it releases the lock. Exits loudly if another DFU
    operation already holds it: two concurrent DFU ops have bricked a board.
    """
    f = open(path, 'a')
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        print(f"ERROR: another DFU operation is in progress (lock: {path}).")
        print("Wait for it to finish — concurrent DFU ops can brick the board.")
        sys.exit(1)
    f.seek(0)
    f.truncate()
    f.write(f"{os.getpid()}\n")
    f.flush()
    return f


# ── Serial port candidates ────────────────────────────────────────────────────
EXCLUDE_PORTS = {'TC661'}  # TC66 power meter — never a DFU target


def list_candidate_ports(exclude=EXCLUDE_PORTS):
    """All /dev/cu.usbmodem* ports minus known non-targets."""
    return [p for p in glob.glob('/dev/cu.usbmodem*')
            if not any(x in p for x in exclude)]


# ── LabJack U3 double-tap (FIO4 → board RST) ──────────────────────────────────
def labjack_double_tap():
    """Double-tap reset via LabJack U3, FIO4 → board RST, to enter DFU mode."""
    try:
        import u3
    except ImportError as e:
        raise RuntimeError(
            "LabJack U3 support needs: pip install LabJackPython"
        ) from e

    print("Connecting to LabJack...")
    d = u3.U3()
    try:
        d.configIO(FIOAnalog=0)
        d.setFIOState(4, 1)
        time.sleep(0.1)
        # Single tap to exit any current state
        d.setFIOState(4, 0); time.sleep(0.35)
        d.setFIOState(4, 1); time.sleep(2.0)   # wait for blink to start
        # Double-tap for DFU
        print("Double-tap for DFU...")
        d.setFIOState(4, 0); time.sleep(0.35)
        d.setFIOState(4, 1); time.sleep(0.10)
        d.setFIOState(4, 0); time.sleep(0.35)
        d.setFIOState(4, 1)
    finally:
        d.close()


# ── Vendored from pc-nrfutil (nordicsemi.dfu.crc16 / .util), ported to bytes ──
# The DFU v1 HCI serial protocol is frozen (fixed legacy bootloader), so there
# is no upstream to track. Verified byte-for-byte against nrfutil 5.2.0.

def calc_crc16(binary_data, crc=0xffff):
    """CRC16-CCITT (poly 0x1021, init 0xFFFF) over bytes."""
    for b in binary_data:
        crc = (crc >> 8 & 0x00FF) | (crc << 8 & 0xFF00)
        crc ^= b
        crc ^= (crc & 0x00FF) >> 4
        crc ^= (crc << 8) << 4
        crc ^= ((crc & 0x00FF) << 4) << 1
    return crc & 0xFFFF


def slip_parts_to_four_bytes(seq, dip, rp, pkt_type, pkt_len):
    """Build the 4-byte HCI packet header. Returns bytes."""
    ints = [0, 0, 0, 0]
    ints[0] = seq | (((seq + 1) % 8) << 3) | (dip << 6) | (rp << 7)
    ints[1] = pkt_type | ((pkt_len & 0x000F) << 4)
    ints[2] = (pkt_len & 0x0FF0) >> 4
    ints[3] = (~(sum(ints[0:3])) + 1) & 0xFF
    return bytes(ints)


def slip_encode_esc_chars(data_in):
    """SLIP-escape bytes: 0xC0 → 0xDB 0xDC, 0xDB → 0xDB 0xDD. Returns bytes."""
    result = bytearray()
    for char in data_in:
        if char == 0xC0:
            result.extend([0xDB, 0xDC])
        elif char == 0xDB:
            result.extend([0xDB, 0xDD])
        else:
            result.append(char)
    return bytes(result)


def int16_to_bytes(value):
    """int → 2 bytes little-endian."""
    return bytes([value & 0x00FF,
                  (value & 0xFF00) >> 8])


def int32_to_bytes(value):
    """int → 4 bytes little-endian."""
    return bytes([value & 0x000000FF,
                  (value & 0x0000FF00) >> 8,
                  (value & 0x00FF0000) >> 16,
                  (value & 0xFF000000) >> 24])
