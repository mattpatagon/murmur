export function isBootstrapMurmurEndpoint(existing: unknown, target: string): boolean {
  if (typeof existing !== "string") return false;
  try {
    const source: URL = new URL(existing);
    const destination: URL = new URL(target);
    return (
      (source.protocol === "https:" ||
        (source.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(source.hostname))) &&
      source.origin === destination.origin &&
      source.pathname === "/setup/mcp" &&
      destination.pathname === "/mcp" &&
      source.username === "" &&
      source.password === "" &&
      source.search === "" &&
      source.hash === "" &&
      destination.username === "" &&
      destination.password === "" &&
      destination.search === "" &&
      destination.hash === ""
    );
  } catch (_error: unknown) {
    return false;
  }
}
