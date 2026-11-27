// Made-up screenshots for the demo, drawn as boxes into PNGs: what its agents would have taken with a browser, so
// the feed's covers, the Pictures view and the compares have something to show. No dependencies.

import zlib from "node:zlib";

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function canvas(w, h, bg) {
  const px = Buffer.alloc(w * h * 3);
  const box = (x, y, bw, bh, color, r = 0) => {
    const [cr, cg, cb] = rgb(color);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(w, Math.round(x + bw));
    const y1 = Math.min(h, Math.round(y + bh));
    for (let j = y0; j < y1; j++)
      for (let i = x0; i < x1; i++) {
        if (r) {
          const dx = i < x0 + r ? x0 + r - i : i >= x1 - r ? i - (x1 - r - 1) : 0;
          const dy = j < y0 + r ? y0 + r - j : j >= y1 - r ? j - (y1 - r - 1) : 0;
          if (dx * dx + dy * dy > r * r) continue;
        }
        const o = (j * w + i) * 3;
        px[o] = cr;
        px[o + 1] = cg;
        px[o + 2] = cb;
      }
  };
  box(0, 0, w, h, bg);
  // Lines of text, as gray bars of different lengths.
  const text = (x, y, width, lines, color = "#d7dbe2", gap = 14, size = 6) => {
    for (let k = 0; k < lines; k++) box(x, y + k * gap, width * (k === lines - 1 && lines > 1 ? 0.6 : 0.82 + ((k * 37) % 17) / 100), size, color, 3);
  };
  const png = () => {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let j = 0; j < h; j++) px.copy(raw, j * (w * 3 + 1) + 1, j * w * 3, (j + 1) * w * 3);
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  return { box, text, png };
}

// A card on dashy's board: a title, and a body of its kind.
function card(c, x, y, w, h, kind, accent) {
  c.box(x, y, w, h, "#e4e7ec", 10);
  c.box(x + 1, y + 1, w - 2, h - 2, "#ffffff", 9);
  c.box(x + 16, y + 16, w * 0.35, 8, "#3b4250", 4);
  if (kind === "metric") {
    c.box(x + 16, y + 40, w * 0.4, 22, "#1f2430", 5);
    c.box(x + 16 + w * 0.42, y + 50, 40, 10, "#2f9e6b", 5);
    for (let i = 0; i < 12; i++) c.box(x + 16 + i * ((w - 32) / 12), y + h - 18 - (10 + ((i * 29) % 23)), (w - 32) / 12 - 3, 10 + ((i * 29) % 23), "#cfe3f7", 2);
  } else if (kind === "bars") {
    for (let i = 0; i < 4; i++) {
      c.box(x + 16, y + 42 + i * 22, w * 0.25, 7, "#c9ced8", 3);
      c.box(x + 22 + w * 0.28, y + 40 + i * 22, (w * 0.6 - 30) * [0.9, 0.62, 0.44, 0.2][i], 11, accent, 4);
    }
  } else if (kind === "embed-broken") {
    c.box(x + 16, y + 38, w - 32, h - 54, "#f3f4f6", 6);
    c.box(x + w / 2 - 18, y + 38 + (h - 54) / 2 - 18, 36, 36, "#e5b5b5", 8);
    c.box(x + w / 2 - 6, y + 38 + (h - 54) / 2 - 6, 12, 12, "#f3f4f6", 3);
  } else if (kind === "embed") {
    c.box(x + 16, y + 38, w - 32, h - 54, "#f6f8fb", 6);
    c.box(x + 16, y + 38, w - 32, 18, "#e9edf3", 6);
    for (let i = 0; i < 3; i++) c.box(x + 24 + i * 12, y + 44, 6, 6, ["#e57373", "#f2c94c", "#6fcf97"][i], 3);
    const bw = (w - 64) / 8;
    for (let i = 0; i < 8; i++) {
      const bh = (h - 120) * (0.3 + (((i * 41) % 53) / 53) * 0.7);
      c.box(x + 32 + i * bw, y + h - 30 - bh, bw - 6, bh, i === 5 ? accent : "#b7c9e6", 3);
    }
  } else c.text(x + 16, y + 40, w - 32, Math.max(2, Math.floor((h - 52) / 16)));
}

