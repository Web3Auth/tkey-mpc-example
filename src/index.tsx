import "./index.css";

import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { register } from "./serviceWorkerRegistration";

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://cra.link/PWA
register();
