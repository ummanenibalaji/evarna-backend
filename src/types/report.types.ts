import type { Types } from "mongoose";

export type ReportReason =
  | "harmful"
  | "sexual"
  | "inappropriate_minor"
  | "inaccurate"
  | "other";

export type ReportStatus = "open" | "reviewed" | "actioned";

export interface IReport {
  user_id: string;
  turn_id: Types.ObjectId;
  session_id: Types.ObjectId;
  character_id: Types.ObjectId;
  reason: ReportReason;
  note?: string;
  content_snapshot: string;
  status: ReportStatus;
  created_at: Date;
}
