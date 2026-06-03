import type { Types } from "mongoose";

export type MemoryType = "fact" | "emotion" | "event" | "preference";

export interface IFollowUpHint {
  hint: string;
  trigger_date: Date;
  type: string;
  status: string;
}

export interface IMoodAssessment {
  distress_level: string;
  should_follow_up: boolean;
  follow_up_delay_hours: number;
}

export interface IMemory {
  user_id: string;
  character_id: Types.ObjectId;
  content: string;
  type: MemoryType;
  sentiment: string;
  embedding: number[];   // 1536 floats — text-embedding-3-small
  source_session_id: Types.ObjectId;
  related_entities: string[];
  access_count: number;
  last_accessed_at: Date;
  is_deleted: boolean;
  created_at: Date;
}

export interface IMemorySummary {
  user_id: string;
  character_id: Types.ObjectId;
  trigger_type: "turn_count" | "session_count";
  turns_covered: number;
  sessions_covered: number;
  since_turn_id: Types.ObjectId;
  until_turn_id: Types.ObjectId;
  mood_summary: string;
  recurring_topics: string[];
  emotional_patterns: Record<string, unknown>;
  relationship_trajectory: string;
  new_facts_count: number;
  follow_up_hints: IFollowUpHint[];
  mood_assessment: IMoodAssessment;
  created_at: Date;
}
