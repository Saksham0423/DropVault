export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function parseUploadLimit(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveUploadLimit(apiLimit?: string, frontendLimit?: string): number {
  const apiMax = parseUploadLimit(apiLimit) ?? DEFAULT_MAX_UPLOAD_BYTES;
  const frontendMax = parseUploadLimit(frontendLimit) ?? apiMax;
  return Math.min(apiMax, frontendMax);
}

export function isWithinUploadLimit(fileSize: number, limit: number): boolean {
  return Number.isSafeInteger(fileSize) && fileSize >= 0 && fileSize <= limit;
}
