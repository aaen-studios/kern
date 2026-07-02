-- ═══════════════════════════════════════════════════════════════
-- kern plugin registry — Supabase schema + RLS policies
-- Run this in your Supabase project's SQL editor.
-- ═══════════════════════════════════════════════════════════════

-- 1. PROFILES — extends Supabase auth.users with GitHub metadata
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  github_user   text not null unique,
  github_avatar text,
  github_url    text,
  created_at    timestamptz default now()
);

alter table public.profiles enable row level security;

-- Anyone can read profiles (for publisher pages)
create policy "profiles_select_public"
  on public.profiles for select
  using (true);

-- Only the user can insert/update their own profile
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

-- 2. PLUGINS
create table if not exists public.plugins (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  display_name  text not null,
  description   text not null,
  author_id     uuid not null references public.profiles(id),
  category      text not null check (category in ('game-server','bot','web','database','dev-tool','other')),
  tags          text[] default '{}',
  config_schema jsonb,
  readme_md     text default '',
  repo_url      text,
  homepage_url  text,
  featured      boolean default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  install_count integer default 0,
  upvotes       integer default 0,
  screenshots   jsonb default '[]'::jsonb
);

alter table public.plugins enable row level security;

-- Anyone can read plugins
create policy "plugins_select_public"
  on public.plugins for select
  using (true);

-- Authenticated users can create plugins
create policy "plugins_insert_auth"
  on public.plugins for insert
  with check (auth.role() = 'authenticated');

-- Only the author can update their own plugins
create policy "plugins_update_owner"
  on public.plugins for update
  using (author_id = auth.uid());

-- Only the author can delete their own plugins
create policy "plugins_delete_owner"
  on public.plugins for delete
  using (author_id = auth.uid());

-- 3. PLUGIN VERSIONS
create table if not exists public.plugin_versions (
  id            uuid primary key default gen_random_uuid(),
  plugin_id     uuid not null references public.plugins(id) on delete cascade,
  version       text not null,
  kern_compat   text,
  storage_path  text not null,
  sha256        text not null,
  size_bytes    integer not null,
  changelog     text,
  created_at    timestamptz default now()
);

alter table public.plugin_versions enable row level security;

-- Anyone can read versions
create policy "versions_select_public"
  on public.plugin_versions for select
  using (true);

-- Authenticated users who own the plugin can insert versions
create policy "versions_insert_owner"
  on public.plugin_versions for insert
  with check (
    auth.role() = 'authenticated'
    and exists (
      select 1 from public.plugins
      where plugins.id = plugin_id
      and plugins.author_id = auth.uid()
    )
  );

-- Owner can delete versions
create policy "versions_delete_owner"
  on public.plugin_versions for delete
  using (
    exists (
      select 1 from public.plugins
      where plugins.id = plugin_id
      and plugins.author_id = auth.uid()
    )
  );

-- 4. UPVOTES (anonymous — tracked by browser-generated voter_id)
create table if not exists public.plugin_upvotes (
  id          uuid primary key default gen_random_uuid(),
  plugin_id   uuid not null references public.plugins(id) on delete cascade,
  voter_id    text not null,
  created_at  timestamptz default now(),
  unique(plugin_id, voter_id)
);

alter table public.plugin_upvotes enable row level security;

-- Anyone can read upvote counts
create policy "upvotes_select_public"
  on public.plugin_upvotes for select
  using (true);

-- Anyone can insert an upvote (anonymous)
create policy "upvotes_insert_public"
  on public.plugin_upvotes for insert
  with check (true);

-- Anyone can delete their own upvote (by voter_id)
create policy "upvotes_delete_own"
  on public.plugin_upvotes for delete
  using (voter_id = current_setting('app.voter_id', true));

-- 5. REPORTS (anonymous flags, emailed to admin)
create table if not exists public.plugin_reports (
  id          uuid primary key default gen_random_uuid(),
  plugin_id   uuid not null references public.plugins(id) on delete cascade,
  reason      text not null,
  reporter_ip text,
  created_at  timestamptz default now()
);

alter table public.plugin_reports enable row level security;

-- Only authenticated users can view reports
create policy "reports_select_auth"
  on public.plugin_reports for select
  using (auth.role() = 'authenticated');

-- Anyone can submit a report (anonymous)
create policy "reports_insert_public"
  on public.plugin_reports for insert
  with check (true);

-- 6. STORAGE BUCKET for .kern files
-- Run this in the Supabase Dashboard → Storage → Create bucket
-- Or uncomment and run:
-- insert into storage.buckets (id, name, public)
-- values ('plugin-kern', 'plugin-kern', true);
--
-- Then set up RLS:
-- create policy "kern_select_public"
--   on storage.objects for select
--   using (bucket_id = 'plugin-kern');
--
-- create policy "kern_insert_auth"
--   on storage.objects for insert
--   with check (bucket_id = 'plugin-kern' and auth.role() = 'authenticated');
--
-- create policy "kern_delete_owner"
--   on storage.objects for delete
--   using (
--     bucket_id = 'plugin-kern'
--     and auth.role() = 'authenticated'
--     and (storage.foldername(name))[1] = auth.uid()::text
--   );

-- 7. STORAGE BUCKET for plugin screenshots / assets
-- Run this in the Supabase Dashboard → Storage → Create bucket
-- Or uncomment and run:
-- insert into storage.buckets (id, name, public)
-- values ('plugin-assets', 'plugin-assets', true);
--
-- Then set up RLS:
-- create policy "assets_select_public"
--   on storage.objects for select
--   using (bucket_id = 'plugin-assets');
--
-- create policy "assets_insert_auth"
--   on storage.objects for insert
--   with check (bucket_id = 'plugin-assets' and auth.role() = 'authenticated');
--
-- create policy "assets_delete_owner"
--   on storage.objects for delete
--   using (
--     bucket_id = 'plugin-assets'
--     and auth.role() = 'authenticated'
--     and (storage.foldername(name))[1] = auth.uid()::text
--   );

-- 8. INDEXES
create index if not exists idx_plugins_category on public.plugins(category);
create index if not exists idx_plugins_author on public.plugins(author_id);
create index if not exists idx_plugins_created on public.plugins(created_at desc);
create index if not exists idx_plugins_upvotes on public.plugins(upvotes desc);
create index if not exists idx_plugin_versions_plugin on public.plugin_versions(plugin_id);
create index if not exists idx_plugin_upvotes_plugin on public.plugin_upvotes(plugin_id);
