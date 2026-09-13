/*
  Turns a failed fetch Response into a message that makes sense to a plugin
  author. Handles platform errors (gateway timeouts, payload limits) that have
  no JSON body, and falls back to the API's `error` field when present.
*/
export async function responseError(
  res: Response,
  fallback: string,
): Promise<string> {
  if (res.status === 502 || res.status === 504) {
    return "the server timed out (504) — retry in a moment, then reload if your change isn't there.";
  }
  if (res.status === 413) {
    return "the request was too large (413).";
  }
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}
