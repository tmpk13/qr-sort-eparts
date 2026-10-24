// Switching tabs from inside a view, with something to bring into view on arrival.
export const TABS = [
    ["inventory", "Inventory"],
    ["find", "Find"],
    ["browse", "Browse"],
    ["settings", "Settings"],
] as const;
export type Tab = (typeof TABS)[number][0];

export interface Focus {
    itemId?: string;
}

const listeners = new Set<(tab: Tab) => void>();
let pending: Focus | null = null;

export function goTo(tab: Tab, focus: Focus | null = null): void {
    pending = focus;
    listeners.forEach((l) => l(tab));
}

/** What the arriving view should show, once. */
export function takeFocus(): Focus | null {
    const f = pending;
    pending = null;
    return f;
}

export function onNavigate(fn: (tab: Tab) => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}
