import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format } from "date-fns";
import { nanoid } from "nanoid";
import { formatPhoneForDisplay } from "@/lib/phone/display";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Display format for phone numbers across the app: "(317) 555-1234" for US
 * numbers whether stored as 10 digits or +1 E.164. Other values are returned
 * unchanged. Display only: never use the result for storage, tel: links, or
 * sending.
 */
export function formatPhoneNumber(phone: string): string {
  return formatPhoneForDisplay(phone) || phone;
}

export function formatDate(date: string | Date, formatStr: string = "PPp"): string {
  return format(new Date(date), formatStr);
}

export function generateId(size: number = 12): string {
  return nanoid(size);
}

/** First token of Supabase Auth `user_metadata.full_name`, title-cased, or null if missing. */
export function getFirstNameFromAuthMetadata(user: {
  user_metadata?: Record<string, unknown> | null;
}): string | null {
  const raw = user.user_metadata?.full_name;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const first = raw.trim().split(/\s+/)[0];
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}
