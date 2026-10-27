import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "./auth/AuthContext";
import { deleteFile, listFiles, uploadFile, type StoredFile } from "./lib/api";
import ShareLinksPanel from "./ShareLinksPanel";
import RecipientPage from "./RecipientPage";
import { DEFAULT_MAX_UPLOAD_BYTES, isWithinUploadLimit } from "./lib/upload-limit";
import { customExpirationToIso, getPresetExpiration, maxUploadLifetimeMilliseconds, toDateTimeLocalValue, uploadExpiryOptions, type UploadExpiryChoice } from "./lib/upload-expiration";

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

function AuthScreen({ initialMode = "login", onBack }: { initialMode?: "login" | "signup"; onBack?: () => void }) {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">(initialMode);
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
        <a className="brand" href="/" aria-label="DropVault home" onClick={(event) => { if (onBack) { event.preventDefault(); onBack(); } }}><span className="brand-mark">D</span>DropVault</a>
        <p className="eyebrow">Your private file space</p>
        <h1 id="auth-heading">{mode === "login" ? "Welcome back." : "Make room to share."}</h1>
        <p className="auth-copy">{mode === "login" ? "Sign in to upload and manage your private files." : "Create an account to start sharing files on your terms."}</p>
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

const demoExpirations = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "3d", label: "3 days" },
  { value: "7d", label: "7 days" },
] as const;

