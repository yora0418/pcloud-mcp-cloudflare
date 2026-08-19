const ALLOWED_PCLOUD_API_HOSTS = new Set([
  "api.pcloud.com",
  "eapi.pcloud.com",
]);

export function normalizePCloudApiHost(value: string): string {
  const raw = value.trim();
  let url: URL;

  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(
      "PCLOUD_API_HOST must be api.pcloud.com or eapi.pcloud.com.",
    );
  }

  const hostname = url.hostname.toLowerCase();
  const normalizedInput = raw.toLowerCase();
  const canonicalInputs = new Set([
    hostname,
    `${hostname}/`,
    `https://${hostname}`,
    `https://${hostname}/`,
  ]);

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !ALLOWED_PCLOUD_API_HOSTS.has(hostname) ||
    !canonicalInputs.has(normalizedInput)
  ) {
    throw new Error(
      "PCLOUD_API_HOST must be a canonical HTTPS api.pcloud.com or eapi.pcloud.com host without credentials, a custom port, path, query, or fragment.",
    );
  }

  return hostname;
}
