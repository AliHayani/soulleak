-- Soulleak Cloud: run this once in Supabase -> SQL Editor -> New query -> Run. It is safe to run again.
-- It makes sure the vault table has one row per user and that every user can only read and write their own row.

create table if not exists public.soulleak_vaults (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  username   text,
  vault_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- If the table already existed: one row per user (the app's upsert relies on this; it still works without it).
create unique index if not exists soulleak_vaults_user_id_key on public.soulleak_vaults (user_id);

alter table public.soulleak_vaults enable row level security;

drop policy if exists "soulleak vault: read own"   on public.soulleak_vaults;
drop policy if exists "soulleak vault: insert own" on public.soulleak_vaults;
drop policy if exists "soulleak vault: update own" on public.soulleak_vaults;
drop policy if exists "soulleak vault: delete own" on public.soulleak_vaults;

create policy "soulleak vault: read own"   on public.soulleak_vaults for select to authenticated using (auth.uid() = user_id);
create policy "soulleak vault: insert own" on public.soulleak_vaults for insert to authenticated with check (auth.uid() = user_id);
create policy "soulleak vault: update own" on public.soulleak_vaults for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "soulleak vault: delete own" on public.soulleak_vaults for delete to authenticated using (auth.uid() = user_id);

-- Then check: Table Editor -> soulleak_vaults -> RLS policies should list only the four above. Policies add up, so
-- any other policy that allows "public" or "anon" to read this table would let anyone read every library: delete it.
--
-- Also keep this setting: Authentication -> Sign In / Providers -> Email -> "Confirm email" OFF. Soulleak accounts
-- use an internal address (<username>@soulleak.local) that can't receive mail, so confirmation would lock them out.
