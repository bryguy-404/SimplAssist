import 'server-only';

export interface OwnerAlertConfig {
  enabled: boolean; sender: string | null; profileId: string | null; campaignId: string | null;
  pilotBusinessIds: string[] | null;
}
export function getOwnerAlertConfig(env: NodeJS.ProcessEnv = process.env): OwnerAlertConfig {
  const sender = /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(env.OWNER_BOOKING_ALERTS_SENDER_E164 ?? '') ? env.OWNER_BOOKING_ALERTS_SENDER_E164! : null;
  const profileId = env.OWNER_BOOKING_ALERTS_MESSAGING_PROFILE_ID?.trim() || null;
  const campaignId = env.OWNER_BOOKING_ALERTS_CAMPAIGN_ID?.trim() || null;
  const pilotRaw = env.OWNER_BOOKING_ALERTS_PILOT_BUSINESS_IDS?.trim() ?? '';
  const pilot = pilotRaw ? pilotRaw.split(',').map(x => x.trim()) : null;
  // A typo in a pilot list must never expand the rollout to every business.
  const validPilot = pilot === null || pilot.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  return {
    enabled: env.OWNER_BOOKING_ALERTS_ENABLED === 'true' && env.OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED === 'true' && validPilot && !!sender && !!profileId && !!campaignId && !!env.TELNYX_API_KEY && !!env.TELNYX_PUBLIC_KEY,
    sender, profileId, campaignId, pilotBusinessIds: pilot,
  };
}
export interface OwnerAlertControl { enabled: boolean; sender: string | null; messaging_profile_id: string | null; pilot_business_ids: string[] | null }
export function ownerAlertReady(config: OwnerAlertConfig, control: OwnerAlertControl | null, businessId?: string): boolean {
  return config.enabled && control?.enabled === true && config.sender === control.sender && config.profileId === control.messaging_profile_id
    && (!businessId || ((!config.pilotBusinessIds || config.pilotBusinessIds.includes(businessId)) && (!control.pilot_business_ids || control.pilot_business_ids.includes(businessId))));
}
