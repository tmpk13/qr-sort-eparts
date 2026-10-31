// In-memory copy of the database that the views render from; every mutation writes through and
// notifies the subscribed components.
import { useEffect, useState } from "preact/hooks";
import { Db, type Backup } from "./db.ts";
import { emptyData, findTwin, hasIdentity, isRescan, isUnidentified, mergeInto, normalizeItem, randomCode,
    unidentifiedKind, type Bag, type Batch, type Box, type Data, type Item, type Shelf, type Unidentified }
    from "./model.ts";

type Listener = (d: Data) => void;

/** What became of a saved record: stored as it is, or merged into an earlier record of the same part. */
export interface SaveResult {
    item: Item; // the record that now holds the part
    into: Item | null; // the earlier record it was merged into, if any
    rescan: boolean; // the same label had been counted already; nothing was added
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

    /** Identified items in a bag; with null, the ones in no bag and no batch. */
    itemsIn(bagId: string | null): Item[] {
        return this.data.items
            .filter((i) => i.bagId === bagId && !isUnidentified(i) && (bagId !== null || !i.batchId))
            .sort((a, b) => a.created - b.created || a.seq - b.seq);
    }

    itemsInBatch(batchId: string): Item[] {
        return this.data.items.filter((i) => i.batchId === batchId).sort((a, b) => a.created - b.created || a.seq - b.seq);
    }

    /** Records waiting to be identified, newest first: all of them, or those of one kind. */
    unidentified(kind?: Unidentified): Item[] {
        return this.data.items.filter((i) => (kind ? unidentifiedKind(i) === kind : isUnidentified(i)))
            .sort((a, b) => b.created - a.created);
    }

    /** Records waiting to be identified that have been put in one of these bags. */
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
     * Stores the item, or merges it into the record of the same part number already in that box
     * (bag, batch), so each box holds one record per part with the quantities summed.
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
        if (isUnidentified(next) && hasIdentity(next)) {
            // Identified by hand: from here on it files like any other item, merging where its part already is.
            next.source = "manual";
        }
        const now = Date.now();
        const twin = findTwin(next, this.data);
        if (!twin) {
            if (!next.seq) {
                next.seq = await this.db.nextNumber("item");
            }
            const stored = { ...next, hasPhoto: next.hasPhoto || !!photo, updated: now };
            await this.db.putItem(stored, photo);
            return { item: stored, into: null, rescan: false };
        }
        const rescan = isRescan(twin, next);
        const merged = mergeInto(twin, next);
        // The earlier record keeps its photo; one without gets the newcomer's.
        let shot: Blob | null | undefined;
        if (!twin.hasPhoto) {
            shot = photo ?? (next.hasPhoto && this.item(next.id) ? await this.db.getPhoto(next.id) : undefined);
        }
        const stored = { ...merged, hasPhoto: twin.hasPhoto || !!shot, updated: rescan ? twin.updated : now };
        await this.db.putItem(stored, shot);
        if (this.item(next.id)) {
            await this.db.deleteItem(next.id);
        }
        return { item: stored, into: twin, rescan };
    }

    /**
     * Puts items in a bag (null: out of any bag), merging where the part is already there. Records
     * waiting to be identified go along and keep waiting.
     */
    moveItems(ids: string[], bagId: string | null): Promise<SaveResult[]> {
        return this.run(async () => {
            const out: SaveResult[] = [];
            for (const id of ids) {
                const item = this.item(id);
                if (item) {
                    out.push(await this.put({ ...item, bagId }));
                    await this.refresh();
                }
            }
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

    /** Merges records of the same part that share a box (bag, batch) into the oldest of them. */
    mergeDuplicates(): Promise<number> {
        return this.run(async () => {
            let merged = 0;
            // Newest first: findTwin answers with the oldest record, so each one folds into that.
            for (const item of [...this.data.items].sort((a, b) => b.created - a.created)) {
                const current = this.item(item.id);
                if (current && findTwin(current, this.data)) {
                    await this.put(current);
                    await this.refresh();
                    merged += 1;
                }
            }
            return merged;
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
        const ids = this.itemsInBatch(batchId).filter((i) => !i.bagId && !isUnidentified(i)).map((i) => i.id);
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
    return { id: crypto.randomUUID(), seq: 0, bagId, batchId, type: "", name: "", mpn: "", vendorPn: "", qty: null,
        count: null, dateCode: "", lot: "", country: "", notes: "", source: "manual", raw: "", merged: [],
        hasPhoto: false, created: now, updated: now };
}
