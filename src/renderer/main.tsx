import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./fonts.css";
import "./styles.css";

document.body.classList.add("app-shell");

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
