import { describe, expect, test } from "bun:test";
import { CSV_COLUMNS, csvCell, toCsv } from "../src/csv.ts";
import { normalizeItem, type Data } from "../src/model.ts";

describe("CSV export", () => {
    test("cells are quoted when they need it and kept from running as formulas", () => {
        expect(csvCell("plain")).toBe("plain");
        expect(csvCell(null)).toBe("");
        expect(csvCell(12)).toBe("12");
        expect(csvCell('say "hi", twice')).toBe('"say ""hi"", twice"');
        expect(csvCell("two\nlines")).toBe('"two\nlines"');
        expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
        expect(csvCell("-ND")).toBe("-ND");
    });

    test("one row per item, places spelled out, shelf order first", () => {
        const data: Data = {
            shelves: [{ id: "shelf-1", name: "Wall", created: 0 }],
            boxes: [{ id: "box-1", name: "", shelfId: "shelf-1", position: 2, created: 0 },
                { id: "box-2", name: "Front", shelfId: "shelf-1", position: 1, created: 0 }],
            bags: [{ id: "bag-1", name: "Caps", boxId: "box-1", created: 0 }, { id: "bag-2", name: "", boxId: "box-2", created: 0 }],
            items: [
                normalizeItem({ id: "a", seq: 1, bagId: "bag-1", mpn: "GRM1", qty: 100, count: 60, source: "mouser",
                    raw: "[)>\x1e06\x1d1PGRM1", created: Date.UTC(2026, 9, 23) }),
                normalizeItem({ id: "b", seq: 2, bagId: "bag-2", mpn: "SN74", qty: 10, notes: "a, b", source: "digikey" }),
                normalizeItem({ id: "c", seq: 3, batchId: "batch-1", vendorPn: "C1", source: "lcsc" }),
            ],
            batches: [{ id: "batch-1", code: "K7Q2", name: "", created: 0 }],
        };
        const lines = toCsv(data).split("\r\n");
        expect(lines[0]).toBe(CSV_COLUMNS.join(","));
        expect(lines).toHaveLength(5);
        expect(lines[4]).toBe("");
        expect(lines[1]).toStartWith("I-2,,,SN74,,10,10,,,,digikey,Bag 2,Box 2: Front,Shelf 1: Wall,1,,\"a, b\",,");
        expect(lines[2]).toStartWith("I-1,,,GRM1,,100,60,,,,mouser,Bag 1: Caps,Box 1,Shelf 1: Wall,2,,,[)> 06 1PGRM1,");
        expect(lines[2]).toEndWith(",2026-10-23T00:00:00.000Z");
        expect(lines[3]).toContain("Batch 1 K7Q2");
    });
});
