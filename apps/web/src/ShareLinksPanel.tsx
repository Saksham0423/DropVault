import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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

const expirationChoices = [
  { value: "1h", label: "1 hour", milliseconds: 60 * 60 * 1000 },
  { value: "1d", label: "1 day", milliseconds: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7 days", milliseconds: 7 * 24 * 60 * 60 * 1000 },
] as const;

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function getExpiration(file: StoredFile, choice: string): string {
  if (choice === "file-expiration" && file.expiresAt) return new Date(file.expiresAt).toISOString();
  const selected = expirationChoices.find((option) => option.value === choice);
  return new Date(Date.now() + (selected?.milliseconds ?? expirationChoices[1].milliseconds)).toISOString();
}

export default function ShareLinksPanel({ file, token }: ShareLinksPanelProps) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [createError, setCreateError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [expirationChoice, setExpirationChoice] = useState("1d");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<(CreatedShareLink & { url: string }) | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const fileExpiration = file.expiresAt ? new Date(file.expiresAt).getTime() : null;
  const fileExpired = fileExpiration !== null && fileExpiration <= Date.now();
  const availableChoices = useMemo(() => {
    const choices: Array<{ value: string; label: string; milliseconds: number }> = expirationChoices.filter((choice) => (
      fileExpiration === null || Date.now() + choice.milliseconds <= fileExpiration
    ));
    if (fileExpiration !== null && !fileExpired) {
      choices.push({ value: "file-expiration", label: "When the file expires", milliseconds: 0 });
    }
    return choices;
  }, [fileExpiration, fileExpired]);

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

  useEffect(() => {
    if (!availableChoices.some((choice) => choice.value === expirationChoice)) {
      setExpirationChoice(availableChoices[0]?.value ?? "1d");
    }
  }, [availableChoices, expirationChoice]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || fileExpired || availableChoices.length === 0) return;
    setCreating(true);
    setCreateError("");
    setCopyMessage("");
    try {
      const created = await createShareLink(token, file.id, getExpiration(file, expirationChoice));
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
      <form className="share-create" onSubmit={(event) => void handleCreate(event)}>
        <label htmlFor={`share-expiration-${file.id}`}>Link expires
          <select
            id={`share-expiration-${file.id}`}
            value={expirationChoice}
            onChange={(event) => setExpirationChoice(event.target.value)}
            disabled={creating || fileExpired || availableChoices.length === 0}
          >
            {availableChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
        </label>
        <button className="primary-button" type="submit" disabled={creating || fileExpired || availableChoices.length === 0}>
          {creating ? "Creating…" : "Create link"}
        </button>
        {fileExpired && <span className="share-note">This file has expired and cannot be shared.</span>}
        {!fileExpired && availableChoices.length === 0 && <span className="share-note">No valid expiration option is available.</span>}
      </form>

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
