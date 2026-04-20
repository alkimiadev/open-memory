export const formatAnomalyNotification = (
  sessionID: string,
  _type: string,
  percentage: number,
  status: string,
): string => {
  const lines: string[] = [];

  lines.push(`Context threshold reached [${status}]`);
  lines.push("");
  lines.push(`Session: ${sessionID}`);
  lines.push(`Context: ${percentage}% used`);

  if (status === "critical") {
    lines.push("");
    lines.push("Imminent automatic compaction. Consider triggering memory_compact now.");
  } else if (status === "red") {
    lines.push("");
    lines.push("Context is running low. Use memory_compact at your next natural break point.");
  } else if (status === "yellow") {
    lines.push("");
    lines.push("Context usage is getting high. Consider memory_compact when convenient.");
  }

  return lines.join("\n");
};
