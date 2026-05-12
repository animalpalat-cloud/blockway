// src/lib/proxy/clientProxy.ts
export async function proxyFetch<T = any>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const proxyUrl = `/proxy?url=${encodeURIComponent(url)}`;

  const res = await fetch(proxyUrl, {
    ...options,
    headers: {
      ...options.headers,
      // Let the server strip Origin/Referer
    },
  });

  if (!res.ok) {
    let errorData;
    try {
      errorData = await res.json();
    } catch {
      errorData = { error: await res.text() || res.statusText };
    }
    throw new Error(errorData.error || `Proxy error: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text() as Promise<T>;
}

// Example usage for Google
export async function googleBatchexecute(payload: any) {
  return proxyFetch("https://accounts.google.com/_/signin/sl/gsi", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(payload),
  });
}