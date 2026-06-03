export interface IMemoryBlock {
  facts: string[];
  compressed: string;
  token_count: number;
}

export interface IPromptContext {
  system_prompt: string;
  memory_block: IMemoryBlock | null;
  usage_summary: string | null;
  session_context: string;
  user_message: string;
}

export interface IRedisSessionContext {
  compressed_summary: string;
  turns: Array<{ role: string; content: string }>;
  total_token_count: number;
}
