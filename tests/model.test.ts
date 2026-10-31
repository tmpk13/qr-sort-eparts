import { describe, expect, test } from "bun:test";
import { display, findTwin, guide, hasIdentity, isRescan, isUnidentified, itemName, itemTag, mergeInto, normalizeItem,
    parseQrPayload, partKey, placeOfBag, placeText, qrPayload, scopeOf, search, title, unidentifiedKind, type Box,
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

describe("one record per part in a box", () => {
    const bags = [{ id: "bag-1", name: "", boxId: "box-1", created: 0 }, { id: "bag-2", name: "", boxId: "box-1", created: 0 },
        { id: "bag-3", name: "", boxId: null, created: 0 }];

    test("records from older versions get a count, merged codes and no batch", () => {
        const i = normalizeItem({ id: "x", qty: 5 });
        expect(i).toMatchObject({ count: 5, merged: [], batchId: null, seq: 0, source: "manual" });
        expect(normalizeItem({ id: "y", qty: 5, count: 2 }).count).toBe(2);
    });

    test("the place is the box, else the bag, else the batch; unidentified scans have their own", () => {
        const d = { bags };
        expect(scopeOf(item({ id: "a", bagId: "bag-1" }), d)).toBe("box-1");
        expect(scopeOf(item({ id: "a", bagId: "bag-2" }), d)).toBe("box-1");
        expect(scopeOf(item({ id: "a", bagId: "bag-3" }), d)).toBe("bag-3");
        expect(scopeOf(item({ id: "a", batchId: "batch-1" }), d)).toBe("batch-1");
        expect(scopeOf(item({ id: "a" }), d)).toBe("loose");
        expect(scopeOf(item({ id: "a", bagId: "bag-1", source: "unknown" }), d)).toBe("unknown");
        expect(scopeOf(item({ id: "a", bagId: "bag-1", source: "photo" }), d)).toBe("unknown");
    });

    test("parts compare by manufacturer PN, then vendor PN, ignoring case; unidentified scans by their code", () => {
        expect(partKey(item({ id: "a", mpn: "ne5532adr " }))).toBe("pn:NE5532ADR");
        expect(partKey(item({ id: "a", vendorPn: "C14663" }))).toBe("pn:C14663");
        expect(partKey(item({ id: "a" }))).toBe("");
        expect(partKey(item({ id: "a", source: "unknown", raw: "hello" }))).toBe("raw:hello");
        expect(partKey(item({ id: "a", source: "photo" }))).toBe(""); // every photo is a bag of its own
    });

    test("codes with no part number and photos with no code wait to be identified; a part number or a name does it", () => {
        expect(unidentifiedKind(item({ id: "a", source: "unknown" }))).toBe("code");
        expect(unidentifiedKind(item({ id: "a", source: "photo" }))).toBe("photo");
        expect(unidentifiedKind(item({ id: "a", source: "manual" }))).toBeNull();
        expect(isUnidentified(item({ id: "a", source: "photo", bagId: "bag-1" }))).toBe(true);
        expect(hasIdentity(item({ id: "a", notes: "white bag", raw: "hello" }))).toBe(false);
        expect(hasIdentity(item({ id: "a", name: "  " }))).toBe(false);
        expect(hasIdentity(item({ id: "a", name: "M3 screws" }))).toBe(true);
        expect(hasIdentity(item({ id: "a", vendorPn: "C14663" }))).toBe(true);
    });

    test("a twin is the oldest other record of the part in the same box", () => {
        const a = item({ id: "a", mpn: "X", bagId: "bag-1", created: 2 });
        const b = item({ id: "b", mpn: "X", bagId: "bag-2", created: 1 });
        const c = item({ id: "c", mpn: "X", bagId: "bag-3", created: 0 });
        const d = { bags, items: [a, b, c] };
        expect(findTwin(item({ id: "new", mpn: "x", bagId: "bag-1" }), d)?.id).toBe("b");
        expect(findTwin(item({ id: "new", mpn: "X", bagId: "bag-3" }), d)?.id).toBe("c");
        expect(findTwin(item({ id: "new", mpn: "Y", bagId: "bag-1" }), d)).toBeUndefined();
        expect(findTwin(a, d)?.id).toBe("b");
    });

    test("merging sums bag quantity and count, fills blanks and remembers the code", () => {
        const t = item({ id: "t", mpn: "X", qty: 10, count: 4, raw: "A", country: "" });
        const m = mergeInto(t, item({ id: "n", mpn: "X", qty: 5, raw: "B", country: "CN", lot: "L1", notes: "n" }));
        expect(m).toMatchObject({ id: "t", qty: 15, count: 9, country: "CN", lot: "L1", notes: "n", merged: ["B"] });
        expect(mergeInto(t, item({ id: "n", mpn: "X", qty: null, raw: "C" }))).toMatchObject({ qty: 10, count: 4 });
    });

    test("the same label scanned again adds nothing", () => {
        const t = item({ id: "t", mpn: "X", qty: 10, raw: "A", merged: ["B"] });
        expect(isRescan(t, item({ id: "n", raw: "A" }))).toBe(true);
        expect(isRescan(t, item({ id: "n", raw: "B" }))).toBe(true);
        expect(isRescan(t, item({ id: "n", raw: "C" }))).toBe(false);
        expect(isRescan(t, item({ id: "n", raw: "" }))).toBe(false);
        expect(mergeInto(t, item({ id: "n", mpn: "X", qty: 10, raw: "A" }))).toBe(t);
    });

    test("ids and names", () => {
        expect(itemTag({ seq: 12 })).toBe("I-12");
        expect(itemName(item({ id: "a", vendorPn: "C1" }))).toBe("C1");
        expect(itemName(item({ id: "a", raw: "a\x1db" }))).toBe("a b");
        expect(itemName(item({ id: "a" }))).toBe("(unnamed)");
        expect(itemName(item({ id: "a", source: "photo" }))).toBe("(photo, no code)");
        expect(search("i-2", data).map((h) => h.id)).toEqual(["i2"]);
        const photo = normalizeItem({ id: "p", seq: 3, source: "photo" });
        expect(search("unidentified photo", { ...data, items: [...data.items, photo] }).map((h) => h.id)).toEqual(["p"]);
    });
});
