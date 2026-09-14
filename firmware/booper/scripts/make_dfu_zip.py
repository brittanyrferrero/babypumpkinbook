#!/usr/bin/env python3
"""
Generate a DFU v1 zip package (manifest.json + zephyr.bin + zephyr.dat) for
the nice!nano / Adafruit nRF52840 bootloader.

adafruit-nrfutil pkg generate crashes on Python 3 (iteritems bug), so this
script replicates the minimum necessary: CRC16 init packet + manifest.

NVS clearing is handled in firmware via version-based factory reset
not by padding the binary.

Usage:
    python3 make_dfu_zip.py <zephyr.bin> <output.zip> [app_version]

app_version defaults to 255 (0xFF).
"""
import sys, struct, zipfile, json, os

from dfu_common import calc_crc16  # same dir — vendored CRC16-CCITT


def make_dfu_zip(bin_path, zip_path, app_version=255):
    with open(bin_path, 'rb') as f:
        firmware = f.read()

    sp, reset = struct.unpack_from('<II', firmware, 0)
    print(f"Binary: {len(firmware)} bytes  SP=0x{sp:08X}  Reset=0x{reset:08X}")
    if reset < 0x26000:
        print(f"WARNING: Reset=0x{reset:08X} < 0x26000 — firmware linked at wrong address!")
        sys.exit(1)

    fw_crc = calc_crc16(firmware, crc=0xFFFF)
    print(f"CRC16 = 0x{fw_crc:04X} ({fw_crc})")

    # DFU v1 init packet: dev_type, dev_rev, app_ver, sd_count, sd_id[0], crc16
    # sd_id=0xFFFE: "no SoftDevice required" — confirmed working with nice!nano bootloader
    dat = struct.pack('<HHIHH',
        0x0052,      # device_type = nRF52
        0xFFFF,      # device_revision = any
        app_version,
        1,           # one SD requirement
        0xFFFE,      # no SoftDevice required
    ) + struct.pack('<H', fw_crc)

    manifest = {
        "manifest": {
            "dfu_version": 0.5,
            "application": {
                "bin_file": "zephyr.bin",
                "dat_file": "zephyr.dat",
                "init_packet_data": {
                    "device_type": 0x0052,
                    "device_revision": 0xFFFF,
                    "application_version": app_version,
                    "softdevice_req": [0x00B6],
                    "firmware_crc16": fw_crc,
                }
            }
        }
    }

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('zephyr.bin', firmware)
        z.writestr('zephyr.dat', dat)
        z.writestr('manifest.json', json.dumps(manifest, indent=2))

    print(f"Created {zip_path} ({os.path.getsize(zip_path)} bytes)")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <zephyr.bin> <output.zip> [app_version]")
        sys.exit(1)
    ver = int(sys.argv[3]) if len(sys.argv) > 3 else 255
    make_dfu_zip(sys.argv[1], sys.argv[2], ver)
