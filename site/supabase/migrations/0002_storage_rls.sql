-- 0002_storage_rls.sql
--
-- Storage policies for the plugin registry buckets.
--
-- The original migration left these as "run this in the dashboard" comments,
-- so a fresh project (and the browser upload flow) denied every write with
-- `new row violates row-level security policy`.
--
-- Path layout: browser uploads are prefixed with the uploader's auth uid
-- (`<uid>/<pluginId>/<version>/plugin.kern` and
-- `<uid>/<pluginId>/screenshots/<file>`), so writes scope to the owner by the
-- first path segment — no join against public.plugins required.

-- ── buckets (public read; downloads use signed URLs regardless) ────────────

insert into storage.buckets (id, name, public)
values ('plugin-kern', 'plugin-kern', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('plugin-assets', 'plugin-assets', true)
on conflict (id) do nothing;

-- ── plugin-kern: .kern packages ────────────────────────────────────────────

drop policy if exists "kern_select_public" on storage.objects;
create policy "kern_select_public"
  on storage.objects for select
  using (bucket_id = 'plugin-kern');

drop policy if exists "kern_insert_own" on storage.objects;
create policy "kern_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'plugin-kern'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- `upload(..., { upsert: true })` performs an update on conflict, so the
-- update policy is required alongside insert.
drop policy if exists "kern_update_own" on storage.objects;
create policy "kern_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'plugin-kern'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "kern_delete_own" on storage.objects;
create policy "kern_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'plugin-kern'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── plugin-assets: screenshots and imagery ─────────────────────────────────

drop policy if exists "assets_select_public" on storage.objects;
create policy "assets_select_public"
  on storage.objects for select
  using (bucket_id = 'plugin-assets');

drop policy if exists "assets_insert_own" on storage.objects;
create policy "assets_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'plugin-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "assets_update_own" on storage.objects;
create policy "assets_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'plugin-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "assets_delete_own" on storage.objects;
create policy "assets_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'plugin-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
