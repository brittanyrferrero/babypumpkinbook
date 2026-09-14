# Booper firmware

Zephyr app for the tag-writer board: Elecrow/nice!nano-style nRF52840 with an
RC522 reader on SPI. It exposes a USB serial console; `tools/ntag_write.py`
at the repo root talks to it. `ntag_writer_v2.zip` is the exact image the
booper was flashed with on 2026-09-12. You should never need this folder
unless the board is wiped.

```
src/main.c          console protocol + NDEF URI writer
src/mfrc522.c/.h    RC522 driver with NTAG read/write/GET_VERSION/HALT
boards/*.overlay    pins: SCK P0.17, MOSI P0.22, MISO P0.20, CS P0.09, RST P0.08, NFC power P0.29
prj.conf            USB CDC console, legacy USB stack, RC low-frequency clock
pm_static.yml       app at 0x26000 behind the Adafruit/nice!nano bootloader
scripts/            DFU v1 serial flasher + zip packager (pyserial only)
```

## Reflashing a wiped board

1. Plug in with a data cable. Double-tap the tiny reset button; the LED
   starts a slow pulse and a `nice!nano` serial port appears
   (`/dev/cu.usbmodem…` on Mac, `/dev/ttyACM0` on Linux).
2. From this folder:
   ```
   uv venv .venv && uv pip install --python .venv/bin/python -r scripts/requirements-dfu.txt
   .venv/bin/python scripts/dfu_flash.py ntag_writer_v2.zip --port /dev/cu.usbmodemXXXX
   ```
   Twenty seconds later it says `Flash SUCCESS` and the board comes back as
   `NTAG Writer`. The LabJack lines in the flasher are an optional bench
   convenience; without one it just asks you to double-tap by hand.

Don't try `arduino-cli`, `nrfjprog`, or the 1200-baud reset trick; this
bootloader ignores them. Only the double-tap plus `dfu_flash.py` works.

## Rebuilding (needs an nRF Connect SDK workspace)

Built against NCS at `nrf 85bc99f5` / `zephyr 05f26996`.

```
west build -p -d build_booper -b adafruit_feather_nrf52840/nrf52840/uf2 firmware/booper
python3 firmware/booper/scripts/make_dfu_zip.py build_booper/booper/zephyr/zephyr.bin ntag_writer_v3.zip
```

Two gotchas already handled in the config, in case you touch it: the board
definition's spi1 uses the legacy nrfx SPI driver, which breaks USB CDC, so
the overlay disables it; and the LF clock must be the RC oscillator because
this board has no 32 kHz crystal. The overlay also disables the board's spare
CDC port, so a v3 build enumerates with a single serial port (v2 has two;
`ntag_write.py` handles either).
