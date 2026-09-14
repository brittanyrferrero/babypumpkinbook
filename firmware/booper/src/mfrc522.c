#include <string.h>
#include "mfrc522.h"
#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(mfrc522, LOG_LEVEL_DBG);

/* ── Low-level SPI register access ────────────────────────────────────── */
/* All accessors return 0 or a negative errno from the SPI driver, so a
 * failed bus transaction is distinguishable from a register that
 * legitimately reads 0x00. */

static int reg_write(struct mfrc522_dev *dev, uint8_t reg, uint8_t val)
{
	uint8_t tx[2] = { reg & 0x7E, val };
	struct spi_buf     buf    = { .buf = tx, .len = 2 };
	struct spi_buf_set tx_set = { .buffers = &buf, .count = 1 };
	gpio_pin_set_dt(&dev->cs, 1);  /* assert CS (active-low: logical 1 = physical LOW) */
	int rc = spi_write(dev->spi, &dev->spi_cfg, &tx_set);
	gpio_pin_set_dt(&dev->cs, 0);  /* deassert CS */
	return rc;
}

static int reg_read(struct mfrc522_dev *dev, uint8_t reg, uint8_t *val)
{
	uint8_t tx[2] = { 0x80 | reg, 0 };
	uint8_t rx[2] = { 0, 0 };
	struct spi_buf     tbuf   = { .buf = tx, .len = 2 };
	struct spi_buf     rbuf   = { .buf = rx, .len = 2 };
	struct spi_buf_set tx_set = { .buffers = &tbuf, .count = 1 };
	struct spi_buf_set rx_set = { .buffers = &rbuf, .count = 1 };
	gpio_pin_set_dt(&dev->cs, 1);  /* assert CS */
	int rc = spi_transceive(dev->spi, &dev->spi_cfg, &tx_set, &rx_set);
	gpio_pin_set_dt(&dev->cs, 0);  /* deassert CS */
	*val = rx[1];
	return rc;
}

static int reg_set_bits(struct mfrc522_dev *dev, uint8_t reg, uint8_t mask)
{
	uint8_t val;
	int rc = reg_read(dev, reg, &val);
	if (rc < 0) {
		return rc;
	}
	return reg_write(dev, reg, val | mask);
}

static int reg_clear_bits(struct mfrc522_dev *dev, uint8_t reg, uint8_t mask)
{
	uint8_t val;
	int rc = reg_read(dev, reg, &val);
	if (rc < 0) {
		return rc;
	}
	return reg_write(dev, reg, val & ~mask);
}

static int fifo_write(struct mfrc522_dev *dev, const uint8_t *data, uint8_t len)
{
	for (uint8_t i = 0; i < len; i++) {
		int rc = reg_write(dev, MFRC_FIFODataReg, data[i]);
		if (rc < 0) {
			return rc;
		}
	}
	return 0;
}

/* ── CRC helper ────────────────────────────────────────────────────────── */

static int pcd_calc_crc(struct mfrc522_dev *dev, const uint8_t *data, uint8_t len, uint8_t crc[2])
{
	if (reg_write(dev, MFRC_CommandReg, PCD_Idle) < 0 ||
	    reg_write(dev, MFRC_DivIrqReg, 0x04) < 0 ||       /* clear CRCIRq */
	    reg_set_bits(dev, MFRC_FIFOLevelReg, 0x80) < 0 || /* flush FIFO */
	    fifo_write(dev, data, len) < 0 ||
	    reg_write(dev, MFRC_CommandReg, PCD_CalcCRC) < 0) {
		return MFRC_BUS_ERROR;
	}

	int64_t deadline = k_uptime_get() + 50;
	while (k_uptime_get() < deadline) {
		uint8_t irq;
		if (reg_read(dev, MFRC_DivIrqReg, &irq) < 0) {
			return MFRC_BUS_ERROR;
		}
		if (irq & 0x04) {
			if (reg_write(dev, MFRC_CommandReg, PCD_Idle) < 0 ||
			    reg_read(dev, MFRC_CRCResultRegL, &crc[0]) < 0 ||
			    reg_read(dev, MFRC_CRCResultRegH, &crc[1]) < 0) {
				return MFRC_BUS_ERROR;
			}
			return MFRC_OK;
		}
		k_sleep(K_MSEC(1)); /* yield — don't busy-spin between register reads */
	}
	return MFRC_TIMEOUT;
}

/* ── Transceive ────────────────────────────────────────────────────────── */

