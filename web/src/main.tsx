import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { TapePicker } from "./components/Tapes";
import { currentTape } from "./hooks";
import "./styles.css";

/** `?tape=<name>` selects the tape; without it the page lists the tapes to pick from. */
function Root() {
  const [tape, setTape] = useState(currentTape);
  useEffect(() => {
    const onPop = () => setTape(currentTape());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (!tape) document.title = "Walkman · Bub tapes";
  }, [tape]);
  const navigate = (name: string | null) => {
    // A new tape starts live; the replay position belongs to the previous one.
    history.pushState(null, "", name ? `?${new URLSearchParams({ tape: name })}` : location.pathname);
    setTape(name ?? "");
  };
  return tape ? <App key={tape} name={tape} onNavigate={navigate} /> : <TapePicker onPick={navigate} />;
}

createRoot(document.getElementById("root")!).render(<Root />);
