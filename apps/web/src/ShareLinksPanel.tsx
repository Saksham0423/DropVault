import { useEffect, useRef, useState } from "react";
import {
  createShareLink,
  getPublicShareUrl,
  listShareLinks,
  revokeShareLink,
  type CreatedShareLink,
  type ShareLink,
  type StoredFile,
} from "./lib/api";

interface ShareLinksPanelProps {
  file: StoredFile;
  token: string;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export default function ShareLinksPanel({ file, token }: ShareLinksPanelProps) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [createError, setCreateError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<(CreatedShareLink & { url: string }) | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const fileExpiration = file.expiresAt ? Date.parse(file.expiresAt) : Date.parse(file.createdAt) + 7 * 24 * 60 * 60 * 1000;
  const fileExpired = !Number.isFinite(fileExpiration) || fileExpiration <= Date.now();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    void listShareLinks(token, file.id).then((result) => {
      if (active) {
        setLinks(result.links);
        setHasMore(result.hasMore);
      }
    }).catch((cause: unknown) => {
      if (active) setLoadError(cause instanceof Error ? cause.message : "Could not load share links.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [file.id, token]);

  async function handleCreate() {
    if (creating || fileExpired) return;
    setCreating(true);
    setCreateError("");
    setCopyMessage("");
    try {
      const created = await createShareLink(token, file.id);
      setCreatedLink({ ...created, url: getPublicShareUrl(created.token) });
      const newShare: ShareLink = {
        id: created.id,
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
        revokedAt: null,
        status: "active",
      };
      setLinks((current) => [
        newShare,
        ...current.filter((link) => link.id !== created.id),
      ].slice(0, 100));
      setHasMore((current) => current || links.length >= 100);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Could not create a share link.");
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!createdLink) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(createdLink.url);
      setCopyMessage("Link copied.");
    } catch {
      setCopyMessage("Copy was unavailable. Select the link above and copy it.");
      linkInput.current?.focus();
      linkInput.current?.select();
    }
  }

  async function handleRevoke(link: ShareLink) {
    if (link.status !== "active" || revokingId) return;
    setRevokingId(link.id);
    setLoadError("");
    try {
      await revokeShareLink(token, file.id, link.id);
      const revokedAt = new Date().toISOString();
      setLinks((current) => current.map((item) => item.id === link.id
        ? { ...item, revokedAt, status: "revoked" }
        : item));
      if (createdLink?.id === link.id) setCreatedLink(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Could not revoke this share link.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <section className="share-panel" aria-label={`Share links for ${file.originalName}`}>
      <div className="share-create">
        <span className="share-note">File and new share links expire {formatDate(new Date(fileExpiration).toISOString())}.</span>
        <button className="primary-button" type="button" onClick={() => void handleCreate()} disabled={creating || fileExpired}>
          {creating ? "Creating…" : "Create link"}
        </button>
        {fileExpired && <span className="share-note">This file has expired and cannot be shared.</span>}
      </div>

      {createError && <p className="dashboard-error" role="alert">{createError}</p>}
      {createdLink && <div className="created-share" role="status">
        <span>Share link created. Copy it now; it is only shown once.</span>
        <div className="share-copy-row">
          <input
            ref={linkInput}
            aria-label="Generated share link"
            readOnly
            value={createdLink.url}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button className="quiet-button" type="button" onClick={() => void handleCopy()}>Copy link</button>
        </div>
        {copyMessage && <span className="share-note" role="status">{copyMessage}</span>}
      </div>}

      <div className="share-list-heading"><h3>Existing links</h3></div>
      {loadError && <p className="dashboard-error" role="alert">{loadError}</p>}
      {loading ? <p className="share-note" role="status">Loading share links…</p> : links.length === 0 ? (
        <p className="share-note">No share links for this file yet.</p>
      ) : <ul className="share-list">
        {links.map((link) => <li className="share-link-row" key={link.id}>
          <div className="share-link-details">
            <strong className={`share-status status-${link.status}`}>{link.status}</strong>
            <span>Created {formatDate(link.createdAt)}</span>
            <span>Expires {formatDate(link.expiresAt)}</span>
          </div>
          {link.status === "active" && <button
            className="delete-button"
            type="button"
            disabled={revokingId !== null}
            onClick={() => void handleRevoke(link)}
            aria-label={`Revoke share link created ${formatDate(link.createdAt)}`}
          >{revokingId === link.id ? "Revoking…" : "Revoke"}</button>}
        </li>)}
      </ul>}
      {!loading && hasMore && <p className="share-note">Showing the 100 most recent links.</p>}
    </section>
  );
}
