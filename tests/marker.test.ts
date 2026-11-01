import { describe, expect, test } from "bun:test";
import { inkBox, isolate, isolatedRgba, removeSpecks, rgbToHsv, sampleColor, tuneFor } from "../src/marker.ts";

type Rgb = [number, number, number];

/** A w x h picture filled with one color, with rectangles of others painted on it. */
function picture(w: number, h: number, ground: Rgb, rects: [number, number, number, number, Rgb][]): Uint8ClampedArray {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        px.set([...ground, 255], i * 4);
    }
    for (const [x0, y0, rw, rh, c] of rects) {
        for (let y = y0; y < y0 + rh; y++) {
            for (let x = x0; x < x0 + rw; x++) {
                px.set([...c, 255], (y * w + x) * 4);
            }
        }
    }
    return px;
}

const PINK: Rgb = [250, 190, 205]; // an anti-static bag
const RED: Rgb = [200, 25, 30]; // marker ink
const BLACK: Rgb = [20, 20, 20]; // the printed label
const WHITE: Rgb = [255, 255, 255];

describe("marker color", () => {
    test("hue, saturation and brightness", () => {
        expect(rgbToHsv(255, 0, 0)).toEqual([0, 100, 100]);
        expect(rgbToHsv(0, 255, 0)[0]).toBe(120);
        expect(rgbToHsv(0, 0, 255)[0]).toBe(240);
        expect(rgbToHsv(255, 0, 64)[0]).toBeCloseTo(345, 0);
        const [h, s, v] = rgbToHsv(128, 128, 128);
        expect([h, s]).toEqual([0, 0]);
        expect(v).toBeCloseTo(50.2, 1);
    });

    test("a picked color sets a hue band around it; gray ink keeps dark pixels of any hue", () => {
        const red = tuneFor(RED);
        expect(red).toMatchObject({ hueRange: 20, color: "#c8191e" });
        expect(red.hue === 0 || red.hue >= 355).toBe(true);
        expect(red.satMin).toBeGreaterThan(30);
        const gray = tuneFor([40, 40, 45]);
        expect(gray).toMatchObject({ hueRange: 180, satMin: 0, valMin: 0 });
        expect(gray.valMax).toBeLessThan(50);
    });

    test("the color is sampled around the click, not from one pixel", () => {
        const px = picture(5, 5, WHITE, [[2, 2, 1, 1, [0, 0, 0]]]);
        const [r] = sampleColor(px, 5, 5, 2, 2, 1);
        expect(r).toBeCloseTo((255 * 8) / 9, 5);
    });

    test("only the marker's color is kept: not the pink bag, the black print or the white label", () => {
        const w = 40;
        const h = 20;
        const px = picture(w, h, PINK, [[0, 0, 10, 20, WHITE], [12, 2, 6, 6, BLACK], [20, 5, 8, 8, RED]]);
        const mask = isolate(px, w, h, tuneFor(RED));
        expect(mask.reduce((n, v) => n + v, 0)).toBe(64);
        expect(inkBox(mask, w, h)).toEqual({ x: 20, y: 5, w: 8, h: 8, ink: 64 });
        const preview = isolatedRgba(px, mask);
        expect([...preview.slice(0, 3)]).toEqual([255, 255, 255]);
        const inside = ((5 * w) + 20) * 4;
        expect([...preview.slice(inside, inside + 3)]).toEqual(RED);
    });

    test("hues near red match across 0 degrees", () => {
        const px = picture(4, 1, WHITE, [[0, 0, 1, 1, [220, 20, 50]], [1, 0, 1, 1, [220, 50, 20]], [2, 0, 1, 1, [20, 220, 20]]]);
        const t = { ...tuneFor([220, 20, 20]), hueRange: 15 };
        expect([...isolate(px, 4, 1, t)]).toEqual([1, 1, 0, 0]);
    });

    test("specks smaller than the limit go, writing stays, diagonal strokes count as one", () => {
        const w = 30;
        const h = 10;
        const mask = new Uint8Array(w * h);
        mask[0] = 1; // a lone speck
        for (let i = 0; i < 8; i++) {
            mask[i * w + 10 + i] = 1; // a diagonal stroke of 8 pixels
        }
        for (let y = 2; y < 6; y++) {
            for (let x = 20; x < 26; x++) {
                mask[y * w + x] = 1; // a 24-pixel blob
            }
        }
        const kept = removeSpecks(mask, w, h, 5);
        expect(kept[0]).toBe(0);
        expect(kept.reduce((n, v) => n + v, 0)).toBe(8 + 24);
        expect(removeSpecks(mask, w, h, 10).reduce((n, v) => n + v, 0)).toBe(24);
        expect(removeSpecks(mask, w, h, 0)).toBe(mask);
        expect(inkBox(new Uint8Array(4), 2, 2)).toBeNull();
    });
});