static int pcd_transceive(struct mfrc522_dev *dev,
			   const uint8_t *tx_data, uint8_t tx_len,
			   uint8_t *rx_data, uint8_t *rx_len,
			   uint8_t *valid_bits)
{
	if (reg_write(dev, MFRC_CommandReg, PCD_Idle) < 0 ||
	    reg_set_bits(dev, MFRC_FIFOLevelReg, 0x80) < 0 ||
	    fifo_write(dev, tx_data, tx_len) < 0 ||
	    reg_write(dev, MFRC_BitFramingReg, valid_bits ? *valid_bits : 0) < 0 ||
	    /* Clear stale IRQ flags (Set1=0 → clear the bits that are set in bits[6:0]) */
	    reg_write(dev, MFRC_ComIrqReg, 0x7F) < 0 ||
	    reg_write(dev, MFRC_CommandReg, PCD_Transceive) < 0 ||
	    reg_set_bits(dev, MFRC_BitFramingReg, 0x80) < 0) { /* StartSend */
		return MFRC_BUS_ERROR;
	}

	/* Wait for completion (timeout ~25ms via timer config) */
	int64_t deadline = k_uptime_get() + 50;
	uint8_t irq = 0;
	do {
		if (reg_read(dev, MFRC_ComIrqReg, &irq) < 0) {
			return MFRC_BUS_ERROR;
		}
		if (irq & 0x30) break; /* RxIRq or IdleIRq */
		if (irq & 0x01) return MFRC_TIMEOUT; /* TimerIRq */
		k_sleep(K_MSEC(1)); /* yield — don't busy-spin between register reads */
	} while (k_uptime_get() < deadline);

	if (!(irq & 0x30)) return MFRC_TIMEOUT;

	uint8_t err;
	if (reg_read(dev, MFRC_ErrorReg, &err) < 0) {
		return MFRC_BUS_ERROR;
	}
	if (err & 0x13) return MFRC_ERROR; /* BufferOvfl, ParityErr, ProtocolErr */
	if (err & 0x08) return MFRC_COLLISION;

	uint8_t n;
	if (reg_read(dev, MFRC_FIFOLevelReg, &n) < 0) {
		return MFRC_BUS_ERROR;
	}
	if (rx_len && rx_data) {
		uint8_t copy = (n < *rx_len) ? n : *rx_len;
		*rx_len = copy;
		for (uint8_t i = 0; i < copy; i++) {
			if (reg_read(dev, MFRC_FIFODataReg, &rx_data[i]) < 0) {
				return MFRC_BUS_ERROR;
			}
		}
	}
	if (valid_bits) {
		uint8_t ctrl;
		if (reg_read(dev, MFRC_ControlReg, &ctrl) < 0) {
			return MFRC_BUS_ERROR;
		}
		*valid_bits = ctrl & 0x07;
	}
	return MFRC_OK;
}

/* ── Public API ────────────────────────────────────────────────────────── */

int mfrc522_init(struct mfrc522_dev *dev)
{
	if (!device_is_ready(dev->spi)) return -ENODEV;

	/* Configure CS as output deasserted (inactive = physical HIGH for active-low) */
	gpio_pin_configure_dt(&dev->cs, GPIO_OUTPUT_INACTIVE);

	/* Hardware reset via RST pin */
	gpio_pin_configure_dt(&dev->rst, GPIO_OUTPUT_ACTIVE);
	k_sleep(K_MSEC(10));
	gpio_pin_set_dt(&dev->rst, 0);
	k_sleep(K_MSEC(50));
	gpio_pin_set_dt(&dev->rst, 1);
	k_sleep(K_MSEC(50));

	/* Soft reset */
	if (reg_write(dev, MFRC_CommandReg, PCD_SoftReset) < 0) {
		return -EIO;
	}
	k_sleep(K_MSEC(50));

	/* Configure timer: auto, prescaler=169 → ~40kHz, reload=1000 → 25ms */
	if (reg_write(dev, MFRC_TModeReg,      0x80) < 0 ||
	    reg_write(dev, MFRC_TPrescalerReg, 0xA9) < 0 ||
	    reg_write(dev, MFRC_TReloadRegH,   0x03) < 0 ||
	    reg_write(dev, MFRC_TReloadRegL,   0xE8) < 0 ||
	    reg_write(dev, MFRC_TxASKReg, 0x40) < 0 ||  /* 100% ASK */
	    reg_write(dev, MFRC_ModeReg,  0x3D) < 0) {  /* CRC preset 6363h */
		return -EIO;
	}

	/* Antenna on */
	uint8_t tx;
	if (reg_read(dev, MFRC_TxControlReg, &tx) < 0) {
		return -EIO;
	}
	if (!(tx & 0x03)) {
		if (reg_set_bits(dev, MFRC_TxControlReg, 0x03) < 0) {
			return -EIO;
		}
	}
	return 0;
}

