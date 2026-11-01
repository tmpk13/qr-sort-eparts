// Browse: the shelf, box and bag tree with editing, placement, labels and item details; an edit
// mode to select many things at once and move them; batches, unidentified codes and photos.
import { useEffect, useRef, useState } from "preact/hooks";
import { toCsv } from "../csv.ts";
import { readMarkerCount } from "../marker.ts";
import { batchTitle, display, isUnidentified, itemName, itemTag, printable, sortItems, title, unidentifiedKind,
    type Bag, type Batch, type Box, type Data, type Item, type ItemOrder, type Kind, type Shelf } from "../model.ts";
import { takeFocus } from "../nav.ts";
import { editRows, selectRows, type Row, type RowKind } from "../selection.ts";
import { downloadBlob } from "../printer.ts";
import { settings, useSettings } from "../settings.ts";
import { store, useData } from "../store.ts";
import { Field, ItemForm, ItemTitle, LabelDialog, Modal, QtyBadge, Thumb, toast, usePhotoUrl, val, waitingClass }
    from "../ui.tsx";
import { ItemList } from "./find.tsx";

interface Actions {
    edit: (kind: Kind, id: string) => void;
    label: (id: string, name: string) => void;
    item: (id: string) => void;
    focus: string | null; // an item to show: its shelf, box and bag start open
    order: ItemOrder; // how item lists are sorted
}

export function exportCsv(data: Data): void {
    const day = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([toCsv(data)], { type: "text/csv" }), `qr-sort-${day}.csv`);
}

export function BrowseView() {
    const data = useData();
    const [s, setS] = useSettings();
    const [arrival] = useState(() => takeFocus());
    const [edit, setEdit] = useState<{ kind: Kind; id: string } | null>(null);
    const [label, setLabel] = useState<{ id: string; name: string } | null>(null);
    const [itemId, setItemId] = useState<string | null>(arrival?.itemId ?? null);
    const [editMode, setEditMode] = useState(false);
    const actions: Actions = {
        edit: (kind, id) => setEdit({ kind, id }),
        label: (id, name) => setLabel({ id, name }),
        item: (id) => setItemId(id),
        focus: arrival?.itemId ?? null,
        order: s.sortItems,
    };
    const looseBoxes = store.boxesOn(null);
    const looseBags = store.bagsIn(null);
    const looseItems = sortItems(store.itemsIn(null), s.sortItems);
    const codes = store.unidentified("code");
    const photos = store.unidentified("photo");
    const focused = store.item(actions.focus);

    useEffect(() => {
        document.querySelector(".tree li.focused")?.scrollIntoView({ block: "center" });
    }, []);

    return (
        <div class="stack">
            <div class="row">
                <button class="btn" onClick={() => store.createShelf().then((s) => actions.edit("shelf", s.id))}>New shelf</button>
                <button class="btn" onClick={() => store.createBox().then((b) => actions.edit("box", b.id))}>New box</button>
                <button class="btn" onClick={() => store.createBag().then((b) => actions.edit("bag", b.id))}>New bag</button>
                <button class={`btn${editMode ? " primary" : ""}`} aria-pressed={editMode}
                    onClick={() => setEditMode((on) => !on)}>
                    {editMode ? "Done editing" : "Edit mode"}
                </button>
                <button class="btn" onClick={() => exportCsv(data)}>Export CSV</button>
                <select style="width:auto" value={s.sortItems} aria-label="Sort items"
                    onChange={(e) => setS({ sortItems: val(e) as ItemOrder })}>
                    <option value="scanned">Sort: as scanned</option>
                    <option value="type">Sort: by type, then value</option>
                </select>
            </div>
            {editMode ? <EditMode data={data} order={s.sortItems} onOpen={actions.item} /> : (
                <div class="panel tree">
                    {data.shelves.map((shelf) => <ShelfNode key={shelf.id} shelf={shelf} a={actions} />)}
                    {!data.shelves.length && <p class="muted">No shelves yet. Make a shelf, put boxes on it, bags in the boxes.</p>}
                    {(looseBoxes.length > 0 || looseBags.length > 0 || looseItems.length > 0) && (
                        <details open>
                            <summary>Not placed <span class="muted">{looseBoxes.length} boxes, {looseBags.length} bags, {looseItems.length} items</span></summary>
                            {looseBoxes.map((box) => <BoxNode key={box.id} box={box} a={actions} />)}
                            {looseBags.map((bag) => <BagNode key={bag.id} bag={bag} a={actions} />)}
                            {looseItems.length > 0 && <LooseItems items={looseItems} a={actions}
                                open={!!focused && !focused.bagId && !focused.batchId} />}
                        </details>
                    )}
                    {data.batches.length > 0 && (
                        <details open>
                            <summary>Batches <span class="muted">{data.batches.length}</span></summary>
                            {[...data.batches].sort((a, b) => b.created - a.created).map((b) => (
                                <BatchNode key={b.id} batch={b} a={actions} />
                            ))}
                        </details>
                    )}
                    {codes.length > 0 && (
                        <details open class="unknown">
                            <summary>Unidentified codes <span class="muted">{codes.length}</span></summary>
                            <p class="hint">Codes with no part number in them, filed where they were scanned. A part
                                number or a name identifies one; moving it does not.</p>
                            <Items items={codes} a={actions} showPlace />
                        </details>
                    )}
                    {photos.length > 0 && (
                        <details open class="nocode">
                            <summary>Unidentified photos <span class="muted">{photos.length}</span></summary>
                            <p class="hint">Bags with no code that would read, added with a photo and filed where they
                                were added. A part number or a name identifies one; moving it does not.</p>
                            <Items items={photos} a={actions} showPlace />
                        </details>
                    )}
                </div>
            )}
            {edit && <EditDialog kind={edit.kind} id={edit.id} onClose={() => setEdit(null)} />}
            {label && <LabelDialog id={label.id} name={label.name} onClose={() => setLabel(null)} />}
            {itemId && <ItemDialog id={itemId} onClose={() => setItemId(null)} />}
        </div>
    );
}

