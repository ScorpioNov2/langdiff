import { useEffect, useRef } from "react";
import { initLangdiff } from "./langdiff";

function App() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rootRef.current) {
      initLangdiff(rootRef.current);
    }
  }, []);

  return <div id="ld-root" className="ld-root" ref={rootRef} />;
}

export default App;
