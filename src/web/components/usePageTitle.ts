import { useEffect } from "react";

/**
 * Set `document.title` while mounted; restore the default on unmount.
 * Pass the full computed title; this hook does no formatting.
 */
export function usePageTitle(title: string, defaultTitle = "Fifos"): void {
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = defaultTitle;
    };
  }, [title, defaultTitle]);
}
