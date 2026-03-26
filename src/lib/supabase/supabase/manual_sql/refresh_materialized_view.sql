create or replace function refresh_materialized_view(view_name text)
returns void
language plpgsql
security definer
as $$
begin
  execute format('refresh materialized view %I', view_name);
end;
$$;
