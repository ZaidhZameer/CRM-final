-- The stale-job sweep aged queued jobs from created_at. A job that waited in awaiting_approval
-- and was then approved became "queued" with an old created_at, and the next sweep failed it
-- immediately. queued_at records when a job actually entered the queue, whatever put it there
-- (initial insert, decide_approval, or a retry).

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS queued_at timestamptz;

UPDATE public.jobs SET queued_at = created_at WHERE status = 'queued' AND queued_at IS NULL;

CREATE OR REPLACE FUNCTION app.stamp_job_queued_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'queued' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'queued') THEN
    NEW.queued_at := now();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS jobs_stamp_queued_at ON public.jobs;
CREATE TRIGGER jobs_stamp_queued_at
  BEFORE INSERT OR UPDATE OF status ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION app.stamp_job_queued_at();
