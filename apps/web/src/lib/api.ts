export interface StoredFile {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string | null;
}

export class ApiError extends Error {}

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
  const result = await request<{ files: StoredFile[] }>(token, "/api/files");
  return result.files;
}

export async function uploadFile(token: string, file: File, expiresAt?: string): Promise<StoredFile> {
  const formData = new FormData();
  formData.append("file", file);
  if (expiresAt) formData.append("expiresAt", expiresAt);
  const result = await request<{ file: StoredFile }>(token, "/api/files", { method: "POST", body: formData });
  return result.file;
}

export function deleteFile(token: string, id: string): Promise<void> {
  return request<void>(token, `/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
}
