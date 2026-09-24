-- Follow-ups over email (spec: Obsidian SALES-OS/INTERNAL/FLOWLEAD_FOLLOWUPS_SPEC_2026-09-24.md).
-- Adds what sending through Gmail and matching replies needs. Timing policy (fixed cadence vs
-- AI-decided) is recorded per follow-up in decided_by, so either can run without a schema change.

ALTER TYPE public.outreach_status ADD VALUE IF NOT EXISTS 'queued';
ALTER TYPE public.outreach_status ADD VALUE IF NOT EXISTS 'failed';

ALTER TABLE public.outreach_messages
  ADD COLUMN IF NOT EXISTS to_email          text,
  ADD COLUMN IF NOT EXISTS follow_up_id      uuid REFERENCES public.follow_ups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_id       uuid REFERENCES public.approvals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gmail_message_id  text,
  ADD COLUMN IF NOT EXISTS gmail_thread_id   text,
  ADD COLUMN IF NOT EXISTS sent_at           timestamptz,
  ADD COLUMN IF NOT EXISTS replied_at        timestamptz,
  ADD COLUMN IF NOT EXISTS reply_class       text,
  ADD COLUMN IF NOT EXISTS error_message     text;

ALTER TABLE public.outreach_messages
  ADD CONSTRAINT outreach_messages_reply_class_check
  CHECK (reply_class IS NULL OR reply_class IN ('interested', 'not_now', 'unsubscribe', 'out_of_office', 'other'));

-- A send callback delivered twice must not create two rows for one Gmail message.
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_messages_gmail_message
  ON public.outreach_messages (organization_id, gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;

-- Reply matching looks messages up by thread.
CREATE INDEX IF NOT EXISTS idx_outreach_messages_thread
  ON public.outreach_messages (organization_id, gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outreach_messages_follow_up
  ON public.outreach_messages (follow_up_id)
  WHERE follow_up_id IS NOT NULL;

ALTER TABLE public.follow_ups
  ADD COLUMN IF NOT EXISTS step                smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS decided_by          text NOT NULL DEFAULT 'human',
  ADD COLUMN IF NOT EXISTS outreach_message_id uuid REFERENCES public.outreach_messages(id) ON DELETE SET NULL;

ALTER TABLE public.follow_ups
  ADD CONSTRAINT follow_ups_step_check CHECK (step BETWEEN 1 AND 10),
  ADD CONSTRAINT follow_ups_decided_by_check CHECK (decided_by IN ('rule', 'ai', 'human'));
