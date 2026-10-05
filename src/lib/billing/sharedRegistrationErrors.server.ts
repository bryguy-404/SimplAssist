import "server-only";
import { SharedRegistrationError } from "@/lib/messaging/sharedBusinessRegistrations.server";
import { ReviewSmsError } from "./reviewSms";
import { TextingUpgradeError } from "./textingUpgrade";

export async function reviewShared<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch (error) {
    if (error instanceof SharedRegistrationError) throw new ReviewSmsError(error.code, error.status);
    throw error;
  }
}

export async function upgradeShared<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch (error) {
    if (error instanceof SharedRegistrationError) throw new TextingUpgradeError(error.code, error.status);
    throw error;
  }
}
