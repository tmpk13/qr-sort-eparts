// In-memory copy of the database that the views render from; every mutation writes through and
// notifies the subscribed components.
import { useEffect, useState } from "preact/hooks";
import { Db, type Backup } from "./db.ts";
import type { Bag, Box, Data, Item, Shelf } from "./model.ts";

type Listener = (d: Data) => void;

export class Store {
    data: Data = { shelves: [], boxes: [], bags: [], items: [] };
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
        return this.data.bags.filter((b) => b.boxId === boxId).sort((a, b) => a.created - b.created);
    }

    itemsIn(bagId: string | null): Item[] {
        return this.data.items.filter((i) => i.bagId === bagId).sort((a, b) => a.created - b.created);
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

    saveItem(item: Item, photo?: Blob | null): Promise<void> {
        return this.run(async () => {
            await this.db.putItem({ ...item, hasPhoto: item.hasPhoto || !!photo, updated: Date.now() }, photo);
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

export function blankItem(bagId: string | null): Item {
    const now = Date.now();
    return { id: crypto.randomUUID(), bagId, type: "", name: "", mpn: "", vendorPn: "", qty: null,
        dateCode: "", lot: "", country: "", notes: "", source: "manual", raw: "", hasPhoto: false,
        created: now, updated: now };
}
