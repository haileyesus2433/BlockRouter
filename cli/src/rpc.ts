/** Accepts absolute HTTP(S) URLs only, without userinfo or a fragment. */
export function validateRpcUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:\/\//.test(value) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error();
    }
  } catch {
    throw new Error("RPC URL must be an absolute HTTP(S) URL without userinfo or a fragment");
  }
  return value;
}

/** For display only: RPC URLs can carry API keys in the path or query string. */
export function describeRpc(value: string, custom: boolean): string {
  return custom ? `custom RPC at ${new URL(value).host}` : new URL(value).origin;
}