uint8_t mfrc522_read_version(struct mfrc522_dev *dev)
{
	uint8_t ver = 0;

	/* A bus error reads as 0x00, which callers already treat as "no reader" */
	if (reg_read(dev, MFRC_VersionReg, &ver) < 0) {
		return 0x00;
	}
	return ver;
}

/* SoftPowerDown: ~26mA antenna current → ~10µA. Antenna also goes off. */
void mfrc522_sleep(struct mfrc522_dev *dev)
{
	reg_clear_bits(dev, MFRC_TxControlReg, 0x03);
	reg_write(dev, MFRC_CommandReg, 0x10 | PCD_Idle);
}

void mfrc522_wake(struct mfrc522_dev *dev)
{
	reg_write(dev, MFRC_CommandReg, PCD_Idle);
	/* Bit clears automatically once oscillator stable; poll briefly */
	for (int i = 0; i < 50; i++) {
		uint8_t cmd;
		if (reg_read(dev, MFRC_CommandReg, &cmd) == 0 && !(cmd & 0x10)) {
			break;
		}
		k_sleep(K_MSEC(1));
	}
	reg_set_bits(dev, MFRC_TxControlReg, 0x03);
}

bool mfrc522_is_card_present(struct mfrc522_dev *dev)
{
	/* Reset baud rates (required before REQA per MFRC522 datasheet) */
	if (reg_write(dev, MFRC_TxModeReg,  0x00) < 0 ||
	    reg_write(dev, MFRC_RxModeReg,  0x00) < 0 ||
	    reg_write(dev, MFRC_ModWidthReg, 0x26) < 0) {
		return false;
	}

	reg_clear_bits(dev, MFRC_CollReg, 0x80);
	uint8_t cmd     = PICC_CMD_REQA;
	uint8_t atqa[2] = { 0, 0 };
	uint8_t atqa_len = 2;
	uint8_t vbits    = 7; /* Short frame: 7 bits */

	int rc = pcd_transceive(dev, &cmd, 1, atqa, &atqa_len, &vbits);
	return (rc == MFRC_OK || rc == MFRC_COLLISION);
}

int mfrc522_read_card_serial(struct mfrc522_dev *dev, struct mfrc522_uid *uid)
{
	/* ISO 14443A anti-collision + SELECT, handles 4-byte and 7-byte UIDs */
	static const uint8_t cl_cmd[2] = { PICC_CMD_ANTICOLL, PICC_CMD_SEL_CL2 };
	uint8_t buf[9];
	uint8_t buf_len, vbits;
	int rc;
	uint8_t uid_idx = 0;

	uid->size = 0;

	for (int cl = 0; cl < 2; cl++) {
		/* Anti-collision */
		reg_clear_bits(dev, MFRC_CollReg, 0x80);
		reg_write(dev, MFRC_BitFramingReg, 0x00);

		buf[0] = cl_cmd[cl];
		buf[1] = 0x20;
		buf_len = 5;
		vbits   = 0;

		rc = pcd_transceive(dev, buf, 2, &buf[2], &buf_len, &vbits);
		if (rc != MFRC_OK && rc != MFRC_COLLISION) return rc;
		if (buf_len < 5) return MFRC_ERROR;

		/* BCC: XOR of all 5 bytes must be 0 */
		if ((buf[2] ^ buf[3] ^ buf[4] ^ buf[5] ^ buf[6]) != 0) return MFRC_ERROR;

		/* SELECT: send [CLx, 0x70, uid0..3, bcc, crc_l, crc_h] */
		buf[1] = 0x70;
		uint8_t crc[2];
		rc = pcd_calc_crc(dev, buf, 7, crc);
		if (rc != MFRC_OK) return rc;
		buf[7] = crc[0];
		buf[8] = crc[1];

		uint8_t sak_buf[3] = {0};
		uint8_t sak_len = 3;
		uint8_t sak_vbits = 0;
		rc = pcd_transceive(dev, buf, 9, sak_buf, &sak_len, &sak_vbits);
		if (rc != MFRC_OK) return rc;

		uint8_t sak = sak_buf[0];
		uid->sak = sak;

		/* Copy UID bytes from this cascade level, skipping cascade tag (0x88) */
		bool has_ct  = (buf[2] == 0x88);
		uint8_t start = has_ct ? 1 : 0;
		uint8_t count = has_ct ? 3 : 4;
		for (uint8_t i = 0; i < count && uid_idx < MFRC_UID_MAX_BYTES; i++) {
			uid->bytes[uid_idx++] = buf[2 + start + i];
		}
		uid->size = uid_idx;

		/* SAK bit 2 set = UID incomplete, continue to next cascade level */
		if (!(sak & 0x04)) break;
	}

	return MFRC_OK;
}

