import type { Types } from "mongoose";

export type TurnRole = "user" | "assistant";

export interface ISafetyFlags {
  categories: Record<string, unknown>;
  flagged: boolean;
}

export interface ITokensUsed {
  input: number;
  output: number;
}

export interface IConversationTurn {
  session_id: Types.ObjectId;
  character_id: Types.ObjectId;
  user_id: string;
  role: TurnRole;
  content_text: string;
  content_audio_url: string | null;
  sentiment_score: number;
  safety_flags: ISafetyFlags;
  tokens_used: ITokensUsed;
  model_used: string;
  latency_ms: number;
  created_at: Date;
}
