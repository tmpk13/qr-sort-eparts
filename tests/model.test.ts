import { describe, expect, test } from "bun:test";
import { display, guide, parseQrPayload, placeOfBag, placeText, qrPayload, search, title, type Box, type Data }
    from "../src/model.ts";

function box(id: string, shelfId: string | null, position: number | null): Box {
    return { id, name: "", shelfId, position, created: 0 };
}

const data: Data = {
    shelves: [{ id: "shelf-1", name: "Left wall", created: 0 }, { id: "shelf-2", name: "", created: 0 }],
    boxes: [box("box-1", "shelf-1", 1), box("box-2", "shelf-1", 2), box("box-3", "shelf-1", 3),
        box("box-4", "shelf-2", 1), box("box-5", null, null)],
    bags: [{ id: "bag-1", name: "Resistors", boxId: "box-2", created: 0 }, { id: "bag-2", name: "", boxId: null, created: 0 }],
    items: [
        { id: "i1", bagId: "bag-1", type: "resistor", name: "10k 0805", mpn: "RC0805FR-0710KL", vendorPn: "311-10KARCT-ND",
            qty: 100, dateCode: "", lot: "", country: "", notes: "", source: "digikey", raw: "", hasPhoto: false, created: 1, updated: 1 },
        { id: "i2", bagId: "bag-2", type: "ic", name: "", mpn: "SN74LVC1G08DBVR", vendorPn: "", qty: null, dateCode: "", lot: "",
            country: "", notes: "single gate AND", source: "digikey", raw: "", hasPhoto: false, created: 2, updated: 2 },
    ],
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
