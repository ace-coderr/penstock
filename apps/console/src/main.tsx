import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./tokens.css";
import "./base.css";
import "./styles.css";
import "./landing.css";
import "./motion.css";
import { Console } from "./Console";
import { Landing } from "./Landing";

/** "/" is the landing page; "/app" (and anything under it) is the seller console. */
const isConsole = /^\/app(\/|$)/.test(location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isConsole ? <Console /> : <Landing />}</StrictMode>,
);