// dashy's board at a desktop width: a top bar, a sidebar and a grid of cards. `embed`: "none" (before the embed
// widget), "broken" (a page that won't be framed) or "ok"; `layout` places the embed card ("wide", "grid", "tab").
export function board({ w = 1200, h = 750, embed = "ok", layout = "wide", accent = "#4f7cf7" } = {}) {
  const c = canvas(w, h, "#f5f6f8");
  c.box(0, 0, w, 52, "#ffffff");
  c.box(0, 52, w, 1, "#e4e7ec");
  c.box(20, 16, 22, 22, accent, 6);
  c.box(52, 22, 90, 10, "#3b4250", 5);
  c.box(w - 260, 14, 200, 24, "#f0f2f5", 12);
  c.box(w - 44, 14, 24, 24, "#d9dde4", 12);
  c.box(0, 53, 220, h - 53, "#ffffff");
  c.box(220, 53, 1, h - 53, "#e4e7ec");
  for (let i = 0; i < 6; i++) {
    if (i === 1) c.box(12, 78 + i * 36, 196, 28, "#eef2fe", 7);
    c.box(26, 87 + i * 36, 12, 10, i === 1 ? accent : "#c4c9d2", 3);
    c.box(48, 88 + i * 36, 70 + ((i * 23) % 50), 8, i === 1 ? "#2c3a66" : "#7b8494", 4);
  }
  const X = 248;
  const W = w - X - 28;
  c.box(X, 76, 220, 14, "#1f2430", 6);
  c.text(X, 100, 380, 1, "#aab1bd");
  const top = 130;
  const gap = 16;
  const col = (W - gap * 2) / 3;
  if (layout === "tab") {
    for (let i = 0; i < 3; i++) c.box(X + i * 92, top, 84, 26, i === 2 ? "#e8eefe" : "#ffffff", 13);
    c.box(X + 2 * 92 + 18, top + 9, 48, 8, accent, 4);
    card(c, X, top + 40, W, h - top - 70, embed === "broken" ? "embed-broken" : "embed", accent);
    return c.png();
  }
  const kinds = ["metric", "bars", "text", "text", "metric", "bars"];
  if (embed === "none" || layout === "grid") {
    for (let i = 0; i < 6; i++) {
      const k = embed !== "none" && i === 4 ? (embed === "broken" ? "embed-broken" : "embed") : kinds[i];
      card(c, X + (i % 3) * (col + gap), top + Math.floor(i / 3) * 196, col, 180, k, accent);
    }
    return c.png();
  }
  for (let i = 0; i < 3; i++) card(c, X + i * (col + gap), top, col, 170, kinds[i], accent);
  card(c, X, top + 186, W, h - top - 186 - 28, embed === "broken" ? "embed-broken" : "embed", accent);
  return c.png();
}

// The same board on a phone: one column of cards.
export function phone({ w = 390, h = 780, embed = "ok", accent = "#4f7cf7" } = {}) {
  const c = canvas(w, h, "#f5f6f8");
  c.box(0, 0, w, 56, "#ffffff");
  c.box(0, 56, w, 1, "#e4e7ec");
  c.box(16, 17, 22, 22, accent, 6);
  c.box(48, 23, 80, 10, "#3b4250", 5);
  c.box(w - 40, 16, 24, 24, "#d9dde4", 12);
  c.box(16, 76, 170, 13, "#1f2430", 6);
  card(c, 16, 104, w - 32, 140, "metric", accent);
  card(c, 16, 258, w - 32, 260, embed === "broken" ? "embed-broken" : "embed", accent);
  card(c, 16, 532, w - 32, 150, "bars", accent);
  card(c, 16, 696, w - 32, 120, "text", accent);
  return c.png();
}

// A link's picture (its og:image): a wide banner.
export function banner({ w = 1200, h = 630, accent = "#4f7cf7" } = {}) {
  const c = canvas(w, h, "#eef2fe");
  c.box(0, 0, w, h * 0.62, accent);
  c.box(80, 90, 520, 40, "#ffffff", 12);
  c.box(80, 150, 360, 22, "#dbe5ff", 10);
  c.box(w - 470, 70, 380, 280, "#ffffff", 18);
  c.box(w - 446, 94, 332, 26, "#e9edf3", 8);
  for (let i = 0; i < 3; i++) c.box(w - 434 + i * 14, 102, 8, 8, ["#e57373", "#f2c94c", "#6fcf97"][i], 4);
  c.box(w - 446, 136, 332, 190, "#f6f8fb", 8);
  c.box(w - 420, 160, 280, 140, "#dfe7f8", 8);
  c.text(80, h * 0.62 + 50, 700, 3, "#b4bfd6", 30, 12);
  return c.png();
}
