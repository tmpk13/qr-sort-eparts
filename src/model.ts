// Data model shared by the views, the database and the tests.

export interface Shelf {
    id: string; // "shelf-3"
    name: string;
    created: number;
}

export interface Box {
    id: string; // "box-3"
    name: string;
    shelfId: string | null;
    position: number | null; // 1 is the leftmost box on its shelf
    created: number;
}

export interface Bag {
    id: string; // "bag-3"
    name: string;
    boxId: string | null;
    created: number;
}

export interface Item {
    id: string;
    bagId: string | null;
    type: string;
    name: string;
    mpn: string; // manufacturer part number
    vendorPn: string; // distributor part number (DigiKey, Mouser, LCSC)
    qty: number | null;
    dateCode: string;
    lot: string;
    country: string;
    notes: string;
    source: string; // what the code on the bag was: digikey, mouser, lcsc, text, manual
    raw: string; // the decoded code, verbatim
    hasPhoto: boolean;
    created: number;
    updated: number;
}

export interface Data {
    shelves: Shelf[];
    boxes: Box[];
    bags: Bag[];
    items: Item[];
}

export type Kind = "shelf" | "box" | "bag";
export type LabelKind = "box" | "bag";

export const KIND_TITLE: Record<Kind, string> = { shelf: "Shelf", box: "Box", bag: "Bag" };

export function makeId(kind: Kind, n: number): string {
    return `${kind}-${n}`;
}

export function kindOf(id: string): Kind | null {
    const k = id.split("-")[0];
    return k === "shelf" || k === "box" || k === "bag" ? k : null;
}

/** "bag-7" -> "Bag 7". */
export function title(id: string): string {
    const [k, n] = id.split("-");
    const kind = kindOf(id);
    return kind ? `${KIND_TITLE[kind]} ${n}` : id;
}

/** "bag-7" + "Resistors" -> "Bag 7: Resistors". */
export function display(thing: { id: string; name: string } | null | undefined): string {
    if (!thing) {
        return "";
    }
    return thing.name ? `${title(thing.id)}: ${thing.name}` : title(thing.id);
}

export function itemName(item: Pick<Item, "name" | "mpn" | "raw">): string {
    return item.name || item.mpn || item.raw || "(unnamed)";
}

export const QR_PREFIX = "qrsort:";

/** The text printed into a bag or box label's QR code. */
export function qrPayload(id: string): string {
    const [kind, n] = id.split("-");
    return `${QR_PREFIX}${kind}:${n}`;
}

export function parseQrPayload(text: string): { kind: LabelKind; id: string } | null {
    const m = /^qrsort:(box|bag):(\d+)$/.exec(text.trim());
    return m ? { kind: m[1] as LabelKind, id: makeId(m[1] as LabelKind, Number(m[2])) } : null;
}

export type Guide =
    | { kind: "here" }
    | { kind: "left" | "right"; steps: number }
    | { kind: "shelf"; shelfId: string } // the target sits on another shelf
    | { kind: "unknown" }; // the seen box or the target has no place on a shelf

/** Where the target box is, relative to a box the camera can see. */
export function guide(seen: Box, target: Box): Guide {
    if (seen.id === target.id) {
        return { kind: "here" };
    }
    if (target.shelfId == null || target.position == null) {
        return { kind: "unknown" };
    }
    if (seen.shelfId !== target.shelfId) {
        return { kind: "shelf", shelfId: target.shelfId };
    }
    if (seen.position == null) {
        return { kind: "unknown" };
    }
    const d = target.position - seen.position;
    return d > 0 ? { kind: "right", steps: d } : { kind: "left", steps: -d };
}

export interface Place {
    bag: Bag | null;
    box: Box | null;
    shelf: Shelf | null;
}

export function placeOfBag(bagId: string | null, data: Data): Place {
    const bag = data.bags.find((b) => b.id === bagId) ?? null;
    const box = data.boxes.find((b) => b.id === bag?.boxId) ?? null;
    const shelf = data.shelves.find((s) => s.id === box?.shelfId) ?? null;
    return { bag, box, shelf };
}

export function placeText(p: Place): string {
    const parts: string[] = [];
    if (p.bag) {
        parts.push(display(p.bag));
    }
    if (p.box) {
        parts.push(display(p.box));
    }
    if (p.shelf) {
        parts.push(display(p.shelf) + (p.box?.position != null ? ` #${p.box.position}` : ""));
    }
    return parts.length ? parts.join(" in ") : "not placed";
}

export interface Hit {
    kind: "item" | "bag" | "box";
    id: string;
    score: number;
}

/** Every word of the query must occur in the record or its containers; higher scores first. */
export function search(query: string, data: Data, limit = 50): Hit[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
        return [];
    }
    const hits: Hit[] = [];
    const consider = (kind: Hit["kind"], id: string, primary: string, rest: string) => {
        const p = primary.toLowerCase();
        const all = `${p} ${rest.toLowerCase()}`;
        let score = 0;
        for (const w of words) {
            if (!all.includes(w)) {
                return;
            }
            score += p.startsWith(w) ? 3 : p.includes(w) ? 2 : 1;
        }
        hits.push({ kind, id, score });
    };
    for (const item of data.items) {
        const place = placeOfBag(item.bagId, data);
        consider("item", item.id, `${item.mpn} ${item.name}`,
            [item.vendorPn, item.type, item.notes, item.lot, item.dateCode, display(place.bag), display(place.box)].join(" "));
    }
    for (const bag of data.bags) {
        consider("bag", bag.id, display(bag), display(data.boxes.find((b) => b.id === bag.boxId)));
    }
    for (const box of data.boxes) {
        consider("box", box.id, display(box), display(data.shelves.find((s) => s.id === box.shelfId)));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
