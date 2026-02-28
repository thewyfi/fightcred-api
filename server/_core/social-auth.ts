/**
 * Social Auth Routes
 * Handles Google, X (Twitter), Facebook OAuth and Magic Link email authentication.
 * These routes are independent of the Manus OAuth system.
 */
import type { Express, Request, Response } from "express";
import { Resend } from "resend";
import { SignJWT } from "jose";
import * as crypto from "crypto";
import { getDb } from "../db";
import { users, userProfiles } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";

// ─── Constants ────────────────────────────────────────────────────────────────
const COOKIE_NAME = "manus_session";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

// In-memory store for magic link tokens (use Redis in production for multi-instance)
const magicLinkStore = new Map<string, { email: string; expiresAt: number }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getSessionSecret() {
  const secret = ENV.cookieSecret;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(secret);
}

async function createSessionJWT(openId: string, name: string): Promise<string> {
  const secretKey = getSessionSecret();
  const expirationSeconds = Math.floor((Date.now() + ONE_YEAR_MS) / 1000);
  return new SignJWT({
    openId,
    appId: ENV.appId || "fightcred-web",
    name,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(secretKey);
}

async function upsertSocialUser(params: {
  openId: string;
  name: string;
  email?: string | null;
  loginMethod: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.openId, params.openId))
    .limit(1);

  const now = new Date();
  if (existing.length === 0) {
    await db.insert(users).values({
      openId: params.openId,
      name: params.name,
      email: params.email ?? null,
      loginMethod: params.loginMethod,
      lastSignedIn: now,
    });
  } else {
    await db
      .update(users)
      .set({
        name: params.name,
        email: params.email ?? existing[0].email,
        loginMethod: params.loginMethod,
        lastSignedIn: now,
      })
      .where(eq(users.openId, params.openId));
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, params.openId))
    .limit(1);
  return result[0];
}

function setSessionCookie(req: Request, res: Response, token: string) {
  const cookieOptions = getSessionCookieOptions(req);
  res.cookie(COOKIE_NAME, token, {
    ...cookieOptions,
    maxAge: ONE_YEAR_MS,
  });
}

