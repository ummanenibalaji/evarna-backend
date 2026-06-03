import { AccessToken } from "livekit-server-sdk";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
import { env } from "../config/env.js";

export const VOICE_AGENT_NAME = "whisper-voice-agent";

export class LiveKitNotConfiguredError extends Error {
  constructor() {
    super("LiveKit is not configured. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL.");
    this.name = "LiveKitNotConfiguredError";
  }
}

export interface RoomTokenParams {
  roomName: string;
  participantIdentity: string;
  participantName?: string;
  ttlSeconds?: number;
}

export interface RoomTokenResult {
  token: string;
  livekit_url: string;
  room_name: string;
}

export async function generateRoomToken(params: RoomTokenParams): Promise<RoomTokenResult> {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) {
    throw new LiveKitNotConfiguredError();
  }

  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: params.participantIdentity,
    name: params.participantName ?? params.participantIdentity,
    ttl: params.ttlSeconds ?? 3600,
  });

  at.addGrant({
    roomJoin: true,
    room: params.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  // Explicitly dispatch the named voice agent to this room.
  // Required because the worker registers with `agentName`; without this
  // dispatch the agent will not auto-join the room.
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: VOICE_AGENT_NAME })],
  });

  const token = await at.toJwt();
  return {
    token,
    livekit_url: env.LIVEKIT_URL,
    room_name: params.roomName,
  };
}
