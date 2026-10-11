const REDACTED = "[redacted]";

/** Removes configured secrets (RPC URLs with API keys, upstream keys) from text we log or store. */
export function createRedactor(secrets: (string | undefined | null)[]) {
  const needles = secrets
    .filter((secret): secret is string => typeof secret === "string" && secret.length >= 8)
    .flatMap((secret) => {
      // Fetch errors often print the URL without the query string, or just the query.
      const parts = [secret];
      try {
        const url = new URL(secret);
        if (url.search) parts.push(url.search.slice(1), `${url.origin}${url.pathname}`);
        if (url.pathname.length > 1) parts.push(url.pathname);
      } catch {
        // Not a URL; redact verbatim only.
      }
      return parts;
    })
    .sort((a, b) => b.length - a.length);
  return (text: string): string => needles.reduce((out, needle) => out.split(needle).join(REDACTED), text);
}

export type Redactor = ReturnType<typeof createRedactor>;
