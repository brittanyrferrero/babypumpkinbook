#pragma once
#include <zephyr/kernel.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/drivers/gpio.h>
#include <stdint.h>
#include <stdbool.h>

/* RC522 register addresses (pre-shifted left 1 per MFRC522 SPI protocol) */
#define MFRC_CommandReg    (0x01 << 1)
#define MFRC_ComIEnReg     (0x02 << 1)
#define MFRC_ComIrqReg     (0x04 << 1)
#define MFRC_ErrorReg      (0x06 << 1)
#define MFRC_Status2Reg    (0x08 << 1)
#define MFRC_FIFODataReg   (0x09 << 1)
#define MFRC_FIFOLevelReg  (0x0A << 1)
#define MFRC_ControlReg    (0x0C << 1)
#define MFRC_BitFramingReg (0x0D << 1)
#define MFRC_CollReg       (0x0E << 1)
#define MFRC_ModeReg       (0x11 << 1)
#define MFRC_TxModeReg     (0x12 << 1)
#define MFRC_RxModeReg     (0x13 << 1)
#define MFRC_TxControlReg  (0x14 << 1)
#define MFRC_TxASKReg      (0x15 << 1)
#define MFRC_ModWidthReg   (0x24 << 1)
#define MFRC_TModeReg      (0x2A << 1)
#define MFRC_TPrescalerReg (0x2B << 1)
#define MFRC_TReloadRegH   (0x2C << 1)
#define MFRC_TReloadRegL   (0x2D << 1)
#define MFRC_DivIrqReg     (0x05 << 1)
#define MFRC_CRCResultRegH (0x21 << 1)
#define MFRC_CRCResultRegL (0x22 << 1)
#define MFRC_VersionReg    (0x37 << 1)

/* PCD commands */
#define PCD_Idle           0x00
#define PCD_CalcCRC        0x03
#define PCD_Transceive     0x0C
#define PCD_SoftReset      0x0F

/* PICC commands */
#define PICC_CMD_REQA      0x26
#define PICC_CMD_ANTICOLL  0x93  /* CL1 anti-collision / select */
#define PICC_CMD_SEL_CL2   0x95  /* CL2 anti-collision / select */

/* Status codes */
#define MFRC_OK            0
#define MFRC_ERROR         1
#define MFRC_TIMEOUT       2
#define MFRC_COLLISION     3
#define MFRC_NO_ROOM       4
#define MFRC_BUS_ERROR     5   /* SPI transaction failed (nRF driver error, not chip) */

#define MFRC_UID_MAX_BYTES 10

struct mfrc522_uid {
	uint8_t size;
	uint8_t bytes[MFRC_UID_MAX_BYTES];
	uint8_t sak;
};

struct mfrc522_dev {
	const struct device *spi;
	struct spi_config spi_cfg;
	struct gpio_dt_spec cs;   /* manually controlled CS (bypasses SPI driver CS) */
	struct gpio_dt_spec rst;
};

int  mfrc522_init(struct mfrc522_dev *dev);
uint8_t mfrc522_read_version(struct mfrc522_dev *dev);
bool mfrc522_is_card_present(struct mfrc522_dev *dev);
int  mfrc522_read_card_serial(struct mfrc522_dev *dev, struct mfrc522_uid *uid);
void mfrc522_sleep(struct mfrc522_dev *dev);
void mfrc522_wake(struct mfrc522_dev *dev);

/* ── NTAG2xx / MIFARE Ultralight (ISO14443-3A Type 2) commands ─────────── */
#define PICC_CMD_HLTA      0x50
#define PICC_CMD_UL_READ   0x30  /* 4 pages (16 bytes) from page N */
#define PICC_CMD_UL_WRITE  0xA2  /* 4 bytes to page N */
#define PICC_CMD_GET_VER   0x60  /* NTAG21x GET_VERSION, 8 bytes */

/* Card must already be selected (mfrc522_read_card_serial). */
int mfrc522_ntag_read(struct mfrc522_dev *dev, uint8_t page, uint8_t out[16]);
int mfrc522_ntag_write(struct mfrc522_dev *dev, uint8_t page, const uint8_t data[4]);
int mfrc522_ntag_get_version(struct mfrc522_dev *dev, uint8_t out[8]);
void mfrc522_halt(struct mfrc522_dev *dev);
