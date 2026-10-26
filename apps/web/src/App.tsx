import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth/AuthContext";
import { deleteFile, listFiles, uploadFile, type StoredFile } from "./lib/api";
import ShareLinksPanel from "./ShareLinksPanel";
import { DEFAULT_MAX_UPLOAD_BYTES, isWithinUploadLimit } from "./lib/upload-limit";

const maxFileSize = Number(import.meta.env.VITE_MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"]);

function formatMaxSize(size: number): string {
  if (size % (1024 * 1024) === 0) return `${size / (1024 * 1024)} MiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB (${size.toLocaleString()} bytes)`;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "login") {
        await signIn(email, password);
      } else {
        const session = await signUp(email, password);
        if (!session) setMessage("Check your inbox to confirm your email, then sign in.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-card" aria-labelledby="auth-heading">
        <a className="brand" href="/" aria-label="DropVault home"><span className="brand-mark">D</span>DropVault</a>
        <p className="eyebrow">Your private file space</p>
        <h1 id="auth-heading">{mode === "login" ? "Welcome back." : "Make room to share."}</h1>
        <p className="auth-copy">Sign in to upload and manage your private files.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} />
          {error && <p className="form-message error-message" role="alert">{error}</p>}
          {message && <p className="form-message success-message" role="status">{message}</p>}
          <button className="primary-button full-button" type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className="switch-auth">
          {mode === "login" ? "New to DropVault?" : "Already have an account?"}{" "}
          <button type="button" aria-label={mode === "login" ? "Switch to account creation" : "Switch to sign in"} onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); setMessage(""); }}>
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </section>
      <p className="auth-footnote">Private storage. Your files stay yours.</p>
    </main>
  );
}

function Dashboard() {
  const { session, user, signOut } = useAuth();
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [sharePanelFileId, setSharePanelFileId] = useState<string | null>(null);

  async function handleSignOut() {
    try {
      await signOut();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out. Please try again.");
    }
  }

  const refreshFiles = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      setFiles(await listFiles(session.access_token));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your files.");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void refreshFiles(); }, [refreshFiles]);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !selectedFile) return;
    setError("");
    if (!isWithinUploadLimit(selectedFile.size, maxFileSize)) {
      setError(`Choose a file no larger than ${formatMaxSize(maxFileSize)}.`);
      return;
    }
    if (!allowedTypes.has(selectedFile.type)) {
      setError("Use a PDF, JPEG, PNG, WebP, or plain text file.");
      return;
    }
    setUploading(true);
    try {
      const expiration = expiresAt ? new Date(expiresAt).toISOString() : undefined;
      const added = await uploadFile(session.access_token, selectedFile, expiration);
      setFiles((current) => [added, ...current]);
      setSelectedFile(null);
      setExpiresAt("");
      const input = document.getElementById("upload-file") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(file: StoredFile) {
    if (!session) return;
    setDeletingId(file.id);
    setError("");
    try {
      await deleteFile(session.access_token, file.id);
      setFiles((current) => current.filter((item) => item.id !== file.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this file.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar dashboard-topbar">
        <a className="brand" href="/" aria-label="DropVault home"><span className="brand-mark">D</span>DropVault</a>
        <div className="account-controls"><span>{user?.email}</span><button className="quiet-button" onClick={() => void handleSignOut()}>Sign out</button></div>
      </header>
      <section className="dashboard-content">
        <div className="dashboard-heading">
          <div><p className="eyebrow">Your private space</p><h1>Your files.</h1></div>
          <span className="status-pill"><span /> Private by design</span>
        </div>

        <form className="upload-panel" onSubmit={handleUpload}>
          <div className="upload-copy"><span className="upload-symbol" aria-hidden="true">↑</span><div><strong>Upload a file</strong><p>PDF, JPEG, PNG, WebP, or plain text · up to {formatMaxSize(maxFileSize)}</p></div></div>
          <div className="upload-controls">
            <label className="file-picker" htmlFor="upload-file">{selectedFile?.name ?? "Choose a file"}</label>
            <input id="upload-file" className="visually-hidden" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} />
            <label className="expiration-label" htmlFor="expires-at">Keep until <input id="expires-at" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
            <button className="primary-button" type="submit" disabled={uploading || !selectedFile}>{uploading ? "Uploading…" : "Upload"}</button>
          </div>
        </form>

        {error && <p className="dashboard-error" role="alert">{error}</p>}

        <div className="file-list-heading"><h2>Your uploads</h2><span>{files.length} {files.length === 1 ? "file" : "files"}</span></div>
        {loading ? <p className="empty-state">Loading your files…</p> : files.length === 0 ? (
          <div className="empty-state"><span className="empty-icon" aria-hidden="true">◇</span><strong>No files yet</strong><p>Upload your first file to see it here.</p></div>
        ) : (
          <ul className="file-list">
            {files.map((file) => <li className="file-entry" key={file.id}>
              <div className="file-row">
                <span className="file-icon" aria-hidden="true">{file.contentType === "application/pdf" ? "PDF" : file.contentType.startsWith("image/") ? "IMG" : "TXT"}</span>
                <div className="file-details"><strong title={file.originalName}>{file.originalName}</strong><span>{formatSize(file.sizeBytes)} · Added {new Date(file.createdAt).toLocaleDateString()}</span></div>
                {file.expiresAt && <span className="expiry-tag">Expires {new Date(file.expiresAt).toLocaleDateString()}</span>}
                <button
                  className="quiet-button share-toggle"
                  type="button"
                  aria-expanded={sharePanelFileId === file.id}
                  aria-controls={`share-panel-${file.id}`}
                  onClick={() => setSharePanelFileId((current) => current === file.id ? null : file.id)}
                >{sharePanelFileId === file.id ? "Close sharing" : "Share"}</button>
                <button className="delete-button" type="button" disabled={deletingId === file.id} onClick={() => void handleDelete(file)} aria-label={`Delete ${file.originalName}`}>{deletingId === file.id ? "Deleting…" : "Delete"}</button>
              </div>
              {sharePanelFileId === file.id && session && <div id={`share-panel-${file.id}`}><ShareLinksPanel file={file} token={session.access_token} /></div>}
            </li>)}
          </ul>
        )}
      </section>
      <footer>Temporary sharing, thoughtfully built.</footer>
    </main>
  );
}

export default function App() {
  const { user, loading, error } = useAuth();
  if (loading) return <main className="loading-screen" aria-live="polite">Opening your private space…</main>;
  if (error) return <main className="loading-screen error-message" role="alert">{error}</main>;
  return user ? <Dashboard /> : <AuthScreen />;
}
