import type { Event } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";

export type ContextInfo = {
  usedTokens: number;
  limitTokens: number;
  percentage: number;
  status: "green" | "yellow" | "red" | "critical";
  model: string;
  providerID: string;
  modelID: string;
  trend: "growing" | "stable" | "unknown";
};

type SessionContextData = {
  lastInputTokens: number;
  lastTotalTokens: number;
  providerID: string;
  modelID: string;
  lastUpdateTime: number;
  previousInputTokens: number[];
};

const THRESHOLDS = {
  yellow: 0.70,
  red: 0.85,
  critical: 0.92,
} as const;

const DEFAULT_CONTEXT_LIMIT = 200_000;

export class ContextTracker {
  private sessions = new Map<string, SessionContextData>();
  private ctx: PluginInput;
  private modelContextLimits = new Map<string, number>();

  constructor(ctx: PluginInput) {
    this.ctx = ctx;
    this.loadModelLimits().catch(() => {});
  }

  private async loadModelLimits() {
    try {
      const config = await this.ctx.client.config.get();
      if (config.data) {
        const providers = config.data as Record<string, unknown>;
        if (providers && typeof providers === "object") {
          const models = (providers as Record<string, unknown>).models;
          if (models && typeof models === "object") {
            for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
              if (value && typeof value === "object") {
                const limit = (value as Record<string, unknown>).limit;
                if (limit && typeof limit === "object") {
                  const context = (limit as Record<string, unknown>).context;
                  if (typeof context === "number") {
                    this.modelContextLimits.set(key, context);
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Config not available, will use defaults
    }
  }

  handleEvent(event: Event) {
    if (event.type !== "message.updated") return;

    const props = event.properties as Record<string, unknown>;
    if (!props) return;

    const info = props.info as Record<string, unknown> | undefined;
    if (!info || info.role !== "assistant") return;

    const sessionID = info.sessionID as string | undefined;
    if (!sessionID) return;

    const tokens = info.tokens as Record<string, unknown> | undefined;
    if (!tokens) return;

    const inputTokens = typeof tokens.input === "number" ? tokens.input : 0;
    const totalTokens =
      typeof tokens.total === "number"
        ? tokens.total
        : inputTokens +
          (typeof tokens.output === "number" ? tokens.output : 0) +
          (typeof (tokens.cache as Record<string, unknown>)?.read === "number"
            ? (tokens.cache as Record<string, unknown>).read as number
            : 0) +
          (typeof (tokens.cache as Record<string, unknown>)?.write === "number"
            ? (tokens.cache as Record<string, unknown>).write as number
            : 0);

    const infoModel =
      typeof info.model === "object" && info.model !== null
        ? (info.model as Record<string, unknown>)
        : {};
    const providerID = (info.providerID ?? infoModel.providerID ?? "") as string;
    const modelID = (info.modelID ?? infoModel.modelID ?? "") as string;

    let existing = this.sessions.get(sessionID);
    if (!existing) {
      existing = {
        lastInputTokens: 0,
        lastTotalTokens: 0,
        providerID,
        modelID,
        lastUpdateTime: Date.now(),
        previousInputTokens: [],
      };
      this.sessions.set(sessionID, existing);
    }

    existing.previousInputTokens.push(existing.lastInputTokens);
    if (existing.previousInputTokens.length > 5) {
      existing.previousInputTokens.shift();
    }

    existing.lastInputTokens = inputTokens;
    existing.lastTotalTokens = totalTokens;
    existing.providerID = providerID || existing.providerID;
    existing.modelID = modelID || existing.modelID;
    existing.lastUpdateTime = Date.now();
  }

  getContextInfo(sessionID: string): ContextInfo | null {
    const data = this.sessions.get(sessionID);
    if (!data || data.lastInputTokens === 0) return null;

    const modelKey = `${data.providerID}/${data.modelID}`;
    const limitTokens =
      this.modelContextLimits.get(modelKey) ?? DEFAULT_CONTEXT_LIMIT;

    const percentage = Math.round((data.lastInputTokens / limitTokens) * 100);
    const status =
      percentage >= THRESHOLDS.critical * 100
        ? "critical"
        : percentage >= THRESHOLDS.red * 100
          ? "red"
          : percentage >= THRESHOLDS.yellow * 100
            ? "yellow"
            : "green";

    const prevTokens = data.previousInputTokens;
    let trend: ContextInfo["trend"] = "unknown";
    if (prevTokens.length >= 2) {
      const recentGrowth = prevTokens.slice(-3).reduce((acc, t, i, arr) => {
        if (i === 0) return 0;
        return acc + (t - arr[i - 1]);
      }, 0);
      trend = recentGrowth > prevTokens[prevTokens.length - 1] * 0.1 ? "growing" : "stable";
    }

    return {
      usedTokens: data.lastInputTokens,
      limitTokens,
      percentage,
      status,
      model: modelKey,
      providerID: data.providerID,
      modelID: data.modelID,
      trend,
    };
  }
}

export const startContextTracker = (ctx: PluginInput): ContextTracker => {
  return new ContextTracker(ctx);
};