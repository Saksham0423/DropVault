export const uploadExpiryOptions = [
  { value: "1h", label: "1 Hour", milliseconds: 60 * 60 * 1000 },
  { value: "24h", label: "24 Hours", milliseconds: 24 * 60 * 60 * 1000 },
  { value: "3d", label: "3 Days", milliseconds: 3 * 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7 Days", milliseconds: 7 * 24 * 60 * 60 * 1000 },
] as const;

export type UploadExpiryPreset = typeof uploadExpiryOptions[number]["value"];
export type UploadExpiryChoice = UploadExpiryPreset | "custom";
export const maxUploadLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1000;

export function getPresetExpiration(preset: UploadExpiryPreset, now = Date.now()): string {
  const option = uploadExpiryOptions.find((item) => item.value === preset);
  if (!option) throw new Error("Choose a valid expiration duration.");
  return new Date(now + option.milliseconds).toISOString();
}

export function customExpirationToIso(value: string): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) throw new Error("Enter a valid custom expiration date and time.");
  if (timestamp <= Date.now()) throw new Error("Choose an expiration time in the future.");
  if (timestamp > Date.now() + maxUploadLifetimeMilliseconds) throw new Error("Files can only be kept for up to 7 days.");
  return new Date(timestamp).toISOString();
}

export function toDateTimeLocalValue(timestamp: number): string {
  const localDate = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}
