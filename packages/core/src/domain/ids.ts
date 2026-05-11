import { customAlphabet } from "nanoid";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const nanoid12 = customAlphabet(alphabet, 12);

export function generateId(prefix: string): string {
  return `${prefix}_${nanoid12()}`;
}

export const agentId = (): string => generateId("agent");
export const taskId = (): string => generateId("task");
export const sessionId = (): string => generateId("sess");
export const personId = (): string => generateId("person");
export const blockId = (): string => generateId("block");
export const workProductId = (): string => generateId("wp");
export const factId = (): string => generateId("fact");
export const negotiationId = (): string => generateId("neg");
export const negotiationRoundId = (): string => generateId("round");
export const escalationId = (): string => generateId("esc");
export const promotionEventId = (): string => generateId("mpe");
export const sessionEventId = (): string => generateId("evt");
export const daemonId = (): string => generateId("dmn");
export const runtimeId = (): string => generateId("rt");
export const roomId = (): string => generateId("room");
export const roomMessageId = (): string => generateId("rmsg");
export const agentProvisionEventId = (): string => generateId("ape");
