import { describe, expect, test } from "bun:test";
import { AutoCapture, pickCode, type Detection } from "../src/scanner.ts";

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