/** Whether the focused item sits in this bag (or in a bag of this box, or on this shelf). */
function holds(a: Actions, where: { bagId?: string; boxId?: string; shelfId?: string }): boolean {
    const item = store.item(a.focus);
    const bag = store.bag(item?.bagId);
    const box = store.box(bag?.boxId);
    return !!item && ((where.bagId != null && bag?.id === where.bagId) || (where.boxId != null && box?.id === where.boxId)
        || (where.shelfId != null && box?.shelfId === where.shelfId));
}

function ShelfNode(p: { shelf: Shelf; a: Actions }) {
    const boxes = store.boxesOn(p.shelf.id);
    return (
        <details open>
            <summary>{display(p.shelf)} <span class="muted">{boxes.length} boxes</span></summary>
            <div class="row actions">
                <button class="btn small" onClick={() => p.a.edit("shelf", p.shelf.id)}>Rename</button>
                <button class="btn small" onClick={() => store.createBox("", p.shelf.id).then((b) => p.a.edit("box", b.id))}>Add box</button>
                <button class="btn small danger" onClick={() => confirm(`Delete ${display(p.shelf)}? Its boxes stay, unplaced.`)
                    && store.deleteShelf(p.shelf.id)}>Delete</button>
            </div>
            {boxes.map((box) => <BoxNode key={box.id} box={box} a={p.a} />)}
        </details>
    );
}

/** ", 2 unidentified" for the unidentified ones among these items, else "". */
function unidentifiedNote(items: Item[]): string {
    const n = items.filter(isUnidentified).length;
    return n ? `, ${n} unidentified` : "";
}

