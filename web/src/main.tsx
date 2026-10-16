import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App.js";
import { Present } from "./Present.js";

// ?view=present なら発表モード、それ以外は作業画面（?view=diagram の図だけの表示も App が出す）
const present = new URLSearchParams(location.search).get("view") === "present";

createRoot(document.getElementById("root")!).render(<StrictMode>{present ? <Present /> : <App />}</StrictMode>);
