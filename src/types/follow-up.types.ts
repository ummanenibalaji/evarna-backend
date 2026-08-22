import type { Types } from "mongoose";

export type FollowUpType = "event_follow_up" | "check_in" | "milestone";
export type FollowUpStatus = "pending" | "sent" | "expired" | "suppressed";

export interface IFollowUp {
  user_id: string;
  character_id: Types.ObjectId;
  session_id: Types.ObjectId;
  hint: string;
  trigger_date: Date;
  type: FollowUpType;
  status: FollowUpStatus;
  sent_at: Date | null;
  created_at: Date;
}

/** Shape the LLM returns — every field is untrusted, hence all optional. */
export interface RawFollowUpHint {
  hint?: string;
  trigger_date?: string;
  type?: string;
  status?: string;
}
