import { describe, expect, test } from "bun:test";
import { display, findRescan, guide, hasIdentity, isUnidentified, itemName, itemTag, normalizeItem, parseQrPayload,
    placeOfBag, placeText, qrPayload, scopeOf, search, sortItems, title, UNIDENTIFIED, unidentifiedKind, type Box,
    type Data, type Item } from "../src/model.ts";

function box(id: string, shelfId: string | null, position: number | null): Box {
    return { id, name: "", shelfId, position, created: 0 };
}

const data: Data = {
    shelves: [{ id: "shelf-1", name: "Left wall", created: 0 }, { id: "shelf-2", name: "", created: 0 }],
    boxes: [box("box-1", "shelf-1", 1), box("box-2", "shelf-1", 2), box("box-3", "shelf-1", 3),
        box("box-4", "shelf-2", 1), box("box-5", null, null)],
    bags: [{ id: "bag-1", name: "Resistors", boxId: "box-2", created: 0 }, { id: "bag-2", name: "", boxId: null, created: 0 }],
    items: [
        normalizeItem({ id: "i1", seq: 1, bagId: "bag-1", type: "resistor", name: "10k 0805", mpn: "RC0805FR-0710KL",
            vendorPn: "311-10KARCT-ND", qty: 100, source: "digikey", created: 1, updated: 1 }),
        normalizeItem({ id: "i2", seq: 2, bagId: "bag-2", type: "ic", mpn: "SN74LVC1G08DBVR", notes: "single gate AND",
            source: "digikey", created: 2, updated: 2 }),
    ],
    batches: [],
};

describe("ids and labels", () => {
    test("QR payload round trip", () => {
        expect(qrPayload("bag-7")).toBe("qrsort:bag:7");
        expect(parseQrPayload("qrsort:bag:7")).toEqual({ kind: "bag", id: "bag-7" });
        expect(parseQrPayload(" qrsort:box:12\n")).toEqual({ kind: "box", id: "box-12" });
        expect(parseQrPayload("qrsort:shelf:1")).toBeNull();
        expect(parseQrPayload("https://example.com")).toBeNull();
    });

    test("titles", () => {
        expect(title("bag-7")).toBe("Bag 7");
        expect(display({ id: "box-3", name: "Caps" })).toBe("Box 3: Caps");
        expect(display({ id: "box-3", name: "" })).toBe("Box 3");
        expect(display(null)).toBe("");
    });
});

describe("guidance along a shelf", () => {
    const [b1, b2, b3, b4, b5] = data.boxes;
    test("same box", () => expect(guide(b2, b2)).toEqual({ kind: "here" }));
    test("to the right", () => expect(guide(b1, b3)).toEqual({ kind: "right", steps: 2 }));
    test("to the left", () => expect(guide(b3, b2)).toEqual({ kind: "left", steps: 1 }));
    test("another shelf", () => expect(guide(b1, b4)).toEqual({ kind: "shelf", shelfId: "shelf-2" }));
    test("target not placed", () => expect(guide(b1, b5)).toEqual({ kind: "unknown" }));
    test("a loose box is sent to the target's shelf", () => expect(guide(b5, b1)).toEqual({ kind: "shelf", shelfId: "shelf-1" }));
});

describe("places and search", () => {
    test("place text", () => {
        expect(placeText(placeOfBag("bag-1", data))).toBe("Bag 1: Resistors in Box 2 in Shelf 1: Left wall #2");
        expect(placeText(placeOfBag("bag-2", data))).toBe("Bag 2");
        expect(placeText(placeOfBag(null, data))).toBe("not placed");
    });

    test("search matches items, bags and boxes with every word", () => {
        expect(search("10k", data).map((h) => h.id)).toEqual(["i1"]);
        expect(search("resistors", data).map((h) => h.kind)).toEqual(["bag", "item"]);
        expect(search("and gate", data).map((h) => h.id)).toEqual(["i2"]);
        expect(search("10k capacitor", data)).toEqual([]);
        expect(search("   ", data)).toEqual([]);
        expect(search("left wall", data).map((h) => h.id)).toEqual(["box-1", "box-2", "box-3"]);
    });

    test("prefix matches on the part number rank first", () => {
        const hits = search("box 2", data);
        expect(hits[0]).toMatchObject({ kind: "box", id: "box-2" });
    });
});

function item(fields: Partial<Item> & { id: string }): Item {
    return normalizeItem({ source: "digikey", created: 10, ...fields });
}

