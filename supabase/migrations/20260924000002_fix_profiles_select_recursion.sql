-- profiles_select looked up the caller's profile with a subquery on profiles itself, so any
-- read through a user (RLS) client raised "infinite recursion detected in policy for relation
-- profiles". The app worked around it by reading profiles with the service role everywhere.
-- Same rule, same meaning: you can read your own profile and the profiles of people who share
-- an active organization with you. The membership lookup moves into a SECURITY DEFINER
-- helper (like app.is_member), which reads profiles without re-entering this policy.

CREATE OR REPLACE FUNCTION app.shares_org_with(target_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships mine
    JOIN public.profiles me ON me.id = mine.profile_id
    JOIN public.memberships theirs ON theirs.organization_id = mine.organization_id
    WHERE me.user_id = auth.uid()
      AND theirs.profile_id = target_profile_id
      AND mine.status = 'active'
      AND theirs.status = 'active'
  )
$$;


DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT
  USING (user_id = auth.uid() OR app.shares_org_with(id));
