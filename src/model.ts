// Data model shared by the views, the database and the tests.
import { TYPES } from "./parse.ts";
import { compareValues, valueFromPartNumber } from "./value.ts";

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

export interface Batch {
    id: string; // "batch-3"
    code: string; // random uniquifier, so batches stay distinct across browsers and restores
    name: string;
    created: number;
}

export interface Item {
    id: string;
    seq: number; // short number shown as "I-12", unique within this database
    bagId: string | null;
    batchId: string | null; // the batch it was scanned in, until that batch is cleared
    type: string;
    value: string; // component value as usually written ("10k", "100nF"); guessed from the part number, editable
    name: string;
    mpn: string; // manufacturer part number
    vendorPn: string; // distributor part number (DigiKey, Mouser, LCSC)
    qty: number | null; // bag quantity: what the label said
    count: number | null; // current count on hand
    dateCode: string;
    lot: string;
    country: string;
    notes: string;
    // What the code on the bag was: digikey, mouser, lcsc, iso15434, ocr, unknown (no part number), manual, or
    // import (a row of a parts list).
    source: string;
    raw: string; // the decoded code, verbatim
    merged: string[]; // raw codes of later bags that older versions summed into this record
    flags: string[]; // markers on the record, such as UNIDENTIFIED
    importKey: string; // on records imported from a parts list: the same row imported again has the same key
    hasPhoto: boolean;
    created: number;
    updated: number;
}

export interface Data {
    shelves: Shelf[];
    boxes: Box[];
    bags: Bag[];
    items: Item[];
    batches: Batch[];
}

export function emptyData(): Data {
    return { shelves: [], boxes: [], bags: [], items: [], batches: [] };
}

export type Kind = "shelf" | "box" | "bag" | "batch";
export type LabelKind = "box" | "bag";

export const KIND_TITLE: Record<Kind, string> = { shelf: "Shelf", box: "Box", bag: "Bag", batch: "Batch" };

export function makeId(kind: Kind, n: number): string {
    return `${kind}-${n}`;
}

export function kindOf(id: string): Kind | null {
    const k = id.split("-")[0];
    return k === "shelf" || k === "box" || k === "bag" || k === "batch" ? k : null;
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

export function itemName(item: Pick<Item, "name" | "mpn" | "vendorPn" | "raw" | "flags">): string {
    return item.name || item.mpn || item.vendorPn || printable(item.raw)
        || (unidentifiedKind(item) === "photo" ? "(photo, no code)" : "(unnamed)");
}

/** The short id shown next to an item: "I-12". */
export function itemTag(item: Pick<Item, "seq">): string {
    return item.seq ? `I-${item.seq}` : "I-?";
}

/** Control characters (the separators inside bag codes) shown as spaces. */
export function printable(text: string): string {
    return text.replace(/[\x00-\x1f]+/g, " ").trim();
}

/**
 * The flag on a record nobody has identified yet: it goes where it was scanned like any other and
 * keeps the flag, wherever it is moved, until it gets a part number or a name.
 */
export const UNIDENTIFIED = "unidentified";

/**
 * What an unidentified record has to go on: a code with no part number in it ("code"), or no code
 * at all, usually a photo ("photo").
 */
export type Unidentified = "code" | "photo";

export function isUnidentified(item: Pick<Item, "flags">): boolean {
    return item.flags.includes(UNIDENTIFIED);
}

export function unidentifiedKind(item: Pick<Item, "flags" | "raw">): Unidentified | null {
    return !isUnidentified(item) ? null : item.raw ? "code" : "photo";
}

/** What identifies a record by hand: a part number or a name. */
export function hasIdentity(item: Pick<Item, "mpn" | "vendorPn" | "name">): boolean {
    return !!(item.mpn.trim() || item.vendorPn.trim() || item.name.trim());
}

/** "Batch 3 K7Q2, Oct 23 14:05" (or its name when it has one). */
export function batchTitle(b: Batch): string {
    const when = new Date(b.created).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit",
        minute: "2-digit" });
    return `${title(b.id)} ${b.code}${b.name ? `: ${b.name}` : ""}, ${when}`;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I to misread

