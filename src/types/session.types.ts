import type { Types } from "mongoose";

export type SessionType = "text" | "voice_call" | "voice_note";
export type SessionStatus = "active" | "completed" | "interrupted";

export interface ISessionSummary {
  topics: string[];
  mood_arc: { start: string; end: string };
  memory_count: number;
}

export interface ISession {
  user_id: string;
  character_id: Types.ObjectId;
  // Copied from the character at session start, never supplied by the client.
  mode: "companion" | "studio";
  session_type: SessionType;
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number;
  voice_minutes_consumed: number;
  memory_enabled: boolean;
  status: SessionStatus;
  summary: ISessionSummary | null;
}
