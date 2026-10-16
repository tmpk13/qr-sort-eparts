// Round trips through the same decoder the app uses: write a code, read it back, parse it.
import { describe, expect, test } from "bun:test";
import { prepareZXingModule, readBarcodes, writeBarcode } from "zxing-wasm/full";
import { parseQrPayload, qrPayload } from "../src/model.ts";
import { parseCode } from "../src/parse.ts";
import { DK_OLD, LCSC } from "./fixtures.ts";

prepareZXingModule({
    overrides: { wasmBinary: await Bun.file("node_modules/zxing-wasm/dist/full/zxing_full.wasm").arrayBuffer() },
});

describe("decoder round trips", () => {
    test("DigiKey Data Matrix with its control characters", async () => {
        const w = await writeBarcode(DK_OLD, { format: "DataMatrix", scale: 4 });
        expect(w.image).not.toBeNull();
        const r = await readBarcodes(w.image!, { formats: ["DataMatrix"], textMode: "Plain" });
        expect(r).toHaveLength(1);
        expect(r[0].text).toBe(DK_OLD);
        const p = parseCode(r[0].text);
        expect(p.source).toBe("digikey");
        expect(p.mpn).toBe("SN74LVC1G08DBVR");
        expect(p.qty).toBe(10);
    });

    test("LCSC QR code", async () => {
        const w = await writeBarcode(LCSC, { format: "QRCode", scale: 4 });
        const r = await readBarcodes(w.image!, { formats: ["QRCode", "DataMatrix"], textMode: "Plain" });
        expect(parseCode(r[0].text).vendorPn).toBe("C14663");
    });

    test("our own labels", async () => {
        const w = await writeBarcode(qrPayload("box-12"), { format: "QRCode", scale: 4 });
        const r = await readBarcodes(w.image!, { formats: ["QRCode"], textMode: "Plain" });
        expect(parseQrPayload(r[0].text)).toEqual({ kind: "box", id: "box-12" });
        expect(r[0].position.topLeft.x).toBeGreaterThanOrEqual(0);
    });
});
