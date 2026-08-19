/**
 * 生成 Pi 控制台应用图标（512x512 PNG，纯 Node 实现，无图片库）。
 * 设计：深蓝圆角方块 + 白色对话气泡 + 气泡内深蓝点阵 "Pi"。
 * 用法：node scripts/generate-icon.js [输出路径]
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SIZE = 512;
const OUT = process.argv[2] ?? join(import.meta.dirname, "..", "icon.png");

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf) {
	let crc = 0xffffffff;
	for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const typeBuf = Buffer.from(type, "ascii");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const raw = Buffer.alloc(height * (1 + width * 4));
	for (let y = 0; y < height; y++) {
		raw[y * (1 + width * 4)] = 0; // filter: none
		rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
	}
	const idat = deflateSync(raw, { level: 9 });
	return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

const pixels = Buffer.alloc(SIZE * SIZE * 4); // RGBA，默认透明

function setPixel(x, y, r, g, b, a = 255) {
	if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
	const i = (y * SIZE + x) * 4;
	pixels[i] = r;
	pixels[i + 1] = g;
	pixels[i + 2] = b;
	pixels[i + 3] = a;
}

/** 圆角矩形有符号距离场（负值在内部） */
function roundedRectSDF(px, py, cx, cy, hw, hh, radius) {
	const dx = Math.abs(px - cx) - (hw - radius);
	const dy = Math.abs(py - cy) - (hh - radius);
	const ox = Math.max(dx, 0);
	const oy = Math.max(dy, 0);
	return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** 5x7 点阵字模（'Pi'） */
const FONT = {
	P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
	i: ["00100", "00000", "00100", "00100", "00100", "00100", "00100"],
};

// 背景：深蓝圆角方块
const BG = [37, 99, 235]; // #2563EB
for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		if (roundedRectSDF(x + 0.5, y + 0.5, SIZE / 2, SIZE / 2, SIZE / 2 - 8, SIZE / 2 - 8, 96) <= 0) {
			setPixel(x, y, BG[0], BG[1], BG[2]);
		}
	}
}

// 白色对话气泡（圆角矩形 + 底部小尾巴）
const BUBBLE = {
	cx: SIZE / 2,
	cy: SIZE / 2 - 8,
	hw: 170,
	hh: 120,
	radius: 44,
	tailX: SIZE / 2 - 46,
	tailY: SIZE / 2 + 104,
};
for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		let inBubble = roundedRectSDF(x + 0.5, y + 0.5, BUBBLE.cx, BUBBLE.cy, BUBBLE.hw, BUBBLE.hh, BUBBLE.radius) <= 0;
		// 尾巴：小三角形
		const tdx = x - BUBBLE.tailX;
		const tdy = y - BUBBLE.tailY;
		if (tdy >= 0 && tdy <= 40 && Math.abs(tdx) <= tdy * 0.9) inBubble = true;
		if (inBubble) setPixel(x, y, 255, 255, 255);
	}
}

// 气泡内点阵 "Pi"（深蓝）
const TEXT_COLOR = [37, 99, 235];
const SCALE = 26;
const textWidth = (FONT.P[0].length + 1 + FONT.i[0].length) * SCALE;
const textX0 = Math.round((SIZE - textWidth) / 2);
const textY0 = Math.round((SIZE - 7 * SCALE) / 2) - 8;
function drawGlyph(glyph, offsetX) {
	for (let row = 0; row < 7; row++) {
		for (let col = 0; col < glyph[0].length; col++) {
			if (glyph[row][col] !== "1") continue;
			for (let dy = 0; dy < SCALE; dy++) {
				for (let dx = 0; dx < SCALE; dx++) {
					const x = textX0 + offsetX + col * SCALE + dx;
					const y = textY0 + row * SCALE + dy;
					// 圆角像素（边缘圆润）
					const inset = 3;
					if (dx >= inset && dy >= inset && dx < SCALE - inset && dy < SCALE - inset) {
						setPixel(x, y, TEXT_COLOR[0], TEXT_COLOR[1], TEXT_COLOR[2]);
					}
				}
			}
		}
	}
}
drawGlyph(FONT.P, 0);
drawGlyph(FONT.i, (FONT.P[0].length + 1) * SCALE);

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

writeFileSync(OUT, encodePNG(SIZE, SIZE, pixels));
console.log(`icon written: ${OUT} (${SIZE}x${SIZE})`);