describe("records, flags and order", () => {
    const bags = [{ id: "bag-1", name: "", boxId: "box-1", created: 0 }, { id: "bag-2", name: "", boxId: "box-1", created: 0 },
        { id: "bag-3", name: "", boxId: null, created: 0 }];

    test("records from older versions get a count, merged codes, no batch, and a value from the part number", () => {
        const i = normalizeItem({ id: "x", qty: 5 });
        expect(i).toMatchObject({ count: 5, merged: [], batchId: null, seq: 0, source: "manual", flags: [], value: "" });
        expect(normalizeItem({ id: "y", qty: 5, count: 2 }).count).toBe(2);
        expect(normalizeItem({ id: "z", mpn: "RC0805FR-0710KL" }).value).toBe("10k");
        // A value that was cleared on purpose stays cleared.
        expect(normalizeItem({ id: "z", mpn: "RC0805FR-0710KL", value: "" }).value).toBe("");
    });

    test("records from before flags were kept are flagged unidentified by their source", () => {
        expect(normalizeItem({ id: "a", source: "unknown", raw: "hello" }).flags).toEqual([UNIDENTIFIED]);
        expect(normalizeItem({ id: "a", source: "photo" }).flags).toEqual([UNIDENTIFIED]);
        expect(normalizeItem({ id: "a", source: "manual" }).flags).toEqual([]);
        expect(normalizeItem({ id: "a", source: "unknown", flags: [] }).flags).toEqual([]);
    });

    test("a label counts once per place: the box, else the bag, else the batch", () => {
        const d = { bags };
        expect(scopeOf(item({ id: "a", bagId: "bag-1" }), d)).toBe("box-1");
        expect(scopeOf(item({ id: "a", bagId: "bag-2" }), d)).toBe("box-1");
        expect(scopeOf(item({ id: "a", bagId: "bag-3" }), d)).toBe("bag-3");
        expect(scopeOf(item({ id: "a", batchId: "batch-1" }), d)).toBe("batch-1");
        expect(scopeOf(item({ id: "a" }), d)).toBe("loose");
        expect(scopeOf(item({ id: "a", bagId: "bag-1", flags: [UNIDENTIFIED] }), d)).toBe("box-1");
    });

    test("a rescan is the same label in the same box; the same part from another label is not", () => {
        const a = item({ id: "a", mpn: "X", raw: "A", bagId: "bag-1" });
        const old = item({ id: "o", mpn: "X", raw: "B", merged: ["C"], bagId: "bag-1" });
        const d = { bags, items: [a, old] };
        expect(findRescan(item({ id: "n", mpn: "X", raw: "A", bagId: "bag-2" }), d)?.id).toBe("a");
        expect(findRescan(item({ id: "n", mpn: "X", raw: "C", bagId: "bag-1" }), d)?.id).toBe("o");
        expect(findRescan(item({ id: "n", mpn: "X", raw: "D", bagId: "bag-1" }), d)).toBeUndefined();
        expect(findRescan(item({ id: "n", mpn: "X", raw: "A", bagId: "bag-3" }), d)).toBeUndefined();
        expect(findRescan(item({ id: "n", mpn: "X", raw: "", bagId: "bag-1" }), d)).toBeUndefined();
        expect(findRescan(a, d)).toBeUndefined();
    });

    test("unidentified is a flag: with a code or without, and a part number or a name identifies", () => {
        const flagged = { flags: [UNIDENTIFIED] };
        expect(unidentifiedKind(item({ id: "a", raw: "hello", ...flagged }))).toBe("code");
        expect(unidentifiedKind(item({ id: "a", ...flagged }))).toBe("photo");
        expect(unidentifiedKind(item({ id: "a", raw: "hello" }))).toBeNull();
        expect(isUnidentified(item({ id: "a", bagId: "bag-1", ...flagged }))).toBe(true);
        expect(hasIdentity(item({ id: "a", notes: "white bag", raw: "hello" }))).toBe(false);
        expect(hasIdentity(item({ id: "a", name: "  " }))).toBe(false);
        expect(hasIdentity(item({ id: "a", name: "M3 screws" }))).toBe(true);
        expect(hasIdentity(item({ id: "a", vendorPn: "C14663" }))).toBe(true);
    });

    test("sorted as scanned, or by type in the usual order, then value by size, then name", () => {
        const list = [
            item({ id: "ic", seq: 1, type: "ic", mpn: "NE5532" }),
            item({ id: "r10k", seq: 2, type: "resistor", value: "10k", mpn: "B" }),
            item({ id: "c", seq: 3, type: "capacitor", value: "100nF" }),
            item({ id: "r1k", seq: 4, type: "resistor", value: "1k", mpn: "A" }),
            item({ id: "none", seq: 5 }),
            item({ id: "r", seq: 6, type: "resistor", mpn: "C" }),
            item({ id: "own", seq: 7, type: "fuse" }),
            item({ id: "r470", seq: 8, type: "Resistor", value: "470R" }),
        ];
        expect(sortItems(list, "scanned").map((i) => i.id)).toEqual(["ic", "r10k", "c", "r1k", "none", "r", "own", "r470"]);
        expect(sortItems(list, "type").map((i) => i.id)).toEqual(["r470", "r1k", "r10k", "r", "c", "ic", "own", "none"]);
    });

    test("ids, names and search", () => {
        expect(itemTag({ seq: 12 })).toBe("I-12");
        expect(itemName(item({ id: "a", vendorPn: "C1" }))).toBe("C1");
        expect(itemName(item({ id: "a", raw: "a\x1db" }))).toBe("a b");
        expect(itemName(item({ id: "a" }))).toBe("(unnamed)");
        expect(itemName(item({ id: "a", flags: [UNIDENTIFIED] }))).toBe("(photo, no code)");
        expect(search("i-2", data).map((h) => h.id)).toEqual(["i2"]);
        const photo = normalizeItem({ id: "p", seq: 3, flags: [UNIDENTIFIED] });
        const cap = normalizeItem({ id: "c", seq: 4, mpn: "CL10B104KB8NNNC" });
        const more = { ...data, items: [...data.items, photo, cap] };
        expect(search("unidentified photo", more).map((h) => h.id)).toEqual(["p"]);
        expect(search("100nf", more).map((h) => h.id)).toEqual(["c"]);
    });
});
