import { describe, expect, test } from "bun:test";
import { AutoCapture, boundsOf, fromRegion, pickCode, type Detection } from "../src/scanner.ts";

function det(text: string, format = "DataMatrix"): Detection {
    return { text, format, corners: [] };
}

describe("auto capture", () => {
    test("fires once per bag after settling", () => {
        const a = new AutoCapture(2, 1500);
        expect(a.feed(null, 0)).toBeNull();
        expect(a.feed("A", 100)).toBeNull();
        expect(a.feed("A", 200)).toBe("A");
        expect(a.feed("A", 300)).toBeNull();
        expect(a.feed("A", 5000)).toBeNull();
        expect(a.holding).toBe("A");
    });

    test("a short loss of the code does not re-arm", () => {
        const a = new AutoCapture(2, 1500);
        a.feed("A", 0);
        a.feed("A", 100);
        expect(a.feed(null, 200)).toBeNull();
        expect(a.feed(null, 1000)).toBeNull();
        expect(a.feed("A", 1100)).toBeNull();
        expect(a.feed("A", 1200)).toBeNull();
    });

    test("the same bag captures again after it has been away", () => {
        const a = new AutoCapture(2, 1500);
        a.feed("A", 0);
        a.feed("A", 100);
        a.feed(null, 200);
        expect(a.feed(null, 2000)).toBeNull();
        expect(a.holding).toBeNull();
        expect(a.feed("A", 2100)).toBeNull();
        expect(a.feed("A", 2200)).toBe("A");
    });

    test("a different bag captures while the old one is still in view", () => {
        const a = new AutoCapture(2, 1500);
        a.feed("A", 0);
        a.feed("A", 100);
        expect(a.feed("B", 200)).toBeNull();
        expect(a.feed("B", 300)).toBe("B");
        expect(a.feed("A", 400)).toBeNull();
        expect(a.feed("A", 500)).toBe("A");
    });

    test("flicker between frames restarts the settle count", () => {
        const a = new AutoCapture(3, 1500);
        expect(a.feed("A", 0)).toBeNull();
        expect(a.feed(null, 100)).toBeNull();
        expect(a.feed("A", 200)).toBeNull();
        expect(a.feed("A", 300)).toBeNull();
        expect(a.feed("A", 400)).toBe("A");
    });

    test("reset forgets the held code", () => {
        const a = new AutoCapture(1, 1500);
        expect(a.feed("A", 0)).toBe("A");
        a.reset();
        expect(a.feed("A", 10)).toBe("A");
    });
});

describe("code choice", () => {
    test("prefers a parts code over a label and Data Matrix over QR", () => {
        expect(pickCode([])).toBeNull();
        expect(pickCode([det("qrsort:bag:1", "QRCode"), det("part", "QRCode")])?.text).toBe("part");
        expect(pickCode([det("q", "QRCode"), det("d", "DataMatrix")])?.text).toBe("d");
        expect(pickCode([det("qrsort:bag:1", "QRCode")])?.text).toBe("qrsort:bag:1");
    });
});

describe("1D barcodes", () => {
    test("a row of them makes one candidate, keyed by the part", () => {
        const c = pickCode([det("Q10", "Code128"), det("1PSN74LVC1G08DBVR", "Code128"), det("4LCN", "Code39")]);
        expect(c?.key).toBe("linear:SN74LVC1G08DBVR");
        expect(c?.dets).toHaveLength(3);
        // One more barcode read in the next frame is still the same bag.
        expect(pickCode([det("1PSN74LVC1G08DBVR", "Code128")])?.key).toBe(c!.key);
    });

    test("ones that name no part give nothing; any 2D code wins over them", () => {
        expect(pickCode([det("Q10", "Code128")])).toBeNull();
        expect(pickCode([det("1PX1", "Code128"), det("d", "DataMatrix")])?.text).toBe("d");
    });
});

describe("looking closer", () => {
    test("the bounds of a code, widened and clamped to the frame", () => {
        const r = boundsOf([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }], 400, 400, 0.5);
        expect(r).toEqual({ x0: 0.125, y0: 0.125, x1: 0.625, y1: 0.625 });
        expect(boundsOf([{ x: 0, y: 0 }, { x: 40, y: 40 }], 100, 100, 0.5)).toEqual({ x0: 0, y0: 0, x1: 0.6, y1: 0.6 });
        expect(boundsOf([], 100, 100)).toBeNull();
    });

    test("a point in the enlarged region maps back onto the frame", () => {
        const r = { x0: 0.25, y0: 0.5, x1: 0.75, y1: 1 };
        // The region is 320x240 of a 640x480 frame, enlarged 2.5x to 800x600.
        expect(fromRegion({ x: 400, y: 300 }, r, 800, 600, { width: 640, height: 480 })).toEqual({ x: 320, y: 360 });
        expect(fromRegion({ x: 0, y: 0 }, r, 800, 600, { width: 640, height: 480 })).toEqual({ x: 160, y: 240 });
    });
});
