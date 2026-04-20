export const THRESHOLDS = {
  yellow: 70,
  red: 85,
  critical: 92,
} as const;

export const getStatusLabel = (percentage: number): ContextStatus => {
  if (percentage >= THRESHOLDS.critical) return "critical";
  if (percentage >= THRESHOLDS.red) return "red";
  if (percentage >= THRESHOLDS.yellow) return "yellow";
  return "green";
};

export type ContextStatus = "green" | "yellow" | "red" | "critical";