// Reading a count written on a bag with a colored marker. The marker's color is picked from a
// picture; pixels of that color are kept (a hue range, a saturation floor, a brightness band), ink
// areas too small to be writing are dropped, and what is left is read as digits by the text reader.
import { readDigits } from "./ocr.ts";

/** How the marker's color is matched: hue in degrees, the rest in percent. */
export interface MarkerTune {
    color: string; // the picked color, "#rrggbb"
    hue: number; // its hue, 0 to 360
    hueRange: number; // degrees either side of the hue that still count, 0 to 180 (180: any hue)
    satMin: number; // saturation at least this
    valMin: number; // brightness from this
    valMax: number; // to this
    speck: number; // ink areas smaller than this many pixels (at the working size) are dropped
}

/** Pictures are scaled so their longer side is at most this before matching, so tuning holds across cameras. */
export const WORK_SIZE = 1000;

/** Fewer ink pixels than this (at the working size) is no writing at all. */
const MIN_INK = 40;

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let h = 0;
    if (d) {
        h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h = h * 60 + (h < 0 ? 360 : 0);
    }
    return [h, max ? (d / max) * 100 : 0, (max / 255) * 100];
}

function hex(rgb: [number, number, number]): string {
    return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** The average color in a small square around (x, y), so one noisy pixel does not decide it. */
export function sampleColor(rgba: Uint8ClampedArray, w: number, h: number, x: number, y: number, radius = 2)
    : [number, number, number] {
    const sum = [0, 0, 0];
    let n = 0;
    for (let yy = Math.max(0, y - radius); yy <= Math.min(h - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(w - 1, x + radius); xx++) {
            const i = (yy * w + xx) * 4;
            sum[0] += rgba[i];
            sum[1] += rgba[i + 1];
            sum[2] += rgba[i + 2];
            n++;
        }
    }
    return [sum[0] / n, sum[1] / n, sum[2] / n];
}

/**
 * A starting point for a picked color: its hue give or take 20 degrees, at least half its
 * saturation, and not much darker than it. Black or gray ink has no hue, so any hue counts and only
 * dark pixels are kept; printed text matches that too, which is why a colored marker reads better.
 */
export function tuneFor(rgb: [number, number, number]): MarkerTune {
    const [h, s, v] = rgbToHsv(...rgb);
    const gray = s < 20;
    return {
        color: hex(rgb),
        hue: Math.round(h),
        hueRange: gray ? 180 : 20,
        satMin: gray ? 0 : Math.round(Math.max(20, s * 0.5)),
        valMin: gray ? 0 : Math.round(Math.max(10, v * 0.4)),
        valMax: gray ? Math.round(Math.min(100, v + 25)) : 100,
        speck: 30,
    };
}

/** 1 for each pixel of the marker's color, 0 elsewhere. */
export function isolate(rgba: Uint8ClampedArray, w: number, h: number, t: MarkerTune): Uint8Array {
    const mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
        const r = rgba[p];
        const g = rgba[p + 1];
        const b = rgba[p + 2];
        const max = Math.max(r, g, b);
        const d = max - Math.min(r, g, b);
        const sat = max ? (d / max) * 100 : 0;
        const val = (max / 255) * 100;
        if (sat < t.satMin || val < t.valMin || val > t.valMax) {
            continue;
        }
        if (t.hueRange < 180) {
            let hue = 0;
            if (d) {
                hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
                hue = hue * 60 + (hue < 0 ? 360 : 0);
            }
            const off = Math.abs(hue - t.hue);
            if (Math.min(off, 360 - off) > t.hueRange) {
                continue;
            }
        }
        mask[i] = 1;
    }
    return mask;
}

/** The mask without ink areas (touching pixels, diagonals included) smaller than minArea. */
export function removeSpecks(mask: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
    if (minArea <= 1) {
        return mask;
    }
    const out = mask.slice();
    const seen = new Uint8Array(mask.length);
    const stack = new Int32Array(mask.length);
    const area = new Int32Array(mask.length);
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || seen[start]) {
            continue;
        }
        let top = 0;
        let n = 0;
        stack[top++] = start;
        seen[start] = 1;
        while (top) {
            const i = stack[--top];
            area[n++] = i;
            const x = i % w;
            const y = (i - x) / w;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx >= 0 && ny >= 0 && nx < w && ny < h) {
                        const j = ny * w + nx;
                        if (mask[j] && !seen[j]) {
                            seen[j] = 1;
                            stack[top++] = j;
                        }
                    }
                }
            }
        }
        if (n < minArea) {
            for (let k = 0; k < n; k++) {
                out[area[k]] = 0;
            }
        }
    }
    return out;
}

