import { render } from "preact";

import App from "./App";

const appRoot = document.getElementById("app");

if (!appRoot) {
  throw new Error("App root element was not found.");
}

render(<App />, appRoot);
