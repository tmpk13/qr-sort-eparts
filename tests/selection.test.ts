import { describe, expect, test } from "bun:test";
import { normalizeItem, type Data } from "../src/model.ts";
import { editRows, selectRows } from "../src/selection.ts";

const data: Data = {
    shelves: [{ id: "shelf-1", name: "", created: 0 }],
    boxes: [{ id: "box-1", name: "", shelfId: "shelf-1", position: 1, created: 0 }],
    bags: [{ id: "bag-1", name: "", boxId: "box-1", created: 0 }, { id: "bag-2", name: "", boxId: null, created: 1 }],
    items: [
        normalizeItem({ id: "a", seq: 1, bagId: "bag-1", mpn: "A" }),
        normalizeItem({ id: "b", seq: 2, bagId: "bag-1", mpn: "B" }),
        normalizeItem({ id: "c", seq: 3, bagId: "bag-2", mpn: "C" }),
        normalizeItem({ id: "d", seq: 4, mpn: "D" }),
        normalizeItem({ id: "e", seq: 5, batchId: "batch-1", mpn: "E" }),
        normalizeItem({ id: "f", seq: 6, source: "unknown", raw: "junk" }),
        normalizeItem({ id: "g", seq: 7, bagId: "bag-1", source: "photo" }),
        normalizeItem({ id: "h", seq: 8, bagId: "bag-1", type: "resistor", mpn: "RC0805FR-071KL" }),
    ],
    batches: [{ id: "batch-1", code: "AAAA", name: "", created: 0 }],
};

describe("edit mode rows", () => {
    test("the tree in display order, with headings for each place; unidentified items sit where they are", () => {
        expect(editRows(data).map((r) => `${r.kind}:${r.id}`)).toEqual([
            "head:shelf-1", "box:box-1", "bag:bag-1", "item:a", "item:b", "item:g", "item:h",
            "head:loose", "bag:bag-2", "item:c", "item:d", "item:f",
            "head:batch-1", "item:e",
        ]);
    });

    test("labels carry the value and the unidentified flag; items can be sorted by type", () => {
        const rows = editRows(data);
        expect(rows.find((r) => r.id === "g")?.label).toBe("I-7 (photo, no code) (unidentified)");
        expect(rows.find((r) => r.id === "f")?.label).toBe("I-6 junk (unidentified)");
        expect(rows.find((r) => r.id === "h")?.label).toBe("I-8 1k RC0805FR-071KL");
        const bag1 = editRows(data, "type").filter((r) => r.kind === "item" && r.item?.bagId === "bag-1").map((r) => r.id);
        expect(bag1).toEqual(["h", "a", "b", "g"]);
    });

    test("click toggles, shift-click adds the run of the clicked kind", () => {
        const rows = editRows(data);
        const row = (id: string) => rows.find((r) => r.id === id)!;
        let sel = selectRows(rows, new Set(), null, row("a"), false);
        expect([...sel]).toEqual(["a"]);
        sel = selectRows(rows, sel, "a", row("d"), true);
        // bag-2 in between is a bag, so it stays out; bag-1's unidentified item g is an item like the rest.
        expect([...sel].sort()).toEqual(["a", "b", "c", "d", "g", "h"]);
        sel = selectRows(rows, sel, "d", row("b"), false);
        expect([...sel].sort()).toEqual(["a", "c", "d", "g", "h"]);
        // Shift-click upward works the same way, and selects bags when a bag was clicked.
        expect([...selectRows(rows, new Set(), "item-none", row("bag-2"), true)]).toEqual(["bag-2"]);
        expect([...selectRows(rows, new Set(), "e", row("bag-1"), true)].sort()).toEqual(["bag-1", "bag-2"]);
    });
});
