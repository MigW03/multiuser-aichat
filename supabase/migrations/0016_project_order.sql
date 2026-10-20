-- Per-person order of the projects list. Each person orders their own list; nobody else sees or changes it.
--
-- The order lives on the person's own project_members row. A row with no order yet (null) sorts first, newest joined
-- first, so a new or just-joined project lands at the top. Moving any project saves the whole list as 0..n-1.
-- Writes go through the server (service role), like every other project change.

alter table public.project_members add column sort_order int check (sort_order is null or sort_order between 0 and 1000);

-- Same columns as before; only the order of the rows changes.
create or replace function public.project_list()
returns table (
  id uuid, name text, created_by uuid, created_at timestamptz, my_role text, member_count int, unread_people int, unread_ai int
)
language sql stable security invoker set search_path = '' as $$
  select p.id, p.name, p.created_by, p.created_at, pm.role,
         (select count(*)::int from public.project_members x where x.project_id = p.id),
         coalesce(sum(u.people), 0)::int, coalesce(sum(u.ai), 0)::int
    from public.projects p
    join public.project_members pm on pm.project_id = p.id and pm.user_id = (select auth.uid())
    left join public.chats c on c.project_id = p.id
    left join public.chat_unread u on u.chat_id = c.id
   group by p.id, pm.role, pm.sort_order, pm.joined_at
   order by pm.sort_order nulls first, pm.joined_at desc, p.id
$$;

-- Saves the caller's order: p_ids is their projects, first to last. Ids they are not a member of are ignored.
create function public.app_reorder_projects(p_user uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_ids is null or cardinality(p_ids) > 1000 then raise exception 'invalid_scope'; end if;
  if (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) then raise exception 'invalid_scope'; end if;
  update public.project_members pm
     set sort_order = o.ord::int - 1
    from unnest(p_ids) with ordinality as o(id, ord)
   where pm.user_id = p_user and pm.project_id = o.id;
end;
$$;

revoke execute on function public.app_reorder_projects(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.app_reorder_projects(uuid, uuid[]) to service_role;
