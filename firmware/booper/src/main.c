/*
 * NTAG NDEF-URL writer for the Elecrow nRF52840 + RC522 scanner board.
 *
 * Bench tool: sits on USB CDC-ACM, takes a URL over the console, and writes
 * an NDEF URI record onto every NTAG213/215/216 (or MIFARE Ultralight) tag
 * that is presented. Phones open the URL on tap. Not a Thread build.
 *
 * Console protocol (line based, machine-friendly first token):
 *   url <text>   set the URL           -> OK url=.. ndef=N fits213=y|n
 *   w            arm one write         -> WROTE uid=.. | ERR ..
 *   wl           write every tag       -> WROTE .. per tag, until 'x'
 *   r            read next tag         -> TAG .. / URL ..
 *   rl           read every tag
 *   f            force-format CC only  -> FORMATTED ..
 *   x            disarm
 *   s            status
 *   ?            help
 */
#include <zephyr/kernel.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/usb/usb_device.h>
#include <zephyr/sys/printk.h>
#include <string.h>
#include <ctype.h>
#include <stdio.h>
#include "mfrc522.h"

#define FW_VERSION      "1"
#define SPI_NODE        DT_NODELABEL(spi3)
#define POLL_MS         100
#define URL_MAX         200
#define NDEF_MAX        (URL_MAX + 16)
#define USER_PAGE0      4          /* Type 2 user memory starts at page 4 */
#define NTAG_MAX_USER   888        /* NTAG216 */

/* ── Hardware ────────────────────────────────────────────────────────────── */

static struct mfrc522_dev rc522 = {
	.spi = NULL,
	.spi_cfg = {
		.frequency = 1000000,
		.operation = SPI_WORD_SET(8) | SPI_TRANSFER_MSB | SPI_OP_MODE_MASTER,
	},
	.cs  = GPIO_DT_SPEC_GET_BY_IDX(DT_NODELABEL(spi3), cs_gpios, 0),
	.rst = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), rst_gpios),
};

static const struct gpio_dt_spec nfc_en =
	GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), nfc_en_gpios);

static const struct device *usb_uart_dev;
static bool rc522_ok;

/* ── State ───────────────────────────────────────────────────────────────── */

enum mode { MODE_IDLE, MODE_WRITE, MODE_WRITE_LOOP, MODE_READ, MODE_READ_LOOP, MODE_FORMAT };
static enum mode mode = MODE_IDLE;
static char url[URL_MAX + 1];
static uint8_t ndef[NDEF_MAX];
static size_t ndef_len;
static unsigned writes_ok, writes_err;

static const char *mode_name(enum mode m)
{
	switch (m) {
	case MODE_IDLE:       return "idle";
	case MODE_WRITE:      return "write-once";
	case MODE_WRITE_LOOP: return "write-loop";
	case MODE_READ:       return "read-once";
	case MODE_READ_LOOP:  return "read-loop";
	case MODE_FORMAT:     return "format";
	}
	return "?";
}

/* ── NDEF ────────────────────────────────────────────────────────────────── */

/* NFC Forum URI record well-known prefixes (longest first so they win). */
static const struct { const char *s; uint8_t code; } uri_prefix[] = {
	{ "https://www.", 0x02 },
	{ "http://www.",  0x01 },
	{ "https://",     0x04 },
	{ "http://",      0x03 },
};

