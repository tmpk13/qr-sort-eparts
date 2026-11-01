// In-memory copy of the database that the views render from; every mutation writes through and
// notifies the subscribed components.
import { useEffect, useState } from "preact/hooks";
import { Db, type Backup } from "./db.ts";
import { findPlace, placeRef, type ImportRow, type Made, type PlaceRef } from "./importer.ts";
import { emptyData, findRescan, hasIdentity, isUnidentified, makeId, normalizeItem, randomCode, UNIDENTIFIED,
    unidentifiedKind, type Bag, type Batch, type Box, type Data, type Item, type Shelf, type Unidentified }
    from "./model.ts";

type Listener = (d: Data) => void;

/** What became of a saved record. */
export interface SaveResult {
    item: Item; // the record as stored, or for a rescan the earlier record of that label
    rescan: boolean; // the same label had been scanned into this place already; nothing was saved
}

export class Store {
    data: Data = emptyData();
    db!: Db;
    private listeners = new Set<Listener>();

    async init(db?: Db): Promise<void> {
        this.db = db ?? (await Db.open());
        await this.refresh();
    }

    async refresh(): Promise<void> {
        this.data = await this.db.all();
        for (const l of this.listeners) {
            l(this.data);
        }
    }

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    }

    shelf(id: string | null | undefined): Shelf | undefined {
        return this.data.shelves.find((s) => s.id === id);
    }

    box(id: string | null | undefined): Box | undefined {
        return this.data.boxes.find((b) => b.id === id);
    }

    bag(id: string | null | undefined): Bag | undefined {
        return this.data.bags.find((b) => b.id === id);
    }

    item(id: string | null | undefined): Item | undefined {
        return this.data.items.find((i) => i.id === id);
    }

    boxesOn(shelfId: string | null): Box[] {
        return this.data.boxes
            .filter((b) => b.shelfId === shelfId)
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.created - b.created);
    }

    bagsIn(boxId: string | null): Bag[] {
        return this.data.bags.filter((b) => b.boxId === boxId).sort((a, b) => a.created - b.created
            || a.id.localeCompare(b.id, undefined, { numeric: true }));
    }

    batch(id: string | null | undefined): Batch | undefined {
        return this.data.batches.find((b) => b.id === id);
    }

    /** Items in a bag, unidentified ones included; with null, the ones in no bag and no batch. */
    itemsIn(bagId: string | null): Item[] {
        return this.data.items
            .filter((i) => i.bagId === bagId && (bagId !== null || !i.batchId))
            .sort((a, b) => a.created - b.created || a.seq - b.seq);
    }

    itemsInBatch(batchId: string): Item[] {
        return this.data.items.filter((i) => i.batchId === batchId).sort((a, b) => a.created - b.created || a.seq - b.seq);
    }

    /** Unidentified records, newest first: all of them, or those of one kind. */
    unidentified(kind?: Unidentified): Item[] {
        return this.data.items.filter((i) => (kind ? unidentifiedKind(i) === kind : isUnidentified(i)))
            .sort((a, b) => b.created - a.created);
    }

    /** Unidentified records in one of these bags. */
    unidentifiedIn(bagIds: string[]): Item[] {
        return this.data.items.filter((i) => i.bagId !== null && bagIds.includes(i.bagId) && isUnidentified(i));
    }

    private queue: Promise<unknown> = Promise.resolve();

    /** Mutations run one after another, so id counters and shelf positions never race. */
    private run<T>(fn: () => Promise<T>): Promise<T> {
        const p = this.queue.then(fn, fn);
        this.queue = p.catch(() => undefined);
        return p;
    }

    createShelf(name = ""): Promise<Shelf> {
        return this.run(async () => {
            const s: Shelf = { id: await this.db.nextId("shelf"), name, created: Date.now() };
            await this.db.putShelf(s);
            await this.refresh();
            return s;
        });
    }

    saveShelf(s: Shelf): Promise<void> {
        return this.run(async () => {
            await this.db.putShelf(s);
            await this.refresh();
        });
    }

    /** New box at the end of the shelf (unplaced when shelfId is null). */
    createBox(name = "", shelfId: string | null = null): Promise<Box> {
        return this.run(async () => {
            const position = shelfId ? this.boxesOn(shelfId).length + 1 : null;
            const b: Box = { id: await this.db.nextId("box"), name, shelfId, position, created: Date.now() };
            await this.db.putBoxes([b]);
            await this.refresh();
            return b;
        });
    }

    saveBox(b: Box): Promise<void> {
        return this.run(async () => {
            await this.db.putBoxes([b]);
            await this.refresh();
        });
    }

    /** Puts the box at a position on a shelf (or off any shelf) and renumbers both shelves 1..n. */
    moveBox(id: string, shelfId: string | null, position: number | null): Promise<void> {
        return this.run(() => this.placeBox(id, shelfId, position));
    }

    private async placeBox(id: string, shelfId: string | null, position: number | null): Promise<void> {
        const box = this.box(id);
        if (!box) {
            return;
        }
        const changed: Box[] = [];
        const renumber = (boxes: Box[]) => {
            boxes.forEach((b, i) => {
                if (b.position !== i + 1) {
                    changed.push({ ...b, position: i + 1 });
                }
            });
        };
        if (box.shelfId) {
            renumber(this.boxesOn(box.shelfId).filter((b) => b.id !== id));
        }
        if (shelfId) {
            const others = this.boxesOn(shelfId).filter((b) => b.id !== id);
            const at = Math.min(Math.max(position ?? others.length + 1, 1), others.length + 1);
            const moved = { ...box, shelfId, position: at };
            others.splice(at - 1, 0, moved);
            changed.push(moved);
            renumber(others);
        } else {
            changed.push({ ...box, shelfId: null, position: null });
        }
        await this.db.putBoxes(changed);
        await this.refresh();
    }

    createBag(name = "", boxId: string | null = null): Promise<Bag> {
        return this.run(async () => {
            const b: Bag = { id: await this.db.nextId("bag"), name, boxId, created: Date.now() };
            await this.db.putBag(b);
            await this.refresh();
            return b;
        });
    }

    saveBag(b: Bag): Promise<void> {
        return this.run(async () => {
            await this.db.putBag(b);
            await this.refresh();
        });
    }

    /**
     * Stores the item; a photo given replaces the stored one. A new record whose label was already
     * scanned into the same box (bag, batch) is not stored again.
     */
    saveItem(item: Item, photo?: Blob | null): Promise<SaveResult> {
        return this.run(async () => {
            const r = await this.put(item, photo);
            await this.refresh();
            return r;
        });
    }

    private async put(item: Item, photo?: Blob | null): Promise<SaveResult> {
        const next = normalizeItem(item);
        if (!this.item(next.id)) {
            const earlier = findRescan(next, this.data);
            if (earlier) {
                return { item: earlier, rescan: true };
            }
            if (!next.seq) {
                next.seq = await this.db.nextNumber("item");
            }
            if (!hasIdentity(next) && !isUnidentified(next)) {
                // Nothing says what it is: it is filed where it was scanned, flagged until someone identifies it.
                next.flags = [...next.flags, UNIDENTIFIED];
            }
        }
        if (isUnidentified(next) && hasIdentity(next)) {
            next.flags = next.flags.filter((f) => f !== UNIDENTIFIED);
        }
        const stored = { ...next, hasPhoto: next.hasPhoto || !!photo, updated: Date.now() };
        await this.db.putItem(stored, photo);
        return { item: stored, rescan: false };
    }

    /** Puts items in a bag (null: out of any bag); unidentified ones stay unidentified. */
    moveItems(ids: string[], bagId: string | null): Promise<SaveResult[]> {
        return this.run(async () => {
            const out: SaveResult[] = [];
            for (const id of ids) {
                const item = this.item(id);
                if (item) {
                    out.push(await this.put({ ...item, bagId }));
                }
            }
            await this.refresh();
            return out;
        });
    }

    moveBags(ids: string[], boxId: string | null): Promise<void> {
        return this.run(async () => {
            for (const id of ids) {
                const bag = this.bag(id);
                if (bag && bag.boxId !== boxId) {
                    await this.db.putBag({ ...bag, boxId });
                }
            }
            await this.refresh();
        });
    }

    /** Boxes go to the right end of the shelf in the order given; null takes them off any shelf. */
    moveBoxes(ids: string[], shelfId: string | null): Promise<void> {
        return this.run(async () => {
            for (const id of ids) {
                await this.placeBox(id, shelfId, null);
            }
        });
    }

    createBatch(name = ""): Promise<Batch> {
        return this.run(async () => {
            const b: Batch = { id: await this.db.nextId("batch"), code: randomCode(), name, created: Date.now() };
            await this.db.putBatch(b);
            await this.refresh();
            return b;
        });
    }

    saveBatch(b: Batch): Promise<void> {
        return this.run(async () => {
            await this.db.putBatch(b);
            await this.refresh();
        });
    }

    /** Puts every item of the batch that is not in a bag yet into the bag; the batch stays as a record. */
    putBatchInBag(batchId: string, bagId: string): Promise<SaveResult[]> {
        const ids = this.itemsInBatch(batchId).filter((i) => !i.bagId).map((i) => i.id);
        return this.moveItems(ids, bagId);
    }

    /** Removes the batch without removing its items. */
    clearBatch(id: string): Promise<void> {
        return this.run(async () => {
            await this.db.deleteBatch(id);
            await this.refresh();
        });
    }

    deleteItem(id: string): Promise<void> {
        return this.run(async () => {
            await this.db.deleteItem(id);
            await this.refresh();
        });
    }

    deleteBag(id: string): Promise<void> {
        return this.run(async () => {
            await this.db.deleteBag(id);
            await this.refresh();
        });
    }

    deleteBox(id: string): Promise<void> {
        return this.run(async () => {
            if (this.box(id)?.shelfId) {
                await this.placeBox(id, null, null);
            }
            await this.db.deleteBox(id);
            await this.refresh();
        });
    }

    deleteShelf(id: string): Promise<void> {
        return this.run(async () => {
            await this.db.deleteShelf(id);
            await this.refresh();
        });
    }

    /**
     * Files imported rows as new items, finding or making their shelves, boxes and bags; a row whose
     * key is taken already is left out. Says for each row whether it was added.
     */
    importRows(rows: ImportRow[]): Promise<{ added: boolean[]; made: Made }> {
        return this.run(async () => {
            // Copies that the import adds to as it goes, so later rows find what earlier ones made.
            const d = this.data;
            this.data = { ...d, shelves: [...d.shelves], boxes: [...d.boxes], bags: [...d.bags], items: [...d.items] };
            const keys = new Set(this.data.items.map((i) => i.importKey).filter(Boolean));
            const made: Made = { shelves: 0, boxes: 0, bags: 0 };
            const added: boolean[] = [];
            try {
                for (const row of rows) {
                    if (keys.has(row.key)) {
                        added.push(false);
                        continue;
                    }
                    keys.add(row.key);
                    // A named box or bag is looked for in the place the row names, or anywhere when it names
                    // none; the bag named after the table only in the row's box, or in no box.
                    const shelf = row.shelf ? await this.importPlace("shelf", placeRef("shelf", row.shelf), undefined,
                        made) : null;
                    const box = row.box ? await this.importPlace("box", placeRef("box", row.box), shelf ?? undefined,
                        made) : null;
                    const bag = row.bag ? await this.importPlace("bag", placeRef("bag", row.bag), box ?? undefined, made)
                        : await this.importPlace("bag", { n: null, name: row.table }, box, made);
                    const r = await this.put({ ...blankItem(bag), ...row.item, bagId: bag, batchId: null,
                        importKey: row.key });
                    if (!r.rescan) {
                        this.data.items.push(r.item);
                    }
                    added.push(!r.rescan);
                }
            } finally {
                await this.refresh();
            }
            return { added, made };
        });
    }

    /** The shelf, box or bag a row names; made when there is none, with the row's number while it is free. */
    private async importPlace(kind: "shelf" | "box" | "bag", ref: PlaceRef, within: string | null | undefined,
        made: Made): Promise<string> {
        const d = this.data;
        const things: (Shelf | Box | Bag)[] = kind === "shelf" ? d.shelves : kind === "box" ? d.boxes : d.bags;
        const parentOf = (t: Shelf | Box | Bag) => ("shelfId" in t ? t.shelfId : "boxId" in t ? t.boxId : null);
        const found = findPlace(kind, ref, things, parentOf, within);
        if (found) {
            return found.id;
        }
        const parentId = within ?? null;
        const n = ref.n;
        const own = n !== null && !things.some((t) => t.id === makeId(kind, n));
        const id = own ? makeId(kind, n) : await this.db.nextId(kind);
        if (own) {
            await this.db.reserveNumber(kind, n);
        }
        const created = Date.now();
        if (kind === "shelf") {
            const s: Shelf = { id, name: ref.name, created };
            await this.db.putShelf(s);
            d.shelves.push(s);
            made.shelves++;
        } else if (kind === "box") {
            const position = parentId ? this.boxesOn(parentId).length + 1 : null;
            const b: Box = { id, name: ref.name, shelfId: parentId, position, created };
            await this.db.putBoxes([b]);
            d.boxes.push(b);
            made.boxes++;
        } else {
            const b: Bag = { id, name: ref.name, boxId: parentId, created };
            await this.db.putBag(b);
            d.bags.push(b);
            made.bags++;
        }
        return id;
    }

    exportBackup(): Promise<Backup> {
        return this.db.export();
    }

    importBackup(b: Backup): Promise<void> {
        return this.run(async () => {
            await this.db.import(b);
            await this.refresh();
        });
    }

    clearAll(): Promise<void> {
        return this.run(async () => {
            await this.db.clear();
            await this.refresh();
        });
    }
}

export const store = new Store();

export function useData(): Data {
    const [data, setData] = useState(store.data);
    useEffect(() => store.subscribe(setData), []);
    return data;
}

export function blankItem(bagId: string | null, batchId: string | null = null): Item {
    const now = Date.now();
    return { id: crypto.randomUUID(), seq: 0, bagId, batchId, type: "", value: "", name: "", mpn: "", vendorPn: "",
        qty: null, count: null, dateCode: "", lot: "", country: "", notes: "", source: "manual", raw: "", merged: [],
        flags: [], hasPhoto: false, importKey: "", created: now, updated: now };
}
