-- =====================================================================
-- Last Person Standing - let a player delete their own account
-- Run AFTER 009_messages.sql. Safe to run again.
-- =====================================================================

-- Deleting the login removes the profile too, and with it their game entries,
-- picks, credit history and email log. With no profile they can't be emailed.
-- The last host can't leave, because then nobody could run the game.
create or replace function public.deactivate_my_account() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Please log in again.'; end if;
  if public.is_host()
     and not exists (select 1 from public.profiles where role = 'host' and id <> auth.uid()) then
    raise exception 'You are the only host. Make someone else a host first.';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.deactivate_my_account() from public, anon;
grant execute on function public.deactivate_my_account() to authenticated;
