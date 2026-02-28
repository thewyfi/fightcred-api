import { COOKIE_NAME, ONE_YEAR_MS } from "../../shared/const.js";
import type { Express, Request, Response } from "express";
import { getUserByOpenId, upsertUser } from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { ENV } from "./env";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

async function syncUser(userInfo: {
  openId?: string | null;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  platform?: string | null;
}) {
  if (!userInfo.openId) {
    throw new Error("openId missing from user info");
  }

  const lastSignedIn = new Date();
  await upsertUser({
    openId: userInfo.openId,
    name: userInfo.name || null,
    email: userInfo.email ?? null,
    loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
    lastSignedIn,
  });
  const saved = await getUserByOpenId(userInfo.openId);
  return (
    saved ?? {
      openId: userInfo.openId,
      name: userInfo.name,
      email: userInfo.email,
      loginMethod: userInfo.loginMethod ?? null,
      lastSignedIn,
    }
  );
}

function buildUserResponse(
  user:
    | Awaited<ReturnType<typeof getUserByOpenId>>
    | {
        openId: string;
        name?: string | null;
        email?: string | null;
        loginMethod?: string | null;
        lastSignedIn?: Date | null;
      },
) {
  return {
    id: (user as any)?.id ?? null,
    openId: user?.openId ?? null,
    name: user?.name ?? null,
    email: user?.email ?? null,
    loginMethod: user?.loginMethod ?? null,
    lastSignedIn: (user?.lastSignedIn ?? new Date()).toISOString(),
  };
}