/* Build TLV-wrapped NDEF message with a single URI record. Returns length or -1. */
static int build_ndef(const char *u, uint8_t *out, size_t cap)
{
	uint8_t code = 0x00;
	const char *rest = u;
	for (size_t i = 0; i < ARRAY_SIZE(uri_prefix); i++) {
		size_t n = strlen(uri_prefix[i].s);
		if (strncmp(u, uri_prefix[i].s, n) == 0) {
			code = uri_prefix[i].code;
			rest = u + n;
			break;
		}
	}
	size_t rest_len = strlen(rest);
	size_t payload_len = 1 + rest_len;          /* prefix code + text */
	if (payload_len > 255) return -1;           /* short record only */
	size_t msg_len = 4 + payload_len;           /* hdr, type len, payload len, type */

	size_t p = 0;
	out[p++] = 0x03;                            /* NDEF Message TLV */
	if (msg_len < 0xFF) {
		out[p++] = (uint8_t)msg_len;
	} else {
		out[p++] = 0xFF;
		out[p++] = (uint8_t)(msg_len >> 8);
		out[p++] = (uint8_t)(msg_len & 0xFF);
	}
	if (p + msg_len + 1 > cap) return -1;
	out[p++] = 0xD1;                            /* MB|ME|SR, TNF=well-known */
	out[p++] = 0x01;                            /* type length */
	out[p++] = (uint8_t)payload_len;
	out[p++] = 'U';
	out[p++] = code;
	memcpy(&out[p], rest, rest_len);
	p += rest_len;
	out[p++] = 0xFE;                            /* Terminator TLV */
	return (int)p;
}

/* Parse a URI record out of user memory; returns true and fills `dst`. */
static bool parse_ndef_url(const uint8_t *mem, size_t len, char *dst, size_t cap)
{
	size_t p = 0;
	while (p < len) {
		uint8_t t = mem[p++];
		if (t == 0x00) continue;               /* NULL TLV */
		if (t == 0xFE) return false;           /* terminator */
		if (p >= len) return false;
		size_t l = mem[p++];
		if (l == 0xFF) {
			if (p + 2 > len) return false;
			l = (mem[p] << 8) | mem[p + 1];
			p += 2;
		}
		if (t != 0x03) { p += l; continue; }    /* skip non-NDEF TLV */
		if (p + l > len || l < 5) return false;
		const uint8_t *r = &mem[p];
		uint8_t hdr = r[0];
		if ((hdr & 0x07) != 0x01 || !(hdr & 0x10)) return false; /* well-known, SR */
		uint8_t tl = r[1];
		uint8_t pl = r[2];
		size_t off = 3 + ((hdr & 0x08) ? 1 : 0);      /* IL: id length byte */
		if (off + tl + pl > l || tl != 1 || r[off] != 'U' || pl < 1) return false;
		const uint8_t *pay = &r[off + tl];
		uint8_t code = pay[0];
		const char *pre = "";
		for (size_t i = 0; i < ARRAY_SIZE(uri_prefix); i++) {
			if (uri_prefix[i].code == code) pre = uri_prefix[i].s;
		}
		size_t pn = strlen(pre);
		size_t tn = pl - 1;
		if (pn + tn + 1 > cap) return false;
		memcpy(dst, pre, pn);
		memcpy(dst + pn, pay + 1, tn);
		dst[pn + tn] = '\0';
		return true;
	}
	return false;
}

/* ── Tag helpers ─────────────────────────────────────────────────────────── */

static void print_uid(const struct mfrc522_uid *uid)
{
	for (uint8_t i = 0; i < uid->size; i++) {
		printk("%s%02X", i ? ":" : "", uid->bytes[i]);
	}
}

/* User-memory size in bytes from GET_VERSION, else from the CC, else 48. */
static int tag_user_size(const uint8_t cc[4], const char **name)
{
	uint8_t ver[8];
	*name = "Type2";
	if (mfrc522_ntag_get_version(&rc522, ver) == MFRC_OK && ver[1] == 0x04) {
		switch (ver[6]) {
		case 0x0F: *name = "NTAG213"; return 144;
		case 0x11: *name = "NTAG215"; return 504;
		case 0x13: *name = "NTAG216"; return 888;
		default: break;
		}
	}
	if (cc[0] == 0xE1 && cc[2] != 0) {
		*name = "NDEF-CC";
		int sz = cc[2] * 8;
		return sz > NTAG_MAX_USER ? NTAG_MAX_USER : sz;
	}
	*name = "Ultralight?";
	return 48;
}