function BoxNode(p: { box: Box; a: Actions }) {
    const bags = store.bagsIn(p.box.id);
    const items = bags.flatMap((b) => store.itemsIn(b.id));
    const pieces = items.reduce((n, i) => n + (i.count ?? 0), 0);
    return (
        <details open={holds(p.a, { boxId: p.box.id })}>
            <summary>
                {p.box.position != null && <span class="badge">#{p.box.position}</span>} {display(p.box)}{" "}
                <span class="muted">
                    {bags.length} bags, {items.length} parts, {pieces} pieces{unidentifiedNote(items)}
                </span>
            </summary>
            <div class="row actions">
                <button class="btn small" onClick={() => p.a.edit("box", p.box.id)}>Edit</button>
                <button class="btn small" onClick={() => p.a.label(p.box.id, p.box.name)}>Label</button>
                <button class="btn small" onClick={() => store.createBag("", p.box.id).then((b) => p.a.edit("bag", b.id))}>Add bag</button>
                <button class="btn small danger" onClick={() => confirm(`Delete ${display(p.box)}? Its bags stay, unplaced.`)
                    && store.deleteBox(p.box.id)}>Delete</button>
            </div>
            {bags.map((bag) => <BagNode key={bag.id} bag={bag} a={p.a} />)}
            {items.length > 0 && <BoxParts boxId={p.box.id} items={items} a={p.a} />}
        </details>
    );
}

/** Every part in a box as one list, with its bag; drawn only while open, so photos load on demand. */
function BoxParts(p: { boxId: string; items: Item[]; a: Actions }) {
    const [open, setOpen] = useState(false);
    return (
        <details class="box-parts" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>All parts in {title(p.boxId)} <span class="muted">{p.items.length}</span></summary>
            {open && <Items items={sortItems(p.items, p.a.order)} a={p.a} showPlace />}
        </details>
    );
}

function BagNode(p: { bag: Bag; a: Actions }) {
    const items = store.itemsIn(p.bag.id);
    return (
        <details open={holds(p.a, { bagId: p.bag.id })}>
            <summary>{display(p.bag)} <span class="muted">{items.length} items{unidentifiedNote(items)}</span></summary>
            <div class="row actions">
                <button class="btn small" onClick={() => p.a.edit("bag", p.bag.id)}>Edit</button>
                <button class="btn small" onClick={() => p.a.label(p.bag.id, p.bag.name)}>Label</button>
                <button class="btn small danger" onClick={() => confirm(`Delete ${display(p.bag)} and its ${items.length} items?`)
                    && store.deleteBag(p.bag.id)}>Delete</button>
            </div>
            <ItemList bagId={p.bag.id} onPick={p.a.item} focus={p.a.focus} />
        </details>
    );
}

function BatchNode(p: { batch: Batch; a: Actions }) {
    const data = useData();
    const items = store.itemsInBatch(p.batch.id);
    const waiting = items.filter((i) => !i.bagId);
    const [bagId, setBagId] = useState("");
    const put = async () => {
        const r = await store.putBatchInBag(p.batch.id, bagId);
        toast(`Put ${r.length} items into ${display(store.bag(bagId))}`, "ok");
    };
    return (
        <details open={!!store.item(p.a.focus) && store.item(p.a.focus)?.batchId === p.batch.id}>
            <summary>{batchTitle(p.batch)} <span class="muted">{items.length} items, {waiting.length} not in a bag</span></summary>
            <div class="row actions">
                <select value={bagId} onChange={(e) => setBagId(val(e))} aria-label="Bag for the batch">
                    <option value="">(pick a bag)</option>
                    {data.bags.map((b) => <option value={b.id}>{display(b)}</option>)}
                </select>
                <button class="btn small" disabled={!bagId || !waiting.length} onClick={put}>Put in bag</button>
                <button class="btn small danger" onClick={() => confirm(`Clear ${batchTitle(p.batch)}? Its items stay.`)
                    && store.clearBatch(p.batch.id)}>Clear batch</button>
            </div>
            <Items items={sortItems(items, p.a.order)} a={p.a} showPlace />
        </details>
    );
}

function Items(p: { items: Item[]; a: Actions; showPlace?: boolean }) {
    return (
        <ul class="list">
            {p.items.map((item) => (
                <li key={item.id} class={`clickable${p.a.focus === item.id ? " focused" : ""} ${waitingClass(item)}`}
                    onClick={() => p.a.item(item.id)}>
                    <Thumb item={item} />
                    <div class="grow">
                        <ItemTitle item={item} />
                        {p.showPlace && (
                            <div class="small muted">
                                {display(store.bag(item.bagId)) || (item.batchId ? title(item.batchId) : "not in a bag")}
                            </div>
                        )}
                    </div>
                    <QtyBadge item={item} />
                </li>
            ))}
        </ul>
    );
}

function LooseItems(p: { items: Item[]; a: Actions; open: boolean }) {
    return (
        <details open={p.open}>
            <summary>Items in no bag <span class="muted">{p.items.length}</span></summary>
            <Items items={p.items} a={p.a} />
        </details>
    );
}

// ---- edit mode ----
function EditMode(p: { data: Data; order: ItemOrder; onOpen: (id: string) => void }) {
    const rows = editRows(p.data, p.order);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const anchor = useRef<string | null>(null);
    const [bagTo, setBagTo] = useState("");
    const [boxTo, setBoxTo] = useState("");
    const [shelfTo, setShelfTo] = useState("");
    const present = new Set(rows.map((r) => r.id));
    const picked = (kind: RowKind) => rows.filter((r) => r.kind === kind && selected.has(r.id) && present.has(r.id)).map((r) => r.id);
    const items = picked("item");
    const bags = picked("bag");
    const boxes = picked("box");

    const click = (row: Row, e: MouseEvent) => {
        if (row.kind === "head") {
            return;
        }
        e.preventDefault();
        setSelected(selectRows(rows, selected, anchor.current, row, e.shiftKey));
        anchor.current = row.id;
    };
    const done = (text: string) => {
        setSelected(new Set());
        anchor.current = null;
        toast(text, "ok");
    };
    const moveItems = async () => {
        await store.moveItems(items, bagTo || null);
        done(`Moved ${items.length} items to ${display(store.bag(bagTo)) || "no bag"}`);
    };
    const moveBags = async () => {
        await store.moveBags(bags, boxTo || null);
        done(`Moved ${bags.length} bags to ${display(store.box(boxTo)) || "no box"}`);
    };
    const moveBoxes = async () => {
        await store.moveBoxes(boxes, shelfTo || null);
        done(`Moved ${boxes.length} boxes to ${display(store.shelf(shelfTo)) || "no shelf"}`);
    };

    return (
        <div class="stack">
            <p class="hint">Click to select, shift-click to select a run of the same kind. Items move to a bag,
                bags (with their items) to a box, boxes to the end of a shelf. Unidentified items stay flagged
                wherever they go, until they get a part number or a name.</p>
            <ul class="panel list edit-list">
                {rows.map((row) => row.kind === "head" ? (
                    <li key={`h-${row.id}`} class="head">{row.label}</li>
                ) : (
                    <li key={row.id} class={`clickable ${row.kind}${selected.has(row.id) ? " selected" : ""}${
                        row.item ? ` ${waitingClass(row.item)}` : ""}`}
                        style={`padding-left: ${row.depth * 1.25 + 0.5}rem`} onClick={(e) => click(row, e)}>
                        <input type="checkbox" checked={selected.has(row.id)} tabIndex={-1} aria-label={`Select ${row.label}`} />
                        <span class="badge">{row.kind}</span>
                        <div class="grow">{row.label}</div>
                        {row.item && <QtyBadge item={row.item} />}
                        {row.item && <button class="btn small" onClick={(e) => { e.stopPropagation(); p.onOpen(row.id); }}>Open</button>}
                    </li>
                ))}
            </ul>
            {(items.length > 0 || bags.length > 0 || boxes.length > 0) && (
                <div class="panel stack selection-bar">
                    {items.length > 0 && (
                        <div class="row">
                            <span>{items.length} items to</span>
                            <select value={bagTo} onChange={(e) => setBagTo(val(e))} aria-label="Move items to bag">
                                <option value="">(no bag)</option>
                                {p.data.bags.map((b) => <option value={b.id}>{display(b)}</option>)}
                            </select>
                            <button class="btn primary" onClick={moveItems}>Move items</button>
                        </div>
                    )}
                    {bags.length > 0 && (
                        <div class="row">
                            <span>{bags.length} bags to</span>
                            <select value={boxTo} onChange={(e) => setBoxTo(val(e))} aria-label="Move bags to box">
                                <option value="">(no box)</option>
                                {p.data.boxes.map((b) => <option value={b.id}>{display(b)}</option>)}
                            </select>
                            <button class="btn primary" onClick={moveBags}>Move bags</button>
                        </div>
                    )}
                    {boxes.length > 0 && (
                        <div class="row">
                            <span>{boxes.length} boxes to</span>
                            <select value={shelfTo} onChange={(e) => setShelfTo(val(e))} aria-label="Move boxes to shelf">
                                <option value="">(no shelf)</option>
                                {p.data.shelves.map((s) => <option value={s.id}>{display(s)}</option>)}
                            </select>
                            <button class="btn primary" onClick={moveBoxes}>Move boxes</button>
                        </div>
                    )}
                    <div class="row">
                        <button class="btn" onClick={() => setSelected(new Set())}>Select none</button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ---- dialogs ----
function EditDialog(p: { kind: Kind; id: string; onClose: () => void }) {
    const data = useData();
    const thing = p.kind === "shelf" ? store.shelf(p.id) : p.kind === "box" ? store.box(p.id) : store.bag(p.id);
    const [name, setName] = useState(thing?.name ?? "");
    const box = p.kind === "box" ? (thing as Box) : null;
    const bag = p.kind === "bag" ? (thing as Bag) : null;
    const [shelfId, setShelfId] = useState(box?.shelfId ?? "");
    const [position, setPosition] = useState(box?.position ?? 1);
    const [boxId, setBoxId] = useState(bag?.boxId ?? "");
    if (!thing) {
        return null;
    }
    const slots = shelfId ? store.boxesOn(shelfId).filter((b) => b.id !== p.id).length + 1 : 0;

    const save = async () => {
        if (p.kind === "shelf") {
            await store.saveShelf({ ...(thing as Shelf), name });
        } else if (box) {
            await store.saveBox({ ...box, name });
            if ((shelfId || null) !== box.shelfId || (shelfId && position !== box.position)) {
                await store.moveBox(box.id, shelfId || null, shelfId ? position : null);
            }
        } else if (bag) {
            await store.saveBag({ ...bag, name, boxId: boxId || null });
        }
        toast(`Saved ${title(p.id)}`, "ok");
        p.onClose();
    };

    return (
        <Modal title={`Edit ${title(p.id)}`} onClose={p.onClose}>
            <div class="grid">
                <Field label="Name" wide>
                    <input value={name} onInput={(e) => setName(val(e))} placeholder="What goes here" />
                </Field>
                {box && (
                    <Field label="Shelf">
                        <select value={shelfId} onChange={(e) => { setShelfId(val(e)); setPosition(slotsFor(val(e), p.id)); }}>
                            <option value="">(not on a shelf)</option>
                            {data.shelves.map((s) => <option value={s.id}>{display(s)}</option>)}
                        </select>
                    </Field>
                )}
                {box && shelfId && (
                    <Field label={`Position from the left (1 to ${slots})`}>
                        <input type="number" min="1" max={slots} value={position}
                            onInput={(e) => setPosition(Math.min(Math.max(Number(val(e)) || 1, 1), slots))} />
                    </Field>
                )}
                {bag && (
                    <Field label="Box">
                        <select value={boxId} onChange={(e) => setBoxId(val(e))}>
                            <option value="">(not in a box)</option>
                            {data.boxes.map((b) => <option value={b.id}>{display(b)}{b.shelfId ? ` on ${display(store.shelf(b.shelfId))}` : ""}</option>)}
                        </select>
                    </Field>
                )}
            </div>
            <div class="row">
                <button class="btn primary" onClick={save}>Save</button>
                <button class="btn" onClick={p.onClose}>Cancel</button>
            </div>
        </Modal>
    );
}

function slotsFor(shelfId: string, boxId: string): number {
    return shelfId ? store.boxesOn(shelfId).filter((b) => b.id !== boxId).length + 1 : 1;
}

function ItemDialog(p: { id: string; onClose: () => void }) {
    const data = useData();
    const [s] = useSettings();
    const stored = store.item(p.id);
    const [item, setItem] = useState<Item | null>(stored ?? null);
    const [reading, setReading] = useState(false);
    const photo = usePhotoUrl(p.id, !!stored?.hasPhoto);
    if (!item) {
        return null;
    }
    const save = async () => {
        // A part number or a name identifies an unidentified record; the store clears its flag then.
        const r = await store.saveItem(item);
        toast(`Saved ${itemTag(r.item)} ${itemName(r.item)}`, "ok");
        p.onClose();
    };
    const readCount = async () => {
        const blob = await store.db.getPhoto(item.id);
        const marker = settings.value.marker;
        if (!blob || !marker) {
            return;
        }
        setReading(true);
        try {
            const read = await readMarkerCount(blob, marker);
            if (read) {
                setItem((i) => i && { ...i, count: read.count });
                toast(`Read ${read.count} at ${Math.round(read.confidence)}% confidence: check it, then save`);
            } else {
                toast("No number in the marker's color in this photo");
            }
        } catch (err) {
            toast(`Reading the marker failed: ${(err as Error).message}`, "err");
        } finally {
            setReading(false);
        }
    };
    const remove = async () => {
        if (confirm(`Delete ${itemName(item)}?`)) {
            await store.deleteItem(item.id);
            p.onClose();
        }
    };
    const batch = store.batch(item.batchId);
    return (
        <Modal title={`${itemTag(item)} ${itemName(item)}`} onClose={p.onClose}>
            {isUnidentified(item) && (
                <p class={`hint ${waitingClass(item)}`}>
                    {unidentifiedKind(item) === "photo" ? "Photo of a bag with no code" : "Unidentified code"}: a part
                    number or a name identifies it. Until then it stays flagged, wherever it is moved.
                </p>
            )}
            <ItemForm item={item} onChange={setItem} bags={data.bags} />
            {photo && <img class="photo" src={photo} alt="" />}
            {batch && <p class="hint">Scanned in {batchTitle(batch)}</p>}
            {item.merged.length > 0 && <p class="hint">{item.merged.length + 1} bags were summed into this record.</p>}
            {item.raw && <p class="hint mono" style="word-break:break-all">{item.source}: {printable(item.raw)}</p>}
            <div class="row">
                <button class="btn primary" onClick={save}>Save</button>
                <button class="btn" onClick={p.onClose}>Cancel</button>
                {s.marker && stored?.hasPhoto && (
                    <button class="btn" disabled={reading} onClick={readCount}>
                        {reading ? "Reading..." : "Read count from photo"}
                    </button>
                )}
                <button class="btn danger" onClick={remove}>Delete</button>
            </div>
        </Modal>
    );
}
