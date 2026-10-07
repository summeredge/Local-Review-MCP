import { z } from "zod";

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

export interface ModelCatalogEntry {
  readonly model_id: string;
  readonly display_name: string;
  readonly aliases: readonly string[];
  readonly reasoning_efforts: readonly ReasoningEffort[];
}

const gpt6Efforts: readonly ReasoningEffort[] = REASONING_EFFORTS;

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    model_id: "gpt-5.6-luna",
    display_name: "GPT-5.6 Luna",
    aliases: ["luna 5.6", "5.6 luna"],
    reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    model_id: "gpt-6-luna",
    display_name: "GPT-6 Luna",
    aliases: ["luna", "luna 6"],
    reasoning_efforts: gpt6Efforts,
  },
  {
    model_id: "gpt-6-astra",
    display_name: "GPT-6 Astra",
    aliases: ["astra"],
    reasoning_efforts: gpt6Efforts,
  },
  {
    model_id: "gpt-6.1-sol",
    display_name: "GPT-6.1 Sol",
    aliases: ["sol"],
    reasoning_efforts: gpt6Efforts,
  },
];
