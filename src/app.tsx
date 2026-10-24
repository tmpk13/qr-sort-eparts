import { useEffect, useState } from "preact/hooks";
import { onNavigate, TABS, type Tab } from "./nav.ts";
import { Toasts } from "./ui.tsx";
import { BrowseView } from "./views/browse.tsx";
import { FindView } from "./views/find.tsx";
import { InventoryView } from "./views/inventory.tsx";
import { SettingsView } from "./views/settings.tsx";

const TAB_KEY = "qr-sort.tab";

export function App() {
    const [tab, setTab] = useState<Tab>(() => {
        const wanted = location.hash.slice(1) || localStorage.getItem(TAB_KEY);
        return TABS.some(([id]) => id === wanted) ? (wanted as Tab) : "inventory";
    });
    const pick = (t: Tab) => {
        setTab(t);
        localStorage.setItem(TAB_KEY, t);
        history.replaceState(null, "", `#${t}`);
    };
    useEffect(() => onNavigate(pick), []);
    return (
        <div class="app">
            <nav class="tabs">
                {TABS.map(([id, name]) => (
                    <button key={id} class={`tab${tab === id ? " active" : ""}`} onClick={() => pick(id)}>{name}</button>
                ))}
            </nav>
            <main>
                {tab === "inventory" && <InventoryView />}
                {tab === "find" && <FindView />}
                {tab === "browse" && <BrowseView />}
                {tab === "settings" && <SettingsView />}
            </main>
            <Toasts />
        </div>
    );
}