static int read_range(uint8_t page0, uint8_t *dst, size_t nbytes)
{
	uint8_t buf[16];
	size_t got = 0;
	uint8_t page = page0;
	while (got < nbytes) {
		int rc = mfrc522_ntag_read(&rc522, page, buf);
		if (rc != MFRC_OK) return rc;
		size_t take = nbytes - got < 16 ? nbytes - got : 16;
		memcpy(dst + got, buf, take);
		got += take;
		page += 4;
	}
	return MFRC_OK;
}

static int write_cc(int user_size)
{
	uint8_t cc[4] = { 0xE1, 0x10, (uint8_t)(user_size / 8), 0x00 };
	return mfrc522_ntag_write(&rc522, 3, cc);
}

/* ── Actions on a selected tag ──────────────────────────────────────────── */

static void do_read(const struct mfrc522_uid *uid)
{
	uint8_t hdr[16];
	if (mfrc522_ntag_read(&rc522, 0, hdr) != MFRC_OK) {
		printk("ERR read header failed\n");
		return;
	}
	const uint8_t *cc = &hdr[12];
	const char *name;
	int user = tag_user_size(cc, &name);
	printk("TAG uid="); print_uid(uid);
	printk(" sak=%02X type=%s user=%d cc=%02X%02X%02X%02X\n",
	       uid->sak, name, user, cc[0], cc[1], cc[2], cc[3]);

	static uint8_t mem[NTAG_MAX_USER];
	size_t n = user < (int)sizeof(mem) ? user : sizeof(mem);
	if (read_range(USER_PAGE0, mem, n) != MFRC_OK) {
		printk("ERR read user memory failed\n");
		return;
	}
	char found[URL_MAX + 1];
	if (parse_ndef_url(mem, n, found, sizeof(found))) {
		printk("URL %s\n", found);
	} else {
		printk("URL (none)\n");
	}
	printk("MEM");
	for (size_t i = 0; i < 32 && i < n; i++) printk(" %02X", mem[i]);
	printk("%s\n", n > 32 ? " ..." : "");
}

static void do_write(const struct mfrc522_uid *uid, bool format_only)
{
	if (uid->sak != 0x00) {
		printk("ERR uid="); print_uid(uid);
		printk(" sak=%02X is not a Type 2 tag (MIFARE Classic?)\n", uid->sak);
		writes_err++;
		return;
	}
	uint8_t hdr[16];
	if (mfrc522_ntag_read(&rc522, 0, hdr) != MFRC_OK) {
		printk("ERR read header failed\n");
		writes_err++;
		return;
	}
	const uint8_t *cc = &hdr[12];
	const char *name;
	int user = tag_user_size(cc, &name);

	if (format_only) {
		if (cc[0] == 0xE1) {
			printk("FORMATTED uid="); print_uid(uid);
			printk(" already (cc=%02X%02X%02X%02X)\n", cc[0], cc[1], cc[2], cc[3]);
			return;
		}
		if (write_cc(user) != MFRC_OK) {
			printk("ERR CC write failed\n");
			return;
		}
		printk("FORMATTED uid="); print_uid(uid);
		printk(" user=%d\n", user);
		return;
	}

	if (ndef_len == 0) {
		printk("ERR no url set\n");
		writes_err++;
		return;
	}
	if ((int)ndef_len > user) {
		printk("ERR ndef %u bytes > %s user %d\n", (unsigned)ndef_len, name, user);
		writes_err++;
		return;
	}
	/* CC is OTP (bits only go 0->1). Only touch it when it is blank. */
	if (cc[0] != 0xE1) {
		if (cc[0] == 0 && cc[1] == 0 && cc[2] == 0 && cc[3] == 0) {
			if (write_cc(user) != MFRC_OK) {
				printk("ERR CC write failed\n");
				writes_err++;
				return;
			}
		} else {
			printk("ERR cc=%02X%02X%02X%02X not NDEF and not blank; refusing\n",
			       cc[0], cc[1], cc[2], cc[3]);
			writes_err++;
			return;
		}
	}

	/* Write pages, zero-padded to a 4-byte boundary. */
	size_t pages = (ndef_len + 3) / 4;
	for (size_t i = 0; i < pages; i++) {
		uint8_t d[4] = { 0, 0, 0, 0 };
		size_t off = i * 4;
		size_t take = ndef_len - off < 4 ? ndef_len - off : 4;
		memcpy(d, &ndef[off], take);
		if (mfrc522_ntag_write(&rc522, USER_PAGE0 + i, d) != MFRC_OK) {
			printk("ERR write page %u failed\n", (unsigned)(USER_PAGE0 + i));
			writes_err++;
			return;
		}
	}

	/* Verify. */
	static uint8_t back[NDEF_MAX + 16];
	size_t vlen = pages * 4;
	if (read_range(USER_PAGE0, back, vlen) != MFRC_OK ||
	    memcmp(back, ndef, ndef_len) != 0) {
		printk("ERR verify mismatch\n");
		writes_err++;
		return;
	}
	writes_ok++;
	printk("WROTE uid="); print_uid(uid);
	printk(" type=%s bytes=%u pages=%u n=%u\n", name, (unsigned)ndef_len,
	       (unsigned)pages, writes_ok);
}

