import { createRemoteJWKSet, jwtVerify } from "jose";

type CloudflareAccessEnv = {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
};

export type CloudflareAccessPrincipal = {
  rateLimitKey: string;
};

const SHARED_VERIFIED_PRINCIPAL_KEY = "verified:shared";

const CLOUDFLARE_ACCESS_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

const jwksCache = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

export function normalizeTeamDomain(value: string): string {
  const raw = value.trim();
  let url: URL;

  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error("TEAM_DOMAIN must be a valid Cloudflare Access team domain.");
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
    !CLOUDFLARE_ACCESS_HOST_PATTERN.test(hostname) ||
    !canonicalInputs.has(normalizedInput)
  ) {
    throw new Error(
      "TEAM_DOMAIN must be an HTTPS Cloudflare Access team domain without credentials, a custom port, path, query, or fragment.",
    );
  }

  return `https://${hostname}`;
}

function getJwks(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export async function verifyCloudflareAccess(
  request: Request,
  env: CloudflareAccessEnv,
): Promise<CloudflareAccessPrincipal | undefined> {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
    console.error(
      `Cloudflare Access validation is not configured. TEAM_DOMAIN=${Boolean(env.TEAM_DOMAIN)} POLICY_AUD=${Boolean(env.POLICY_AUD)}`,
    );
    return undefined;
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    console.warn("Cloudflare Access JWT header is missing.");
    return undefined;
  }

  try {
    const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      algorithms: ["RS256"],
      issuer: teamDomain,
      audience: env.POLICY_AUD,
    });

    const subject =
      typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (subject) {
      return { rateLimitKey: `sub:${subject}` };
    }

    const commonName =
      typeof payload.common_name === "string"
        ? payload.common_name.trim()
        : "";
    return {
      rateLimitKey: commonName
        ? `common_name:${commonName}`
        : SHARED_VERIFIED_PRINCIPAL_KEY,
    };
  } catch {
    console.warn("Cloudflare Access JWT verification failed.");
    return undefined;
  }
}
