import type { CookieOptions, Request } from "express";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isIpAddress(host: string) {
  // Basic IPv4 check and IPv6 presence detection.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;

  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");

  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}

/**
 * Extract parent domain for cookie sharing across subdomains.
 * e.g., "3000-xxx.us2.manus.computer" -> ".us2.manus.computer"
 * e.g., "3000-xxx.manuspre.computer" -> ".manuspre.computer"
 * This allows cookies set by 3000-xxx to be read by 8081-xxx and 3001-xxx
 */
function getParentDomain(hostname: string): string | undefined {
  // Don't set domain for localhost or IP addresses
  if (LOCAL_HOSTS.has(hostname) || isIpAddress(hostname)) {
    return undefined;
  }

  // Split hostname into parts
  const parts = hostname.split(".");

  // Need at least 3 parts for a subdomain (e.g., "3000-xxx.manuspre.computer")
  if (parts.length < 3) {
    return undefined;
  }

  // For Manus sandbox domains like "3000-xxx.us2.manus.computer" (4+ parts),
  // use the last 3 parts as the parent domain (e.g., ".us2.manus.computer")
  // so cookies are shared across all sandbox ports on the same region.
  // For standard 3-part domains like "3000-xxx.manuspre.computer",
  // use the last 2 parts (e.g., ".manuspre.computer").
  if (parts.length >= 4) {
    return "." + parts.slice(-3).join(".");
  }
  return "." + parts.slice(-2).join(".");
}

export function getSessionCookieOptions(
  req: Request,
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  // Prefer X-Forwarded-Host when the request comes through a proxy (e.g., Next.js API route)
  // so we can derive the correct parent domain for cookie sharing.
  const forwardedHost = req.headers["x-forwarded-host"];
  const effectiveHost = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.hostname;
  const hostname = effectiveHost.split(":")[0]; // strip port if present
  const domain = getParentDomain(hostname);

  return {
    domain,
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req),
  };
}