/* ── Console ─────────────────────────────────────────────────────────────── */

static void print_help(void)
{
	printk("commands:\n"
	       "  url <text>  set URL to write\n"
	       "  w           write next tag once\n"
	       "  wl          write every tag until x\n"
	       "  r / rl      read next tag / every tag\n"
	       "  f           format CC on next tag (blank tags only)\n"
	       "  x           disarm\n"
	       "  s           status\n");
}

static void print_status(void)
{
	printk("STATUS mode=%s rc522=%s url=%s ndef=%u ok=%u err=%u\n",
	       mode_name(mode), rc522_ok ? "ok" : "missing",
	       url[0] ? url : "(none)", (unsigned)ndef_len, writes_ok, writes_err);
}

static void handle_cmd(char *line)
{
	/* trim */
	while (*line && isspace((unsigned char)*line)) line++;
	char *end = line + strlen(line);
	while (end > line && isspace((unsigned char)end[-1])) *--end = '\0';
	if (!*line) return;

	if (strncmp(line, "url ", 4) == 0 || strncmp(line, "u ", 2) == 0) {
		const char *arg = line + (line[1] == ' ' ? 2 : 4);
		while (*arg == ' ') arg++;
		if (strlen(arg) > URL_MAX) {
			printk("ERR url longer than %d\n", URL_MAX);
			return;
		}
		int n = build_ndef(arg, ndef, sizeof(ndef));
		if (n < 0) {
			printk("ERR url does not fit an NDEF short record\n");
			return;
		}
		strcpy(url, arg);
		ndef_len = (size_t)n;
		printk("OK url=%s ndef=%u fits213=%c fits215=%c\n", url, (unsigned)ndef_len,
		       ndef_len <= 144 ? 'y' : 'n', ndef_len <= 504 ? 'y' : 'n');
	} else if (strcmp(line, "w") == 0) {
		if (!ndef_len) { printk("ERR no url set\n"); return; }
		mode = MODE_WRITE;  printk("OK armed write-once; present a tag\n");
	} else if (strcmp(line, "wl") == 0) {
		if (!ndef_len) { printk("ERR no url set\n"); return; }
		mode = MODE_WRITE_LOOP; printk("OK armed write-loop; present tags, x to stop\n");
	} else if (strcmp(line, "r") == 0) {
		mode = MODE_READ;   printk("OK armed read-once\n");
	} else if (strcmp(line, "rl") == 0) {
		mode = MODE_READ_LOOP; printk("OK armed read-loop\n");
	} else if (strcmp(line, "f") == 0) {
		mode = MODE_FORMAT; printk("OK armed format-once\n");
	} else if (strcmp(line, "x") == 0) {
		mode = MODE_IDLE;   printk("OK idle\n");
	} else if (strcmp(line, "s") == 0) {
		print_status();
	} else if (strcmp(line, "?") == 0 || strcmp(line, "help") == 0) {
		print_help();
	} else {
		printk("ERR unknown command: %s\n", line);
	}
}

