export interface StoredFile {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string | null;
}

export type ShareLinkStatus = "active" | "expired" | "revoked";

export interface ShareLink {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: ShareLinkStatus;
}

export interface CreatedShareLink {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

export class ApiError extends Error {}

function apiUrl(path: string): string {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "");
  return apiBaseUrl ? `${apiBaseUrl}/api${path}` : `/api${path}`;
}

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(body?.error?.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listFiles(token: string): Promise<StoredFile[]> {
  const result = await request<{ files: StoredFile[] }>(token, apiUrl("/files"));
  return result.files;
}

export async function uploadFile(token: string, file: File, expiresAt?: string): Promise<StoredFile> {
  const formData = new FormData();
  formData.append("file", file);
  if (expiresAt) formData.append("expiresAt", expiresAt);
  const result = await request<{ file: StoredFile }>(token, apiUrl("/files"), { method: "POST", body: formData });
  return result.file;
}

export function deleteFile(token: string, id: string): Promise<void> {
  return request<void>(token, apiUrl(`/files/${encodeURIComponent(id)}`), { method: "DELETE" });
}

export async function createShareLink(token: string, fileId: string, expiresAt: string): Promise<CreatedShareLink> {
  const result = await request<{ link: CreatedShareLink }>(token, apiUrl(`/files/${encodeURIComponent(fileId)}/share-links`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt }),
  });
  return result.link;
}

export async function listShareLinks(token: string, fileId: string): Promise<{ links: ShareLink[]; hasMore: boolean }> {
  return request<{ links: ShareLink[]; hasMore: boolean }>(
    token,
    apiUrl(`/files/${encodeURIComponent(fileId)}/share-links`),
  );
}

export function revokeShareLink(token: string, fileId: string, linkId: string): Promise<void> {
  return request<void>(
    token,
    apiUrl(`/files/${encodeURIComponent(fileId)}/share-links/${encodeURIComponent(linkId)}`),
    { method: "DELETE" },
  );
}

export function getShareDownloadUrl(shareToken: string): string {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "");
  const apiOrigin = apiBaseUrl || window.location.origin;
  return new URL(`/api/share/${encodeURIComponent(shareToken)}/download`, apiOrigin).toString();
}
