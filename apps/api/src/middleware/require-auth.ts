import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { RequestHandler } from "express";

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

export function requireAuth(client: Pick<SupabaseClient, "auth">): RequestHandler {
  return async (request, response, next) => {
    const authorization = request.header("authorization");
    const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!accessToken) {
      response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
      return;
    }

    try {
      const { data, error } = await client.auth.getUser(accessToken);
      if (error || !data.user) {
        response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid access token" } });
        return;
      }

      request.user = data.user;
      next();
    } catch (error) {
      next(error);
    }
  };
}
