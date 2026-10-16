// Browse: the shelf, box and bag tree with editing, placement, labels and item details.
import { useState } from "preact/hooks";
import { display, itemName, title, type Bag, type Box, type Item, type Kind, type Shelf } from "../model.ts";
import { store, useData } from "../store.ts";
import { Field, ItemForm, LabelDialog, Modal, toast, usePhotoUrl, val } from "../ui.tsx";
import { ItemList } from "./find.tsx";

interface Actions {
    edit: (kind: Kind, id: string) => void;
    label: (id: string, name: string) => void;
    item: (id: string) => void;
}

export function BrowseView() {
    const data = useData();
    const [edit, setEdit] = useState<{ kind: Kind; id: string } | null>(null);
    const [label, setLabel] = useState<{ id: string; name: string } | null>(null);
    const [itemId, setItemId] = useState<string | null>(null);
    const actions: Actions = {
        edit: (kind, id) => setEdit({ kind, id }),
        label: (id, name) => setLabel({ id, name }),
        item: (id) => setItemId(id),
    };
    const looseBoxes = store.boxesOn(null);
    const looseBags = store.bagsIn(null);
    const looseItems = store.itemsIn(null);

    return (
        <div class="stack">
            <div class="row">
                <button class="btn" onClick={() => store.createShelf().then((s) => actions.edit("shelf", s.id))}>New shelf</button>
                <button class="btn" onClick={() => store.createBox().then((b) => actions.edit("box", b.id))}>New box</button>
                <button class="btn" onClick={() => store.createBag().then((b) => actions.edit("bag", b.id))}>New bag</button>
            </div>
            <div class="panel tree">
                {data.shelves.map((shelf) => <ShelfNode key={shelf.id} shelf={shelf} a={actions} />)}
                {!data.shelves.length && <p class="muted">No shelves yet. Make a shelf, put boxes on it, bags in the boxes.</p>}
                {(looseBoxes.length > 0 || looseBags.length > 0 || looseItems.length > 0) && (
                    <details open>
                        <summary>Not placed <span class="muted">{looseBoxes.length} boxes, {looseBags.length} bags, {looseItems.length} items</span></summary>
                        {looseBoxes.map((box) => <BoxNode key={box.id} box={box} a={actions} />)}
                        {looseBags.map((bag) => <BagNode key={bag.id} bag={bag} a={actions} />)}
                        {looseItems.length > 0 && <LooseItems a={actions} />}
                    </details>
                )}
            </div>
            {edit && <EditDialog kind={edit.kind} id={edit.id} onClose={() => setEdit(null)} />}
            {label && <LabelDialog id={label.id} name={label.name} onClose={() => setLabel(null)} />}
            {itemId && <ItemDialog id={itemId} onClose={() => setItemId(null)} />}
        </div>
    );
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

function BoxNode(p: { box: Box; a: Actions }) {
    const bags = store.bagsIn(p.box.id);
    return (
        <details>
            <summary>
                {p.box.position != null && <span class="badge">#{p.box.position}</span>} {display(p.box)}{" "}
                <span class="muted">{bags.length} bags</span>
            </summary>
            <div class="row actions">
                <button class="btn small" onClick={() => p.a.edit("box", p.box.id)}>Edit</button>
                <button class="btn small" onClick={() => p.a.label(p.box.id, p.box.name)}>Label</button>
                <button class="btn small" onClick={() => store.createBag("", p.box.id).then((b) => p.a.edit("bag", b.id))}>Add bag</button>
                <button class="btn small danger" onClick={() => confirm(`Delete ${display(p.box)}? Its bags stay, unplaced.`)
                    && store.deleteBox(p.box.id)}>Delete</button>
            </div>
            {bags.map((bag) => <BagNode key={bag.id} bag={bag} a={p.a} />)}
        </details>
    );
}

function BagNode(p: { bag: Bag; a: Actions }) {
    const n = store.itemsIn(p.bag.id).length;
    return (
        <details>
            <summary>{display(p.bag)} <span class="muted">{n} items</span></summary>
            <div class="row actions">
                <button class="btn small" onClick={() => p.a.edit("bag", p.bag.id)}>Edit</button>
                <button class="btn small" onClick={() => p.a.label(p.bag.id, p.bag.name)}>Label</button>
                <button class="btn small danger" onClick={() => confirm(`Delete ${display(p.bag)} and its ${n} items?`)
                    && store.deleteBag(p.bag.id)}>Delete</button>
            </div>
            <ItemList bagId={p.bag.id} onPick={p.a.item} />
        </details>
    );
}

function LooseItems(p: { a: Actions }) {
    return (
        <details>
            <summary>Items in no bag</summary>
            <ul class="list">
                {store.itemsIn(null).map((item) => (
                    <li key={item.id} class="clickable" onClick={() => p.a.item(item.id)}>
                        <div class="grow"><div class="title">{itemName(item)}</div></div>
                        {item.qty != null && <span class="badge">x{item.qty}</span>}
                    </li>
                ))}
            </ul>
        </details>
    );
}

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
    const stored = store.item(p.id);
    const [item, setItem] = useState<Item | null>(stored ?? null);
    const photo = usePhotoUrl(p.id, !!stored?.hasPhoto);
    if (!item) {
        return null;
    }
    const save = async () => {
        await store.saveItem(item);
        toast(`Saved ${itemName(item)}`, "ok");
        p.onClose();
    };
    const remove = async () => {
        if (confirm(`Delete ${itemName(item)}?`)) {
            await store.deleteItem(item.id);
            p.onClose();
        }
    };
    return (
        <Modal title={itemName(item)} onClose={p.onClose}>
            <ItemForm item={item} onChange={setItem} bags={data.bags} />
            {photo && <img class="photo" src={photo} alt="" />}
            {item.raw && <p class="hint mono" style="word-break:break-all">{item.source}: {item.raw.replace(/[\x00-\x1f]/g, " ")}</p>}
            <div class="row">
                <button class="btn primary" onClick={save}>Save</button>
                <button class="btn" onClick={p.onClose}>Cancel</button>
                <button class="btn danger" onClick={remove}>Delete</button>
            </div>
        </Modal>
    );
}
