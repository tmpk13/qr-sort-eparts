import { describe, expect, test } from "bun:test";
import { DOTS_PER_MM, MARGIN, layout, qrModules } from "../src/label.ts";

describe("label layout", () => {
    const spec = { payload: "qrsort:bag:7", title: "BAG 7", subtitle: "", wMm: 40, hMm: 30 };

    test("a bag label's QR code is a version 1 symbol", () => {
        expect(qrModules("qrsort:bag:7").size).toBe(21);
        expect(qrModules("qrsort:box:1234").size).toBe(21);
    });

    test("wide label: QR on the left at whole dots per module, text beside it", () => {
        const l = layout(spec, 21);
        expect([l.w, l.h]).toEqual([40 * DOTS_PER_MM, 30 * DOTS_PER_MM]);
        expect(l.qr.scale).toBe(Math.floor((240 - 2 * MARGIN) / 25));
        expect(l.qr.side).toBe(25 * l.qr.scale);
        expect(l.qr.x).toBe(MARGIN);
        expect(l.text.x).toBe(MARGIN + l.qr.side);
        expect(l.text.x + l.text.w + MARGIN).toBe(l.w);
        expect(l.qr.y + l.qr.side).toBeLessThanOrEqual(l.h);
    });

    test("tall label: QR centered on top, text below", () => {
        const l = layout({ ...spec, wMm: 30, hMm: 40 }, 21);
        expect(l.qr.y).toBe(MARGIN);
        expect(l.qr.x).toBe(Math.floor((l.w - l.qr.side) / 2));
        expect(l.text.y).toBe(MARGIN + l.qr.side);
        expect(l.text.w).toBe(l.w);
    });

    test("a label too small for 2 dots per module is refused", () => {
        expect(() => layout({ ...spec, wMm: 6, hMm: 6 }, 21)).toThrow(/too large/);
    });
});
