import { render } from "preact";
import { App } from "./app.tsx";
import { store } from "./store.ts";

const root = document.getElementById("app")!;
store.init().then(
    () => render(<App />, root),
    (err) => {
        root.textContent = `Could not open the database: ${err}`;
    },
);
