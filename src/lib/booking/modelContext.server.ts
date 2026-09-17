import 'server-only';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { getBookingSettings } from './settings.server';
import { resolveBookingOffering } from './contracts';
export async function getBookingModelContext(businessId: string, conversationId: string) {
  const [settings, services, draft] = await Promise.all([
    getBookingSettings(businessId),
    db.from('services').select('id,name,is_active').eq('business_id', businessId).eq('is_active', true).order('name'),
    db.from('booking_drafts').select('id,revision,status,snapshot,summary_text,result').eq('business_id', businessId).eq('conversation_id', conversationId).order('revision', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (services.error || draft.error) throw new Error('booking_context_unavailable');
  return { offerings: (services.data ?? []).map(service => ({ serviceId: service.id, serviceName: service.name, offering: resolveBookingOffering(settings, service) })), currentDraft: draft.data };
}
