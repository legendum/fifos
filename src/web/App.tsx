import { useCallback, useEffect, useRef, useState } from "react";
import FifoDetail from "./components/FifoDetail";
import Fifos from "./components/Fifos";
import Login from "./components/Login";
import TopBar from "./components/TopBar";
import { setUnauthorizedHandler } from "./fetchWithAuth";
import { type FifoDetailJson, fifoFromDetailJson } from "./fifoFromJson";
import { reconcileTheme } from "./theme";
import type { FifoEntry } from "./types";

type User = {
  legendum_linked: boolean;
  hosted: boolean;
  meta?: { theme?: unknown };
};

/** Extract slug from the URL path. Returns null at root or for reserved prefixes. */
function getSlugFromPath(): string | null {
  const path = window.location.pathname;
  if (path === "/" || path === "") return null;
  const slug = path.slice(1);
  if (
    slug.startsWith("f/") ||
    slug.startsWith("w/") ||
    slug.startsWith("auth/") ||
    slug.startsWith("dist/")
  )
    return null;
  return slug || null;
}

/** Resolve a slug to a FifoEntry via `GET /:slug.json`. */
async function resolveSlug(slug: string): Promise<FifoEntry | null> {
  try {
    const r = await fetch(`/${slug}.json`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (r.ok) {
      const data = (await r.json()) as FifoDetailJson;
      if (data?.slug) return fifoFromDetailJson(data);
    }
  } catch {
    /* offline or 404 */
  }
  return null;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFifo, setSelectedFifo] = useState<FifoEntry | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);
  const isSelfHosted = user ? !user.hosted : false;

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch("/f/settings/me", { credentials: "include" });
      if (!res.ok) {
        setUser(null);
        return;
      }
      const data = (await res.json()) as User;
      reconcileTheme(data.meta?.theme);
      setUser(data);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  useEffect(() => {
    fetchUser().finally(() => setLoading(false));
  }, [fetchUser]);

  // On initial load, if URL has a slug, resolve and route to detail.
  useEffect(() => {
    if (!user || loading) return;
    const slug = getSlugFromPath();
    if (!slug) return;
    let cancelled = false;
    void resolveSlug(slug).then((entry) => {
      if (!cancelled && entry) setSelectedFifo(entry);
    });
    return () => {
      cancelled = true;
    };
  }, [user, loading]);

  // Browser back/forward.
  useEffect(() => {
    const onPopState = () => {
      const slug = getSlugFromPath();
      if (!slug) {
        setSelectedFifo(null);
        return;
      }
      void resolveSlug(slug).then((entry) => setSelectedFifo(entry));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectFifo = (entry: FifoEntry) => {
    setSelectedFifo(entry);
    window.history.pushState(null, "", `/${entry.slug}`);
  };

  const goBack = () => {
    setSelectedFifo(null);
    window.history.pushState(null, "", "/");
  };

  if (loading) {
    return <div className="screen-loading">Loading...</div>;
  }

  if (!user) return <Login />;

  return (
    <>
      <TopBar
        isSelfHosted={isSelfHosted}
        filterQuery={filterQuery}
        setFilterQuery={setFilterQuery}
        filterInputRef={filterInputRef}
      />
      <div className={selectedFifo ? "app-root-panel--hidden" : undefined}>
        <Fifos
          onSelect={selectFifo}
          filterQuery={filterQuery}
          filterInputRef={filterInputRef}
          visible={selectedFifo === null}
        />
      </div>
      {selectedFifo ? (
        <FifoDetail
          key={selectedFifo.slug}
          fifo={selectedFifo}
          onBack={goBack}
          filterQuery={filterQuery}
          onRenamed={({ name, slug }) => {
            setSelectedFifo((prev) => (prev ? { ...prev, name, slug } : null));
            window.history.replaceState(null, "", `/${slug}`);
          }}
        />
      ) : null}
    </>
  );
}
