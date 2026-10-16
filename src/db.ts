// IndexedDB persistence: one object store per record kind, photos keyed by item id, id counters.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { makeId, type Bag, type Box, type Data, type Item, type Kind, type Shelf } from "./model.ts";

interface Schema extends DBSchema {
    shelves: { key: string; value: Shelf };
    boxes: { key: string; value: Box; indexes: { shelfId: string } };
    bags: { key: string; value: Bag; indexes: { boxId: string } };
    items: { key: string; value: Item; indexes: { bagId: string } };
    photos: { key: string; value: Blob };
    counters: { key: string; value: number };
}

export interface Backup {
    app: "qr-sort";
    version: 1;
    exported: number;
    shelves: Shelf[];
    boxes: Box[];
    bags: Bag[];
    items: Item[];
    counters: Record<string, number>;
}

export class Db {
    private constructor(private db: IDBPDatabase<Schema>) {}

    static async open(name = "qr-sort"): Promise<Db> {
        const db = await openDB<Schema>(name, 1, {
            upgrade(db) {
                db.createObjectStore("shelves", { keyPath: "id" });
                db.createObjectStore("boxes", { keyPath: "id" }).createIndex("shelfId", "shelfId");
                db.createObjectStore("bags", { keyPath: "id" }).createIndex("boxId", "boxId");
                db.createObjectStore("items", { keyPath: "id" }).createIndex("bagId", "bagId");
                db.createObjectStore("photos");
                db.createObjectStore("counters");
            },
        });
        return new Db(db);
    }

    async all(): Promise<Data> {
        const [shelves, boxes, bags, items] = await Promise.all([
            this.db.getAll("shelves"), this.db.getAll("boxes"), this.db.getAll("bags"), this.db.getAll("items"),
        ]);
        return { shelves, boxes, bags, items };
    }

    async nextId(kind: Kind): Promise<string> {
        const tx = this.db.transaction("counters", "readwrite");
        const n = ((await tx.store.get(kind)) ?? 0) + 1;
        await tx.store.put(n, kind);
        await tx.done;
        return makeId(kind, n);
    }

    async putShelf(s: Shelf): Promise<void> {
        await this.db.put("shelves", s);
    }

    async putBoxes(boxes: Box[]): Promise<void> {
        const tx = this.db.transaction("boxes", "readwrite");
        await Promise.all([...boxes.map((b) => tx.store.put(b)), tx.done]);
    }

    async putBag(b: Bag): Promise<void> {
        await this.db.put("bags", b);
    }

    async putItem(item: Item, photo?: Blob | null): Promise<void> {
        const tx = this.db.transaction(["items", "photos"], "readwrite");
        const ops: Promise<unknown>[] = [tx.objectStore("items").put(item)];
        if (photo) {
            ops.push(tx.objectStore("photos").put(photo, item.id));
        } else if (!item.hasPhoto) {
            ops.push(tx.objectStore("photos").delete(item.id));
        }
        await Promise.all([...ops, tx.done]);
    }

    getPhoto(itemId: string): Promise<Blob | undefined> {
        return this.db.get("photos", itemId);
    }

    async deleteItem(id: string): Promise<void> {
        const tx = this.db.transaction(["items", "photos"], "readwrite");
        await Promise.all([tx.objectStore("items").delete(id), tx.objectStore("photos").delete(id), tx.done]);
    }

    /** Removes the bag with everything in it. */
    async deleteBag(id: string): Promise<void> {
        const tx = this.db.transaction(["bags", "items", "photos"], "readwrite");
        const items = await tx.objectStore("items").index("bagId").getAllKeys(id);
        await Promise.all([
            ...items.map((k) => tx.objectStore("items").delete(k)),
            ...items.map((k) => tx.objectStore("photos").delete(k)),
            tx.objectStore("bags").delete(id),
            tx.done,
        ]);
    }

    /** Removes the box; its bags stay, unplaced. */
    async deleteBox(id: string): Promise<void> {
        const tx = this.db.transaction(["boxes", "bags"], "readwrite");
        const bags = await tx.objectStore("bags").index("boxId").getAll(id);
        await Promise.all([
            ...bags.map((b) => tx.objectStore("bags").put({ ...b, boxId: null })),
            tx.objectStore("boxes").delete(id),
            tx.done,
        ]);
    }

    /** Removes the shelf; its boxes stay, unplaced. */
    async deleteShelf(id: string): Promise<void> {
        const tx = this.db.transaction(["shelves", "boxes"], "readwrite");
        const boxes = await tx.objectStore("boxes").index("shelfId").getAll(id);
        await Promise.all([
            ...boxes.map((b) => tx.objectStore("boxes").put({ ...b, shelfId: null, position: null })),
            tx.objectStore("shelves").delete(id),
            tx.done,
        ]);
    }

    async export(): Promise<Backup> {
        const data = await this.all();
        const counters: Record<string, number> = {};
        const tx = this.db.transaction("counters");
        for (const key of await tx.store.getAllKeys()) {
            counters[key] = (await tx.store.get(key)) ?? 0;
        }
        return { app: "qr-sort", version: 1, exported: Date.now(), ...data, counters };
    }

    /** Replaces every record with the backup's; photos are not part of a backup and are dropped. */
    async import(b: Backup): Promise<void> {
        if (b.app !== "qr-sort" || b.version !== 1) {
            throw new Error("not a qr-sort backup");
        }
        await this.clear();
        const tx = this.db.transaction(["shelves", "boxes", "bags", "items", "counters"], "readwrite");
        const ops: Promise<unknown>[] = [
            ...(b.shelves ?? []).map((s) => tx.objectStore("shelves").put(s)),
            ...(b.boxes ?? []).map((x) => tx.objectStore("boxes").put(x)),
            ...(b.bags ?? []).map((x) => tx.objectStore("bags").put(x)),
            ...(b.items ?? []).map((x) => tx.objectStore("items").put({ ...x, hasPhoto: false })),
            ...Object.entries(b.counters ?? {}).map(([k, v]) => tx.objectStore("counters").put(v, k)),
        ];
        await Promise.all([...ops, tx.done]);
    }

    async clear(): Promise<void> {
        const names = ["shelves", "boxes", "bags", "items", "photos", "counters"] as const;
        const tx = this.db.transaction(names, "readwrite");
        await Promise.all([...names.map((n) => tx.objectStore(n).clear()), tx.done]);
    }
}
