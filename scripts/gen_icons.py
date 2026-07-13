"""Generate favicon icons for the Zotero hover-translate-wordbook plugin.

Pure stdlib (struct + zlib) PNG writer. Produces:
  - favicon.png        (96x96)
  - favicon@0.5x.png   (48x48)

Design: rounded-square gradient (blue -> teal) with a white right-arrow,
symbolizing "translate / hover".
"""
import struct
import zlib
import os
import math

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "addon", "content", "icons")


def write_png(path, width, height, pixels):
    """pixels: list of rows, each row list of (r,g,b,a) tuples."""
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for (r, g, b, a) in row:
            raw.extend((r, g, b, a))
    compressed = zlib.compress(bytes(raw), 9)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def lerp(c1, c2, t):
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * t)) for i in range(3))


def in_rounded_rect(x, y, w, h, r):
    if x < r and y < r:
        return (r - x - 1) ** 2 + (r - y - 1) ** 2 <= r * r if False else (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x >= w - r and y < r:
        return (x - (w - r - 1)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y >= h - r:
        return (x - r) ** 2 + (y - (h - r - 1)) ** 2 <= r * r
    if x >= w - r and y >= h - r:
        return (x - (w - r - 1)) ** 2 + (y - (h - r - 1)) ** 2 <= r * r
    return True


def render(size):
    w = h = size
    r = max(4, size // 5)  # corner radius
    top = (37, 99, 235)     # #2563EB blue
    bot = (20, 184, 166)    # #14B8A6 teal
    white = (255, 255, 255)

    pixels = []
    for y in range(h):
        row = []
        for x in range(w):
            r_, g_, b_, a_ = 0, 0, 0, 0
            if in_rounded_rect(x, y, w, h, r):
                t = y / max(1, h - 1)
                col = lerp(top, bot, t)
                r_, g_, b_ = col
                a_ = 255
            # draw white arrow
            # horizontal bar
            bar_y0 = int(h * 0.46)
            bar_y1 = int(h * 0.54)
            bar_x0 = int(w * 0.24)
            bar_x1 = int(w * 0.62)
            if bar_x0 <= x <= bar_x1 and bar_y0 <= y <= bar_y1 and in_rounded_rect(x, y, w, h, r):
                r_, g_, b_ = white
                a_ = 255
            # arrowhead triangle (pointing right) centered around x in [0.60,0.78]w, y center 0.5h
            ah_x0 = int(w * 0.58)
            ah_x1 = int(w * 0.80)
            ah_cy = h // 2
            ah_half = int(h * 0.16)
            if ah_x0 <= x <= ah_x1:
                # triangle: at x=ah_x0 half=ah_half, at x=ah_x1 half=0 (linear)
                frac = (x - ah_x0) / max(1, ah_x1 - ah_x0)
                half = int(ah_half * (1 - frac))
                if abs(y - ah_cy) <= half and in_rounded_rect(x, y, w, h, r):
                    r_, g_, b_ = white
                    a_ = 255
            row.append((r_, g_, b_, a_))
        pixels.append(row)
    return pixels


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    p96 = render(96)
    write_png(os.path.join(OUT_DIR, "favicon.png"), 96, 96, p96)
    p48 = render(48)
    write_png(os.path.join(OUT_DIR, "favicon@0.5x.png"), 48, 48, p48)
    print("Icons generated:")
    for f in ("favicon.png", "favicon@0.5x.png"):
        path = os.path.join(OUT_DIR, f)
        print(f"  {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