export function registerOAuthRoutes(app: Express) {
  // ─── Web OAuth Login Initiation ──────────────────────────────────────────────
  // Redirects the browser to the Manus OAuth portal to begin the sign-in flow.
  // The redirectTo param is used after callback to send the user back to the frontend.
  app.get("/api/oauth/login", (req: Request, res: Response) => {
    const redirectTo = getQueryParam(req, "redirectTo") ?? "";
    const oauthPortalUrl = process.env.VITE_OAUTH_PORTAL_URL ?? "https://manus.im";
    const appId = ENV.appId;
    // Use X-Forwarded-Host if present (request came through the Next.js proxy)
    // so the callback URL points to the public web app domain, not localhost
    const forwardedHost = req.headers["x-forwarded-host"];
    const effectiveHost = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.get("host") || "localhost:3000";
    const isSecure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
    const effectiveProtocol = isSecure ? "https" : "http";
    // The callback URL must be clean (no query params) so the OAuth portal can
    // append ?code=...&state=... to it correctly.
    const callbackUrl = `${effectiveProtocol}://${effectiveHost}/api/oauth/callback`;
    // Encode the redirectTo destination inside the state parameter so it survives
    // the OAuth round-trip without polluting the redirectUri.
    const statePayload = JSON.stringify({ callbackUrl, redirectTo });
    const state = Buffer.from(statePayload).toString("base64url");
    const loginUrl = new URL(`${oauthPortalUrl}/app-auth`);
    loginUrl.searchParams.set("appId", appId);
    loginUrl.searchParams.set("redirectUri", callbackUrl);
    loginUrl.searchParams.set("state", state);
    loginUrl.searchParams.set("type", "signIn");
    res.redirect(302, loginUrl.toString());
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      await syncUser(userInfo);
      const sessionToken = await sdk.createSessionToken(userInfo.openId!, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      // Decode the state to extract the final redirect destination.
      // State may be JSON-encoded (new format: {callbackUrl, redirectTo})
      // or a plain base64 URL string (legacy format).
      let redirectTo: string | undefined;
      try {
        const decoded = Buffer.from(state, "base64url").toString("utf8");
        const parsed = JSON.parse(decoded);
        redirectTo = parsed.redirectTo || undefined;
      } catch {
        // Legacy: state was just a base64-encoded URL string
        redirectTo = getQueryParam(req, "redirectTo");
      }
      const frontendUrl =
        redirectTo ||
        process.env.EXPO_WEB_PREVIEW_URL ||
        process.env.EXPO_PACKAGER_PROXY_URL ||
        "http://localhost:8081";
      res.redirect(302, frontendUrl);
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });

  app.get("/api/oauth/mobile", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      const user = await syncUser(userInfo);

      const sessionToken = await sdk.createSessionToken(userInfo.openId!, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      res.json({
        app_session_id: sessionToken,
        user: buildUserResponse(user),
      });
    } catch (error) {
      console.error("[OAuth] Mobile exchange failed", error);
      res.status(500).json({ error: "OAuth mobile exchange failed" });
    }
  });

  // ─── Developer Preview Login ─────────────────────────────────────────────────
  // Only available in development mode. Creates a real session for a demo user
  // without requiring OAuth, so developers can explore the app without credentials.
  app.post("/api/auth/dev-login", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "Dev login is not available in production" });
      return;
    }

    try {
      const DEV_OPEN_ID = "dev-preview-user-001";
      const DEV_NAME = "Dev Preview";

      // Upsert the demo user into the database
      await upsertUser({
        openId: DEV_OPEN_ID,
        name: DEV_NAME,
        email: "dev@fightcred.app",
        loginMethod: "dev",
        lastSignedIn: new Date(),
      });

      const user = await getUserByOpenId(DEV_OPEN_ID);

      // Create a real session token signed with the app secret
      const sessionToken = await sdk.createSessionToken(DEV_OPEN_ID, {
        name: DEV_NAME,
        expiresInMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });

      res.json({
        app_session_id: sessionToken,
        user: buildUserResponse(user ?? {
          openId: DEV_OPEN_ID,
          name: DEV_NAME,
          email: "dev@fightcred.app",
          loginMethod: "dev",
          lastSignedIn: new Date(),
        }),
      });
    } catch (error) {
      console.error("[Dev Login] Failed:", error);
      res.status(500).json({ error: "Dev login failed" });
    }
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    const cookieOptions = getSessionCookieOptions(req);
    // Clear on the specific domain (e.g., .us2.manus.computer)
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    // Also clear on the broader parent domain (e.g., .manus.computer) to handle
    // cookies set by older sessions that used a 2-part parent domain
    if (cookieOptions.domain) {
      const parts = cookieOptions.domain.replace(/^\./, "").split(".");
      if (parts.length > 2) {
        const broaderDomain = "." + parts.slice(-2).join(".");
        res.clearCookie(COOKIE_NAME, { ...cookieOptions, domain: broaderDomain, maxAge: -1 });
      }
    }
    // Also clear without a domain (for localhost or fallback)
    res.clearCookie(COOKIE_NAME, { httpOnly: true, path: "/", sameSite: "none", secure: cookieOptions.secure });
    res.json({ success: true });
  });

  // Get current authenticated user - works with both cookie (web) and Bearer token (mobile)
  app.get("/api/auth/me", async (req: Request, res: Response) => {
    try {
      const user = await sdk.authenticateRequest(req);
      res.json({ user: buildUserResponse(user) });
    } catch (error) {
      console.error("[Auth] /api/auth/me failed:", error);
      res.status(401).json({ error: "Not authenticated", user: null });
    }
  });

  // Establish session cookie from Bearer token
  // Used by iframe preview: frontend receives token via postMessage, then calls this endpoint
  // to get a proper Set-Cookie response from the backend (3000-xxx domain)
  app.post("/api/auth/session", async (req: Request, res: Response) => {
    try {
      // Authenticate using Bearer token from Authorization header
      const user = await sdk.authenticateRequest(req);

      // Get the token from the Authorization header to set as cookie
      const authHeader = req.headers.authorization || req.headers.Authorization;
      if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        res.status(400).json({ error: "Bearer token required" });
        return;
      }
      const token = authHeader.slice("Bearer ".length).trim();

      // Set cookie for this domain (3000-xxx)
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      res.json({ success: true, user: buildUserResponse(user) });
    } catch (error) {
      console.error("[Auth] /api/auth/session failed:", error);
      res.status(401).json({ error: "Invalid token" });
    }
  });
}
