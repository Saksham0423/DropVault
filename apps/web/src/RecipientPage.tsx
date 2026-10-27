import { useEffect, useState } from "react";
import { getPublicShareMetadata, getShareDownloadUrl, type PublicShareMetadata } from "./lib/api";

type RecipientState = "loading" | "ready" | "unavailable" | "network-error" | "invalid";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function useCountdown(expiresAt?: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt || Date.parse(expiresAt) <= now) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, now]);
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return null;
  const remaining = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  return { text: `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`, expired: remaining === 0 };
}

function isUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "unavailable" in error && error.unavailable === true);
}

function FileIcon({ contentType }: { contentType: string }) {
  const image = contentType.startsWith("image/");
  const pdf = contentType === "application/pdf";
  return <div className={`recipient-file-icon ${image ? "image" : pdf ? "pdf" : "document"}`} aria-hidden="true">{image ? "IMG" : pdf ? "PDF" : "FILE"}</div>;
}

export default function RecipientPage({ token }: { token: string }) {
  const [state, setState] = useState<RecipientState>("loading");
  const [metadata, setMetadata] = useState<PublicShareMetadata | null>(null);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const countdown = useCountdown(metadata?.expiresAt);

  useEffect(() => {
    let active = true;
    setState("loading");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setState("invalid");
      return () => { active = false; };
    }
    void getPublicShareMetadata(token).then((result) => {
      if (active) { setMetadata(result); setState("ready"); }
    }).catch((error: unknown) => {
      if (active) setState(isUnavailable(error) ? "unavailable" : error instanceof Error && error.message === "Invalid share metadata" ? "invalid" : "network-error");
    });
    return () => { active = false; };
  }, [token]);

  const unavailable = state === "unavailable" || state === "invalid" || (state === "ready" && countdown?.expired);
  return (
    <main className="recipient-shell">
      <header className="recipient-topbar"><a className="brand" href="/" aria-label="DropVault home"><span className="brand-mark">D</span>DropVault</a><span className="recipient-security"><span aria-hidden="true">◆</span> Private share</span></header>
      <section className="recipient-card" aria-live="polite">
        {state === "loading" && <div className="recipient-state"><div className="recipient-spinner"/><p>Checking your secure link…</p></div>}
        {state === "network-error" && <div className="recipient-state"><div className="recipient-state-icon">↻</div><p className="eyebrow">Connection interrupted</p><h1>We couldn’t check this link.</h1><p className="recipient-copy">Check your connection and try again. The link’s availability hasn’t been confirmed.</p><button className="primary-button" onClick={() => { setState("loading"); void getPublicShareMetadata(token).then((result) => { setMetadata(result); setState("ready"); }).catch((error: unknown) => setState(isUnavailable(error) ? "unavailable" : "network-error")); }}>Try again</button></div>}
        {unavailable && <div className="recipient-state"><div className="recipient-state-icon">⌁</div><p className="eyebrow">Temporary link unavailable</p><h1>This vault link is no longer available</h1><p className="recipient-copy">The file may have expired, been revoked, or been removed by its owner.</p><p className="recipient-security-note">Temporary links are intentionally unavailable after expiration or revocation.</p></div>}
        {state === "ready" && metadata && !countdown?.expired && <>
          <p className="eyebrow">A file was shared with you</p><h1>Your file is ready.</h1><p className="recipient-copy">This is a temporary, private share. Download it while the link is available.</p>
          <div className="recipient-file"><FileIcon contentType={metadata.contentType}/><div className="recipient-file-details"><strong title={metadata.filename}>{metadata.filename}</strong><span>{formatSize(metadata.sizeBytes)} <span aria-hidden="true">·</span> Temporary shared file</span></div></div>
          {countdown && <div className="recipient-expiry"><span>Link available for</span><strong>{countdown.text}</strong></div>}
          <a className="primary-button recipient-download" aria-disabled={downloadStarted} href={getShareDownloadUrl(token)} onClick={(event) => {
            event.preventDefault();
            if (downloadStarted) return;
            setDownloadStarted(true);
            void getPublicShareMetadata(token).then(() => {
              window.location.assign(getShareDownloadUrl(token));
            }).catch((error: unknown) => {
              setDownloadStarted(false);
              setState(isUnavailable(error) ? "unavailable" : "network-error");
            });
          }}>{downloadStarted ? "Checking link…" : "Download File"} <span aria-hidden="true">↓</span></a>
          <p className="recipient-security-note">Your download is served through DropVault’s secure file service. The countdown is informational; the link is checked again when you download.</p>
        </>}
      </section>
      <footer className="recipient-footer">DropVault <span>·</span> Temporary sharing, thoughtfully built.</footer>
    </main>
  );
}