export function randomCode(n = 4): string {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

/** Fills in fields that records from older versions lack. */
export function normalizeItem(x: Partial<Item> & { id: string }): Item {
    return {
        seq: 0, bagId: null, batchId: null, type: "", name: "", mpn: "", vendorPn: "", qty: null,
        dateCode: "", lot: "", country: "", notes: "", source: "manual", raw: "", hasPhoto: false, importKey: "",
        created: 0, updated: 0, ...x,
        count: x.count === undefined ? x.qty ?? null : x.count,
        merged: x.merged ?? [],
        // A record from before values were kept gets one read from its part number, once.
        value: x.value ?? valueFromPartNumber(x.mpn ?? ""),
        // Before flags the source said it: a code with no part number, or a photo with no code.
        flags: x.flags ?? (x.source === "unknown" || x.source === "photo" ? [UNIDENTIFIED] : []),
    };
}

/**
 * The place inside which one label counts once: the box when the bag is in one, else the bag, else
 * the batch, else "loose".
 */
export function scopeOf(item: Pick<Item, "bagId" | "batchId">, data: Pick<Data, "bags">): string {
    if (item.bagId) {
        return data.bags.find((b) => b.id === item.bagId)?.boxId ?? item.bagId;
    }
    return item.batchId ?? "loose";
}

/**
 * An earlier record of the same label in the same place: the same bag scanned twice. Different
 * bags of one part are separate records, even with the same part number.
 */
export function findRescan(item: Item, data: Pick<Data, "bags" | "items">): Item | undefined {
    if (!item.raw) {
        return undefined;
    }
    const scope = scopeOf(item, data);
    return data.items.find((o) => o.id !== item.id && (o.raw === item.raw || o.merged.includes(item.raw))
        && scopeOf(o, data) === scope);
}

export type ItemOrder = "scanned" | "type";

/** Types in the order of TYPES, ones typed in by hand after them alphabetically, no type last. */
function compareTypes(a: string, b: string): number {
    const rank = (t: string) => (!t ? 2 : TYPES.includes(t) ? 0 : 1);
    return rank(a) - rank(b) || (TYPES.includes(a) && TYPES.includes(b) ? TYPES.indexOf(a) - TYPES.indexOf(b)
        : a.localeCompare(b));
}

/** Items as scanned, or by type, then value (by size), then name with unidentified ones last. */
export function sortItems(items: Item[], order: ItemOrder): Item[] {
    const scanned = (a: Item, b: Item) => a.created - b.created || a.seq - b.seq;
    if (order !== "type") {
        return [...items].sort(scanned);
    }
    return [...items].sort((a, b) => compareTypes(a.type.toLowerCase(), b.type.toLowerCase())
        || (a.value && b.value ? compareValues(a.value, b.value) : Number(!a.value) - Number(!b.value))
        || Number(isUnidentified(a)) - Number(isUnidentified(b))
        || itemName(a).localeCompare(itemName(b), undefined, { numeric: true }) || scanned(a, b));
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
        const kind = unidentifiedKind(item);
        consider("item", item.id, `${item.mpn} ${item.name} ${itemTag(item)} ${item.value}`,
            [item.vendorPn, item.type, item.notes, item.lot, item.dateCode, display(place.bag), display(place.box),
                ...item.flags, kind === "photo" ? "photo no code" : kind === "code" ? printable(item.raw) : ""].join(" "));
    }
    for (const bag of data.bags) {
        consider("bag", bag.id, display(bag), display(data.boxes.find((b) => b.id === bag.boxId)));
    }
    for (const box of data.boxes) {
        consider("box", box.id, display(box), display(data.shelves.find((s) => s.id === box.shelfId)));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
