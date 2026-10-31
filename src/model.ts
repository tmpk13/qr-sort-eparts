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
    name: string;
    mpn: string; // manufacturer part number
    vendorPn: string; // distributor part number (DigiKey, Mouser, LCSC)
    qty: number | null; // bag quantity: what the labels said, summed over every bag merged in
    count: number | null; // current count on hand
    dateCode: string;
    lot: string;
    country: string;
    notes: string;
    source: string; // what the code on the bag was: digikey, mouser, lcsc, iso15434, ocr, manual, unknown; photo when none read
    raw: string; // the decoded code, verbatim
    merged: string[]; // raw codes of later bags merged into this record
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

export function itemName(item: Pick<Item, "name" | "mpn" | "vendorPn" | "raw" | "source">): string {
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
 * Why a record waits to be identified: its code had no part number in it ("code"), or its bag had no
 * code that would read and only a photo was kept ("photo").
 */
export type Unidentified = "code" | "photo";

export function unidentifiedKind(item: Pick<Item, "source">): Unidentified | null {
    return item.source === "unknown" ? "code" : item.source === "photo" ? "photo" : null;
}

/**
 * A record that waits in a list of its own until someone identifies it. Where it is kept does not
 * matter: putting it in a bag, or its bag in a box, leaves it waiting.
 */
export function isUnidentified(item: Pick<Item, "source">): boolean {
    return unidentifiedKind(item) !== null;
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
        dateCode: "", lot: "", country: "", notes: "", source: "manual", raw: "", hasPhoto: false,
        created: 0, updated: 0, ...x,
        count: x.count === undefined ? x.qty ?? null : x.count,
        merged: x.merged ?? [],
    };
}

/**
 * The place inside which a part number may appear only once: the box when the bag is in one, else
 * the bag, else the batch, else "loose". Records waiting to be identified share one place of their
 * own, wherever they are kept.
 */
export function scopeOf(item: Pick<Item, "bagId" | "batchId" | "source">, data: Pick<Data, "bags">): string {
    if (isUnidentified(item)) {
        return "unknown";
    }
    if (item.bagId) {
        return data.bags.find((b) => b.id === item.bagId)?.boxId ?? item.bagId;
    }
    return item.batchId ?? "loose";
}

/** What makes two records the same part; empty for a record with nothing to compare. */
export function partKey(item: Pick<Item, "mpn" | "vendorPn" | "raw" | "source">): string {
    if (isUnidentified(item)) {
        return item.raw ? `raw:${item.raw}` : "";
    }
    const pn = (item.mpn || item.vendorPn).trim().toUpperCase();
    return pn ? `pn:${pn}` : "";
}

/** Another record of the same part in the same place, which this one should be merged into. */
export function findTwin(item: Item, data: Pick<Data, "bags" | "items">): Item | undefined {
    const key = partKey(item);
    if (!key) {
        return undefined;
    }
    const scope = scopeOf(item, data);
    return data.items
        .filter((o) => o.id !== item.id && partKey(o) === key && scopeOf(o, data) === scope)
        .sort((a, b) => a.created - b.created)[0];
}

/** True when the incoming record is a label already counted in the target (the same bag scanned twice). */
export function isRescan(target: Item, incoming: Item): boolean {
    const known = new Set([target.raw, ...target.merged]);
    const codes = [incoming.raw, ...incoming.merged].filter(Boolean);
    return codes.length > 0 && codes.every((c) => known.has(c));
}

function add(a: number | null, b: number | null): number | null {
    return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

/** The target with the incoming bag added: quantities summed, blanks filled, codes remembered. */
export function mergeInto(target: Item, incoming: Item): Item {
    if (isRescan(target, incoming)) {
        return target;
    }
    const codes = [incoming.raw, ...incoming.merged].filter((r) => r && r !== target.raw && !target.merged.includes(r));
    const notes = [target.notes, incoming.notes].filter(Boolean);
    return {
        ...target,
        qty: add(target.qty, incoming.qty),
        count: add(target.count, incoming.count),
        type: target.type || incoming.type,
        name: target.name || incoming.name,
        mpn: target.mpn || incoming.mpn,
        vendorPn: target.vendorPn || incoming.vendorPn,
        dateCode: target.dateCode || incoming.dateCode,
        lot: target.lot || incoming.lot,
        country: target.country || incoming.country,
        notes: [...new Set(notes)].join("\n"),
        merged: [...target.merged, ...codes],
    };
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
        consider("item", item.id, `${item.mpn} ${item.name} ${itemTag(item)}`,
            [item.vendorPn, item.type, item.notes, item.lot, item.dateCode, display(place.bag), display(place.box),
                unidentifiedKind(item) === "photo" ? "unidentified photo no code"
                    : isUnidentified(item) ? `unidentified ${printable(item.raw)}` : ""].join(" "));
    }
    for (const bag of data.bags) {
        consider("bag", bag.id, display(bag), display(data.boxes.find((b) => b.id === bag.boxId)));
    }
    for (const box of data.boxes) {
        consider("box", box.id, display(box), display(data.shelves.find((s) => s.id === box.shelfId)));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