async function getProfileRedirect(userId: number, redirectTo: string, fallback: string): Promise<string> {
  try {
    const db = await getDb();
    if (!db) return redirectTo || fallback;
    const rows = await db.select({ id: userProfiles.id }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
    const base = redirectTo || fallback;
    return rows.length === 0 ? `${base}/profile/setup` : base;
  } catch {
    return redirectTo || fallback;
  }
}

function getCallbackBase(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// ─── OAuth State Helpers ───────────────────────────────────────────────────────
function encodeState(redirectTo: string): string {
  return Buffer.from(JSON.stringify({ redirectTo })).toString("base64url");
}

function decodeState(state: string): { redirectTo: string } {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf-8"));
  } catch {
    return { redirectTo: "/" };
  }
}

// ─── Route Registration ───────────────────────────────────────────────────────
export function registerSocialAuthRoutes(app: Express) {
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const TWITTER_CLIENT_ID = process.env.TWITTER_CLIENT_ID;
  const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;
  const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
  const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const WEB_APP_URL = process.env.WEB_APP_URL || "https://fightcred-web.pages.dev";

  // ── Google OAuth ─────────────────────────────────────────────────────────────
  app.get("/api/auth/google", (req: Request, res: Response) => {
    if (!GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: "Google OAuth not configured" });
    }
    const redirectTo = (req.query.redirectTo as string) || WEB_APP_URL;
    const state = encodeState(redirectTo);
    const callbackUrl = `${getCallbackBase(req)}/api/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: callbackUrl,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "select_account",
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string>;
    const { redirectTo } = decodeState(state || "");

    if (error || !code) {
      return res.redirect(`${WEB_APP_URL}/login?error=${encodeURIComponent(error || "cancelled")}`);
    }

    try {
      const callbackUrl = `${getCallbackBase(req)}/api/auth/google/callback`;
      // Exchange code for tokens
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID!,
          client_secret: GOOGLE_CLIENT_SECRET!,
          redirect_uri: callbackUrl,
          grant_type: "authorization_code",
        }),
      });
      const tokenData = await tokenRes.json() as any;
      if (!tokenData.access_token) throw new Error("No access token from Google");

      // Get user info
      const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const googleUser = await userRes.json() as any;

      const openId = `google:${googleUser.sub}`;
      const user = await upsertSocialUser({
        openId,
        name: googleUser.name || googleUser.email,
        email: googleUser.email,
        loginMethod: "google",
      });

      const sessionToken = await createSessionJWT(openId, user.name || googleUser.name || "");
      setSessionCookie(req, res, sessionToken);
      const destination = await getProfileRedirect(user.id, redirectTo, WEB_APP_URL);
      res.redirect(destination);
    } catch (err: any) {
      console.error("[Google OAuth] Error:", err);
      res.redirect(`${WEB_APP_URL}/login?error=${encodeURIComponent("Google sign-in failed")}`);
    }
  });

  // ── X (Twitter) OAuth 2.0 ────────────────────────────────────────────────────
  // Store PKCE code verifiers in memory (short-lived)
  const twitterCodeVerifiers = new Map<string, string>();

  app.get("/api/auth/twitter", (req: Request, res: Response) => {
    if (!TWITTER_CLIENT_ID) {
      return res.status(503).json({ error: "X/Twitter OAuth not configured" });
    }
    const redirectTo = (req.query.redirectTo as string) || WEB_APP_URL;
    const state = encodeState(redirectTo);
    const callbackUrl = `${getCallbackBase(req)}/api/auth/twitter/callback`;

    // PKCE
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    twitterCodeVerifiers.set(state, codeVerifier);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: TWITTER_CLIENT_ID,
      redirect_uri: callbackUrl,
      scope: "tweet.read users.read offline.access",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    res.redirect(`https://twitter.com/i/oauth2/authorize?${params.toString()}`);
  });

  app.get("/api/auth/twitter/callback", async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string>;
    const { redirectTo } = decodeState(state || "");

    if (error || !code) {
      return res.redirect(`${WEB_APP_URL}/login?error=${encodeURIComponent(error || "cancelled")}`);
    }

    try {
      const codeVerifier = twitterCodeVerifiers.get(state);
      twitterCodeVerifiers.delete(state);
      if (!codeVerifier) throw new Error("Invalid state");

      const callbackUrl = `${getCallbackBase(req)}/api/auth/twitter/callback`;
      const credentials = Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString("base64");

      const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({
          code,
          grant_type: "authorization_code",
          redirect_uri: callbackUrl,
          code_verifier: codeVerifier,
        }),
      });
      const tokenData = await tokenRes.json() as any;
      if (!tokenData.access_token) throw new Error("No access token from Twitter");

      const userRes = await fetch("https://api.twitter.com/2/users/me?user.fields=name,username,profile_image_url", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const twitterData = await userRes.json() as any;
      const twitterUser = twitterData.data;

      const openId = `twitter:${twitterUser.id}`;
      const user = await upsertSocialUser({
        openId,
        name: twitterUser.name || twitterUser.username,
        email: null,
        loginMethod: "twitter",
      });

      const sessionToken = await createSessionJWT(openId, user.name || twitterUser.name || "");
      setSessionCookie(req, res, sessionToken);
      const destination = await getProfileRedirect(user.id, redirectTo, WEB_APP_URL);
      res.redirect(destination);
    } catch (err: any) {
      console.error("[Twitter OAuth] Error:", err);
      res.redirect(`${WEB_APP_URL}/login?error=${encodeURIComponent("X sign-in failed")}`);
    }
  });

  // ── Facebook OAuth ────────────────────────────────────────────────────────────
  app.get("/api/auth/facebook", (req: Request, res: Response) => {
    if (!FACEBOOK_APP_ID) {
      return res.status(503).json({ error: "Facebook OAuth not configured" });
    }
    const redirectTo = (req.query.redirectTo as string) || WEB_APP_URL;
    const state = encodeState(redirectTo);
    const callbackUrl = `${getCallbackBase(req)}/api/auth/facebook/callback`;
    const params = new URLSearchParams({
      client_id: FACEBOOK_APP_ID,
      redirect_uri: callbackUrl,
      state,
      scope: "email,public_profile",
      response_type: "code",
    });
    res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`);
  });

  app.get("/api/auth/facebook/callback", async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string>;
    const { redirectTo } = decodeState(state || "");

    if (error || !code) {
      return res.redirect(`${WEB_APP_URL}/login?error=${encodeURIComponent(error || "cancelled")}`);
    }

    try {
      const callbackUrl = `${getCallbackBase(req)}/api/auth/facebook/callback`;
      const tokenRes = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?${new URLSearchParams({
          client_id: FACEBOOK_APP_ID!,
          client_secret: FACEBOOK_APP_SECRET!,
          redirect_uri: callbackUrl,
          code,
        })}`,
      );
      const tokenData = await tokenRes.json() as any;
      if (!tokenData.access_token) throw new Error("No access token from Facebook");

      const userRes = await fetch(
        `https://graph.facebook.com/me?fields=id,name,email&access_token=${tokenData.access_token}`,
      );
      const fbUser = await userRes.json() as any;

      const openId = `facebook:${fbUser.id}`;
      const user = await upsertSocialUser({
        openId,
        name: fbUser.name,
        email: fbUser.email || null,
        loginMethod: "facebook",
      });

      const sessionToken = await createSessionJWT(openId, user.name || fbUser.name || "");
      setSessionCookie(req, res, sessionToken);
      const destination = await getProfileRedirect(user.id, redirectTo, WEB_APP_URL);
      res.redirect(destination);
    } catch (err: any) {
      console.error("[Facebook OAuth] Error:", err);
      res.redirect(`${WEB_APP_URL}/login?error=${encodeURIComponent("Facebook sign-in failed")}`);
    }
  });

  // ── Magic Link (Email) ────────────────────────────────────────────────────────
  app.post("/api/auth/magic-link/send", async (req: Request, res: Response) => {
    const { email, redirectTo } = req.body as { email: string; redirectTo?: string };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    if (!RESEND_API_KEY) {
      return res.status(503).json({ error: "Email service not configured" });
    }

    try {
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = Date.now() + MAGIC_LINK_EXPIRY_MS;
      magicLinkStore.set(token, { email, expiresAt });

      const callbackBase = getCallbackBase(req);
      const magicUrl = `${callbackBase}/api/auth/magic-link/verify?token=${token}&redirectTo=${encodeURIComponent(redirectTo || WEB_APP_URL)}`;

      const resend = new Resend(RESEND_API_KEY);
      await resend.emails.send({
        from: "FightCred <noreply@fightcred.app>",
        to: email,
        subject: "Your FightCred sign-in link",
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0D0D0D; color: #fff; border-radius: 12px;">
            <div style="text-align: center; margin-bottom: 24px;">
              <div style="display: inline-block; width: 56px; height: 56px; background: #D20A0A; border-radius: 12px; font-size: 24px; font-weight: 900; color: white; line-height: 56px; text-align: center;">FC</div>
              <h1 style="margin: 16px 0 4px; font-size: 22px; font-weight: 800;">Sign in to FightCred</h1>
              <p style="color: #9A9A9A; margin: 0; font-size: 14px;">Click the button below to sign in. This link expires in 15 minutes.</p>
            </div>
            <a href="${magicUrl}" style="display: block; text-align: center; background: #D20A0A; color: white; text-decoration: none; padding: 14px 24px; border-radius: 10px; font-weight: 700; font-size: 15px; margin: 24px 0;">Sign in to FightCred</a>
            <p style="color: #555; font-size: 12px; text-align: center; margin: 0;">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `,
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error("[Magic Link] Send error:", err);
      res.status(500).json({ error: "Failed to send magic link email" });
    }
  });

  app.get("/api/auth/magic-link/verify", async (req: Request, res: Response) => {
    const { token, redirectTo } = req.query as Record<string, string>;
    const destination = redirectTo || WEB_APP_URL;

    if (!token) {
      return res.redirect(`${WEB_APP_URL}/login?error=${encodeURIComponent("Invalid magic link")}`);
    }

    const stored = magicLinkStore.get(token);
    if (!stored || Date.now() > stored.expiresAt) {
      magicLinkStore.delete(token);
      return res.redirect(`${WEB_APP_URL}/login?error=${encodeURIComponent("Magic link expired. Please request a new one.")}`);
    }

    magicLinkStore.delete(token);

    try {
      const { email } = stored;
      const openId = `email:${email.toLowerCase()}`;
      const user = await upsertSocialUser({
        openId,
        name: email.split("@")[0],
        email,
        loginMethod: "email",
      });

      const sessionToken = await createSessionJWT(openId, user.name || email.split("@")[0]);
      setSessionCookie(req, res, sessionToken);
      const finalDestination = await getProfileRedirect(user.id, destination, WEB_APP_URL);
      res.redirect(finalDestination);
    } catch (err: any) {
      console.error("[Magic Link] Verify error:", err);
      res.redirect(`${WEB_APP_URL}/login?error=${encodeURIComponent("Sign-in failed. Please try again.")}`);
    }
  });

  // ── Auth status check ─────────────────────────────────────────────────────────
  app.get("/api/auth/providers", (_req: Request, res: Response) => {
    res.json({
      google: !!GOOGLE_CLIENT_ID,
      twitter: !!TWITTER_CLIENT_ID,
      facebook: !!FACEBOOK_APP_ID,
      magicLink: !!RESEND_API_KEY,
    });
  });
}