export interface InkBox {
    x: number;
    y: number;
    w: number;
    h: number;
    ink: number; // pixels of ink inside
}

/** The smallest rectangle around all the ink, or null when there is none. */
export function inkBox(mask: Uint8Array, w: number, h: number): InkBox | null {
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let ink = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (mask[y * w + x]) {
                ink++;
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
            }
        }
    }
    return ink ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, ink } : null;
}

/** The ink in its own colors with everything else white: the preview of the isolated color. */
export function isolatedRgba(rgba: Uint8ClampedArray, mask: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
    const out = new Uint8ClampedArray(rgba.length).fill(255);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
        if (mask[i]) {
            out[p] = rgba[p];
            out[p + 1] = rgba[p + 1];
            out[p + 2] = rgba[p + 2];
        }
    }
    return out;
}

// ---- in the browser ----

/** The picture's pixels, scaled so its longer side is at most WORK_SIZE. */
export async function loadPixels(image: Blob): Promise<ImageData> {
    const bmp = await createImageBitmap(image);
    const scale = Math.min(1, WORK_SIZE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return ctx.getImageData(0, 0, c.width, c.height);
}

/** The ink and where it is, once the color is isolated and the specks are dropped. */
export function markerInk(img: ImageData, t: MarkerTune): { mask: Uint8Array; box: InkBox | null } {
    const mask = removeSpecks(isolate(img.data, img.width, img.height, t), img.width, img.height, t.speck);
    const box = inkBox(mask, img.width, img.height);
    return { mask, box: box && box.ink >= MIN_INK ? box : null };
}

export interface MarkerRead {
    count: number;
    confidence: number; // the text reader's, 0 to 100
}

/**
 * The number written in the marker's color: the ink is cut out as black on white, scaled to the
 * size the reader handles best, and read as digits; the biggest number found wins, the count being
 * written large.
 * Null when there is no ink of that color or no number in it.
 */
export async function readMarkerCount(image: Blob | ImageData, t: MarkerTune): Promise<MarkerRead | null> {
    const img = image instanceof Blob ? await loadPixels(image) : image;
    const { mask, box } = markerInk(img, t);
    if (!box) {
        return null;
    }
    const crop = document.createElement("canvas");
    crop.width = box.w;
    crop.height = box.h;
    const ctx = crop.getContext("2d")!;
    const px = ctx.createImageData(box.w, box.h);
    for (let y = 0; y < box.h; y++) {
        for (let x = 0; x < box.w; x++) {
            const v = mask[(box.y + y) * img.width + box.x + x] ? 0 : 255;
            const p = (y * box.w + x) * 4;
            px.data[p] = px.data[p + 1] = px.data[p + 2] = v;
            px.data[p + 3] = 255;
        }
    }
    ctx.putImageData(px, 0, 0);
    // Tesseract reads digits best about 40 pixels tall, with a white margin: much larger ones it
    // misreads with fair confidence (a written 52 came back as 92 at 72%), smaller ones it drops.
    const scale = Math.min(4, 40 / box.h);
    const pad = Math.round(Math.max(16, (box.h * scale) / 2));
    const page = document.createElement("canvas");
    page.width = Math.round(box.w * scale) + 2 * pad;
    page.height = Math.round(box.h * scale) + 2 * pad;
    const pctx = page.getContext("2d")!;
    pctx.fillStyle = "#fff";
    pctx.fillRect(0, 0, page.width, page.height);
    pctx.drawImage(crop, pad, pad, page.width - 2 * pad, page.height - 2 * pad);
    const words = (await readDigits(page)).filter((w) => /^\d+$/.test(w.text));
    if (!words.length) {
        return null;
    }
    const best = words.reduce((a, b) => (b.area > a.area ? b : a));
    return { count: Number(best.text), confidence: best.confidence };
}