function LocalFileDemo() {
  const [file, setFile] = useState<File | null>(null);
  const [expiration, setExpiration] = useState<(typeof demoExpirations)[number]["value"]>("24h");
  const [dragging, setDragging] = useState(false);

  function selectFile(candidate?: File) {
    if (candidate) setFile(candidate);
  }

  return (
    <section className="local-demo" aria-label="Local file preview demo">
      <div className="demo-heading"><span className="demo-status"><span /> Local preview</span><span className="demo-lock" aria-hidden="true">◇</span></div>
      <p className="demo-title">A little preview.</p>
      <p className="demo-copy">Choose a file and expiry to see how sharing works. Nothing leaves your device.</p>
      <label
        className={`demo-dropzone${dragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
        htmlFor="demo-file"
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files[0]); }}
      >
        <input id="demo-file" className="visually-hidden" type="file" onChange={(event) => selectFile(event.target.files?.[0])} />
        {file ? <><span className="demo-file-icon" aria-hidden="true">FILE</span><span className="demo-file-info"><strong title={file.name}>{file.name}</strong><small>{formatSize(file.size)}</small></span><span className="demo-change">Change</span></>
          : <><span className="demo-upload-icon" aria-hidden="true">↑</span><span className="demo-drop-copy"><strong>Drop a file here</strong><small>or choose one from your device</small></span></>}
      </label>
      <div className="demo-expiry-label">Link duration</div>
      <div className="demo-expiry-choices" role="group" aria-label="Preview link duration">
        {demoExpirations.map((option) => <button key={option.value} type="button" aria-pressed={expiration === option.value} onClick={() => setExpiration(option.value)}>{option.label}</button>)}
      </div>
      <div className="demo-link-preview"><span className="demo-link-mark" aria-hidden="true">D</span><span><strong>{file ? "Ready to share" : "Your private link"}</strong><small>{file ? `Expires in ${demoExpirations.find((item) => item.value === expiration)?.label}` : "Choose a file to preview"}</small></span><span className="demo-preview-lock" aria-hidden="true">⌑</span></div>
      <p className="demo-disclaimer">Preview only · no upload or link is created</p>
    </section>
  );
}

function LandingPage({ onGetStarted, onSignIn }: { onGetStarted: () => void; onSignIn: () => void }) {
  const features = [
    { icon: "⌑", title: "Private file access", copy: "Your files stay available for up to 7 days in private storage, accessible through your account or a valid share link." },
    { icon: "◷", title: "Links on your time", copy: "Choose when a share link expires, or revoke it whenever you need to." },
    { icon: "◇", title: "Careful token handling", copy: "Share tokens are stored as hashes and checked by the API before each download." },
  ];
  return (
    <main className="landing-shell">
      <header className="topbar landing-topbar">
        <a className="brand" href="/" aria-label="DropVault home"><span className="brand-mark">D</span>DropVault</a>
        <button className="quiet-button landing-signin" type="button" onClick={onSignIn}>Sign in</button>
      </header>
      <section className="landing-hero">
        <div className="hero-copy">
          <p className="eyebrow"><span className="hero-eyebrow-dot" /> Private file sharing, made simple</p>
          <h1>Your files.<br />Your rules.<br /><span>Your time.</span></h1>
          <p className="hero-description">Share files privately with links that expire when you choose. Files stay available for up to 7 days.</p>
          <div className="hero-actions"><button className="primary-button hero-primary" type="button" onClick={onGetStarted}>Get started <span aria-hidden="true">→</span></button><button className="hero-secondary" type="button" onClick={onSignIn}>I already have an account</button></div>
          <p className="hero-footnote"><span aria-hidden="true">◇</span> Private storage. Sharing stays in your hands.</p>
        </div>
        <LocalFileDemo />
      </section>

      <section className="landing-features" aria-labelledby="features-heading">
        <div className="landing-section-heading"><p className="eyebrow">Thoughtful by design</p><h2 id="features-heading">Share with a little more peace of mind.</h2></div>
        <div className="feature-grid">{features.map((feature) => <article className="feature-card" key={feature.title}><span className="feature-icon" aria-hidden="true">{feature.icon}</span><h3>{feature.title}</h3><p>{feature.copy}</p></article>)}</div>
      </section>

      <section className="landing-how" aria-labelledby="how-heading">
        <div className="how-heading"><p className="eyebrow">Simple from the start</p><h2 id="how-heading">Three steps.<br />Then it’s on its way.</h2></div>
        <ol className="how-steps"><li><span>01</span><div><strong>Upload a file</strong><p>Add a file to your private DropVault space.</p></div></li><li><span>02</span><div><strong>Choose an expiration</strong><p>Set how long your share link stays available.</p></div></li><li><span>03</span><div><strong>Share the link</strong><p>Send it to someone who needs the file.</p></div></li></ol>
      </section>
      <footer className="landing-footer"><span>DropVault</span><span>Temporary sharing, thoughtfully built.</span><button type="button" onClick={onGetStarted}>Get started <span aria-hidden="true">→</span></button></footer>
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
  const [expiryChoice, setExpiryChoice] = useState<UploadExpiryChoice>("7d");
  const [presetExpiresAt, setPresetExpiresAt] = useState(() => getPresetExpiration("7d"));
  const [customExpiresAt, setCustomExpiresAt] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [draggingFile, setDraggingFile] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState("");
  const uploadLock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selectedFile || !["image/jpeg", "image/png", "image/webp"].includes(selectedFile.type)) {
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedFile]);
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
    if (!session || !selectedFile || uploadLock.current) return;
    setError("");
    setUploadSuccess("");
    if (!isWithinUploadLimit(selectedFile.size, maxFileSize)) {
      setError(`Choose a file no larger than ${formatMaxSize(maxFileSize)}.`);
      return;
    }
    if (!allowedTypes.has(selectedFile.type)) {
      setError("Use a PDF, JPEG, PNG, WebP, or plain text file.");
      return;
    }
    let expiration: string | undefined;
    if (expiryChoice === "custom") {
      try {
        expiration = customExpirationToIso(customExpiresAt);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Choose a valid future expiration.");
        return;
      }
      if (!expiration) {
        setError("Choose a custom expiration date and time.");
        return;
      }
    } else {
      if (!presetExpiresAt || new Date(presetExpiresAt).getTime() <= Date.now() || new Date(presetExpiresAt).getTime() > Date.now() + maxUploadLifetimeMilliseconds) {
        setError("Choose an expiration time in the future.");
        return;
      }
      expiration = presetExpiresAt;
    }

    uploadLock.current = true;
    setUploading(true);
    try {
      const added = await uploadFile(session.access_token, selectedFile, expiration);
      setFiles((current) => [added, ...current]);
      setSelectedFile(null);
      setExpiryChoice("7d");
      setPresetExpiresAt(getPresetExpiration("7d"));
      setCustomExpiresAt("");
      if (fileInput.current) fileInput.current.value = "";
      setUploadSuccess(`${added.originalName} uploaded successfully.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
      uploadLock.current = false;
    }
  }

  function chooseFile(file?: File) {
    if (!file) return;
    setUploadSuccess("");
    if (!isWithinUploadLimit(file.size, maxFileSize)) {
      setSelectedFile(null);
      setError(`Choose a file no larger than ${formatMaxSize(maxFileSize)}.`);
      return;
    }
    if (!allowedTypes.has(file.type)) {
      setSelectedFile(null);
      setError("Use a PDF, JPEG, PNG, WebP, or plain text file.");
      return;
    }
    setSelectedFile(file);
    setError("");
  }

  function chooseExpiry(choice: UploadExpiryChoice) {
    setExpiryChoice(choice);
    setError("");
    if (choice !== "custom") {
      setPresetExpiresAt(getPresetExpiration(choice));
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

        <form className="upload-panel" onSubmit={(event) => void handleUpload(event)}>
          <div className="upload-copy"><span className="upload-symbol" aria-hidden="true">↑</span><div><strong>Upload a file</strong><p>PDF, JPEG, PNG, WebP, or plain text · up to {formatMaxSize(maxFileSize)}</p></div></div>
          <div className="upload-workflow">
            <input ref={fileInput} id="upload-file" className="visually-hidden" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt" aria-label="Choose a file to upload" disabled={uploading} onChange={(event) => { chooseFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
            <button
              className={`upload-dropzone${draggingFile ? " is-dragging" : ""}${selectedFile ? " has-selection" : ""}`}
              type="button"
              disabled={uploading}
              aria-label={selectedFile ? `Replace ${selectedFile.name}` : "Choose a file to upload"}
              aria-describedby="upload-dropzone-help"
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setDraggingFile(true); }}
              onDragLeave={(event) => { event.preventDefault(); event.stopPropagation(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFile(false); }}
              onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDraggingFile(false); chooseFile(event.dataTransfer.files[0]); }}
            >
              <span className="upload-drop-icon" aria-hidden="true">{draggingFile ? "↓" : "↑"}</span>
              <span className="upload-drop-text"><strong>{selectedFile ? "Drop another file to replace it" : "Drop your file here"}</strong><small id="upload-dropzone-help">or click to browse · one file at a time</small></span>
              <span className="upload-browse">Browse files</span>
            </button>

            {selectedFile && <div className="selected-file-card" role="status">
              {previewUrl ? <img className="selected-image-preview" src={previewUrl} alt={`Preview of ${selectedFile.name}`} />
                : <span className={`selected-file-icon${selectedFile.type === "application/pdf" ? " pdf" : ""}`} aria-hidden="true">{selectedFile.type === "application/pdf" ? "PDF" : "TXT"}</span>}
              <span className="selected-file-info"><strong title={selectedFile.name}>{selectedFile.name}</strong><small>{formatSize(selectedFile.size)}</small></span>
              <button className="remove-file-button" type="button" disabled={uploading} onClick={() => { setSelectedFile(null); setError(""); setUploadSuccess(""); }}>Remove</button>
            </div>}

            <fieldset className="upload-expiry" disabled={uploading}>
              <legend>File expiration</legend>
              <div className="upload-expiry-options" role="group" aria-label="File expiration options">
                {uploadExpiryOptions.map((option) => <button key={option.value} type="button" aria-pressed={expiryChoice === option.value} onClick={() => chooseExpiry(option.value)}>{option.label}</button>)}
                <button type="button" aria-pressed={expiryChoice === "custom"} onClick={() => chooseExpiry("custom")}>Custom</button>
              </div>
              {expiryChoice !== "custom" && <p className="expiry-selection-note">Expires {new Date(presetExpiresAt).toLocaleString()}</p>}
              {expiryChoice === "custom" && <label className="expiration-label" htmlFor="expires-at">Keep until <input id="expires-at" type="datetime-local" min={toDateTimeLocalValue(Date.now() + 60_000)} max={toDateTimeLocalValue(Date.now() + maxUploadLifetimeMilliseconds)} value={customExpiresAt} onChange={(event) => { setCustomExpiresAt(event.target.value); setError(""); }} /></label>}
            </fieldset>
            {uploading && <div className="upload-progress-state" role="status"><span className="upload-progress-spinner" aria-hidden="true" /> Uploading {selectedFile?.name ?? "your file"}…</div>}
            {error && <p className="dashboard-error upload-feedback" role="alert">{error}</p>}
            {uploadSuccess && <p className="upload-success" role="status">{uploadSuccess}</p>}
            <div className="upload-submit-row"><span className="upload-submit-hint">{selectedFile ? "Ready when you are." : "Choose a file to get started."}</span><button className="primary-button upload-submit" type="submit" disabled={uploading || !selectedFile}>{uploading ? "Uploading…" : "Upload file"}</button></div>
          </div>
        </form>

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
  const shareToken = new URLSearchParams(window.location.search).get("share");
  const { user, loading, error } = useAuth();
  const [authMode, setAuthMode] = useState<"login" | "signup" | null>(null);
  if (shareToken !== null) return <RecipientPage token={shareToken} />;
  if (loading) return <main className="loading-screen" aria-live="polite">Opening your private space…</main>;
  if (error) return <main className="loading-screen error-message" role="alert">{error}</main>;
  if (user) return <Dashboard />;
  return authMode ? <AuthScreen key={authMode} initialMode={authMode} onBack={() => setAuthMode(null)} />
    : <LandingPage onGetStarted={() => setAuthMode("signup")} onSignIn={() => setAuthMode("login")} />;
}
