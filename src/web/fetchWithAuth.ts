let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

if (typeof window !== "undefined") {
  const originalFetch = window.fetch;
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await originalFetch(input, init);
    let url = "";
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.pathname;
    else if (input instanceof Request) url = input.url;

    if (
      response.status === 401 &&
      onUnauthorized &&
      url &&
      !url.startsWith("/auth/")
    ) {
      onUnauthorized();
    }
    return response;
  };
}
