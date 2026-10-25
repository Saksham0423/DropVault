import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export function validateRequest(schema: ZodType): RequestHandler {
  return (request, _response, next) => {
    const result = schema.safeParse({
      body: request.body,
      params: request.params,
      query: request.query,
    });

    if (!result.success) {
      next(result.error);
      return;
    }

    request.validated = result.data;
    next();
  };
}