#define CONSOLE_STACK 2048
K_THREAD_STACK_DEFINE(console_stack, CONSOLE_STACK);
static struct k_thread console_thread_data;

static void console_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);
	char line[URL_MAX + 8];
	int pos = 0;
	while (1) {
		uint8_t ch;
		if (uart_poll_in(usb_uart_dev, &ch) == 0) {
			if (ch == '\r' || ch == '\n') {
				line[pos] = '\0';
				if (pos > 0) {
					handle_cmd(line);
					pos = 0;
				}
			} else if ((ch == '\b' || ch == 0x7f) && pos > 0) {
				pos--;
			} else if (pos < (int)sizeof(line) - 1 && ch >= 0x20) {
				line[pos++] = ch;
			}
		} else {
			k_sleep(K_MSEC(5));
		}
	}
}

/* ── Main ────────────────────────────────────────────────────────────────── */

int main(void)
{
	rc522.spi = DEVICE_DT_GET(SPI_NODE);
	usb_uart_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_console));
	usb_enable(NULL);

	/* NFC rail on (P-FET, active low). */
	if (gpio_is_ready_dt(&nfc_en)) {
		gpio_pin_configure_dt(&nfc_en, GPIO_OUTPUT_ACTIVE);
		k_sleep(K_MSEC(20));
	}

	rc522_ok = false;
	if (mfrc522_init(&rc522) == 0) {
		uint8_t ver = mfrc522_read_version(&rc522);
		rc522_ok = (ver != 0x00 && ver != 0xFF);
	}

	k_thread_create(&console_thread_data, console_stack,
			K_THREAD_STACK_SIZEOF(console_stack),
			console_thread, NULL, NULL, NULL,
			K_PRIO_PREEMPT(5), 0, K_NO_WAIT);

	/* Give the host a moment to open the port, then announce. */
	k_sleep(K_SECONDS(2));
	printk("\nREADY ntag-writer v" FW_VERSION " rc522=%s (0x%02X)\n",
	       rc522_ok ? "ok" : "MISSING", mfrc522_read_version(&rc522));
	print_help();

	while (1) {
		if (mode == MODE_IDLE || !rc522_ok) {
			k_sleep(K_MSEC(POLL_MS));
			continue;
		}
		if (!mfrc522_is_card_present(&rc522)) {
			k_sleep(K_MSEC(POLL_MS));
			continue;
		}
		struct mfrc522_uid uid;
		if (mfrc522_read_card_serial(&rc522, &uid) != MFRC_OK) {
			k_sleep(K_MSEC(POLL_MS));
			continue;
		}

		enum mode m = mode;
		switch (m) {
		case MODE_WRITE:
		case MODE_WRITE_LOOP:
			do_write(&uid, false);
			break;
		case MODE_FORMAT:
			do_write(&uid, true);
			break;
		case MODE_READ:
		case MODE_READ_LOOP:
			do_read(&uid);
			break;
		default:
			break;
		}
		/* HLTA: a halted tag ignores REQA, so it is not re-processed until
		 * it leaves the field and comes back. */
		mfrc522_halt(&rc522);

		if (m == MODE_WRITE || m == MODE_READ || m == MODE_FORMAT) {
			mode = MODE_IDLE;
			printk("OK idle\n");
		}
		k_sleep(K_MSEC(300));
	}
	return 0;
}
