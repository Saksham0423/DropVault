create extension if not exists pgcrypto;

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  storage_path text not null unique,
  original_name text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  created_at timestamptz not null default now()
);

create index if not exists files_owner_created_at_idx
  on public.files (owner_id, created_at desc);

create table if not exists public.share_links (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index if not exists share_links_file_id_idx
  on public.share_links (file_id);
create index if not exists share_links_active_expiry_idx
  on public.share_links (expires_at)
  where revoked_at is null;

alter table public.files enable row level security;
alter table public.share_links enable row level security;

create policy "Owners can manage their files"
  on public.files for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "Owners can manage links for their files"
  on public.share_links for all
  using (
    exists (
      select 1 from public.files
      where files.id = share_links.file_id and files.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.files
      where files.id = share_links.file_id and files.owner_id = auth.uid()
    )
  );