/* ── NTAG2xx / Ultralight ──────────────────────────────────────────────── */

/* Send cmd+args with CRC_A appended; expect exactly `want` data bytes + CRC. */
static int ul_cmd(struct mfrc522_dev *dev, const uint8_t *cmd, uint8_t cmd_len,
		  uint8_t *out, uint8_t want)
{
	uint8_t tx[8];
	uint8_t crc[2];
	if (cmd_len + 2 > sizeof(tx)) return MFRC_ERROR;
	memcpy(tx, cmd, cmd_len);
	int rc = pcd_calc_crc(dev, tx, cmd_len, crc);
	if (rc != MFRC_OK) return rc;
	tx[cmd_len] = crc[0];
	tx[cmd_len + 1] = crc[1];

	uint8_t rx[18];
	uint8_t rx_len = sizeof(rx);
	uint8_t vbits = 0;
	rc = pcd_transceive(dev, tx, cmd_len + 2, rx, &rx_len, &vbits);
	if (rc != MFRC_OK) return rc;
	if (rx_len != want + 2) {
		/* NAK is a 4-bit reply (0x0, 0x1, 0x4, 0x5) */
		return (rx_len == 1 && vbits == 4) ? MFRC_ERROR : MFRC_TIMEOUT;
	}
	/* Verify CRC_A on the payload */
	rc = pcd_calc_crc(dev, rx, want, crc);
	if (rc != MFRC_OK) return rc;
	if (rx[want] != crc[0] || rx[want + 1] != crc[1]) return MFRC_ERROR;
	memcpy(out, rx, want);
	return MFRC_OK;
}

int mfrc522_ntag_read(struct mfrc522_dev *dev, uint8_t page, uint8_t out[16])
{
	uint8_t cmd[2] = { PICC_CMD_UL_READ, page };
	return ul_cmd(dev, cmd, 2, out, 16);
}

int mfrc522_ntag_get_version(struct mfrc522_dev *dev, uint8_t out[8])
{
	uint8_t cmd[1] = { PICC_CMD_GET_VER };
	return ul_cmd(dev, cmd, 1, out, 8);
}

int mfrc522_ntag_write(struct mfrc522_dev *dev, uint8_t page, const uint8_t data[4])
{
	uint8_t tx[8] = { PICC_CMD_UL_WRITE, page, data[0], data[1], data[2], data[3] };
	uint8_t crc[2];
	int rc = pcd_calc_crc(dev, tx, 6, crc);
	if (rc != MFRC_OK) return rc;
	tx[6] = crc[0];
	tx[7] = crc[1];

	/* Reply is a 4-bit ACK (0xA) or NAK. */
	uint8_t rx[2] = { 0 };
	uint8_t rx_len = sizeof(rx);
	uint8_t vbits = 0;
	rc = pcd_transceive(dev, tx, 8, rx, &rx_len, &vbits);
	if (rc != MFRC_OK) return rc;
	if (rx_len != 1 || vbits != 4) return MFRC_ERROR;
	return ((rx[0] & 0x0F) == 0x0A) ? MFRC_OK : MFRC_ERROR;
}

void mfrc522_halt(struct mfrc522_dev *dev)
{
	uint8_t tx[4] = { PICC_CMD_HLTA, 0x00, 0, 0 };
	uint8_t crc[2];
	if (pcd_calc_crc(dev, tx, 2, crc) != MFRC_OK) return;
	tx[2] = crc[0];
	tx[3] = crc[1];
	/* HLTA is answered by silence; a timeout is the success case. */
	(void)pcd_transceive(dev, tx, 4, NULL, NULL, NULL);
}
