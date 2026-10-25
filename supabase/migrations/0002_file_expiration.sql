alter table public.files
  add column if not exists expires_at timestamptz;

create index if not exists files_expiration_idx
  on public.files (expires_at)
  where expires_at is not null;
