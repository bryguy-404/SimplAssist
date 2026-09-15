#!/usr/bin/env node
// Read-only: never admits a call, sends a message, starts a paid voice session,
// changes pilot settings, or applies migrations. Only print redacted checks.
import { createClient } from '@supabase/supabase-js';
import Telnyx from 'telnyx';

const businessId = 'ea848911-ef72-44a6-8cf3-c47b3959be26';
const phone = '+15742638634';
const schemaOnly = process.argv.includes('--schema-only');
if (process.argv.slice(2).some(arg => arg !== '--schema-only')) {
  throw new Error('Supported option: --schema-only. Load credentials securely through the environment.');
}
const checks = [];
class CheckError extends Error {}
async function check(name, work) {
  try { await work(); checks.push({ check: name, pass: true }); }
  catch (error) { checks.push({ check: name, pass: false, issue: error instanceof CheckError ? error.message : 'Request failed; inspect credentials and service health' }); }
}
function need(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new CheckError(`Configure ${name}`);
  return value;
}
function requireValue(ok, message) { if (!ok) throw new CheckError(message); }
async function request(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(7500) });
  requireValue(response.ok, `HTTP ${response.status}`);
  return response;
}
const url = need('NEXT_PUBLIC_SUPABASE_URL');
const serviceKey = need('SUPABASE_SERVICE_ROLE_KEY');
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, global: {
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(7500) }),
} });
const tables = {
  voice_pilot_settings: 'business_id,enabled,budget_seconds,revision',
  voice_pilot_testers: 'business_id,phone_number',
  voice_sessions: 'id,response_mode,reserved_seconds,usage_confirmed,phone_ended_at,recording_checked_at,provider_hangup_confirmed_at',
  voice_stream_credentials: 'token_hash,consumed_at,expires_at',
  voice_transcript_fragments: 'session_id,event_id,start_ms,end_ms',
  voice_provider_usage: 'session_id,provider_request_id,estimated_cost_usd',
  voice_recordings: 'recording_id,delete_after,lease_token,next_attempt_at',
  voice_pilot_audit: 'id,admin_id',
  voice_pilot_totals: 'business_id,committed_seconds,unconfirmed_calls',
};
for (const [table, fields] of Object.entries(tables)) await check(`Schema: ${table}`, async () => {
  const { error } = await db.from(table).select(fields).limit(0);
  requireValue(!error, 'Apply and verify migrations 069–072');
});
await check('Required voice RPCs are deployed', async () => {
  const response = await request(new URL('/rest/v1/', url), { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/openapi+json' });
  const api = await response.json();
  for (const name of ['admit_voice_pilot','consume_voice_stream','record_voice_fragment','update_voice_usage','activate_voice_session','finalize_voice_session','configure_voice_pilot','stop_voice_pilot','reconcile_voice_usage','claim_voice_recording_cleanup','finish_voice_recording_cleanup','reconcile_unstarted_voice_sessions','estimate_voice_telnyx_usage']) {
    requireValue(api.paths?.[`/rpc/${name}`], `Missing RPC: ${name}`);
  }
});
await check('Public clients cannot read stream credentials', async () => {
  const anon = need('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const response = await fetch(new URL('/rest/v1/voice_stream_credentials?select=token_hash&limit=0', url), {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` }, signal: AbortSignal.timeout(7500), redirect: 'error',
  });
  requireValue([401,403].includes(response.status), 'Expected a permission denial');
});
await check('Existing number belongs to the designated pilot account', async () => {
  const { data, error } = await db.from('phone_numbers').select('business_id,is_active').eq('phone_number', phone).single();
  requireValue(!error && data?.business_id === businessId && data.is_active, 'Number assignment or activation does not match the approved pilot');
});
await check('Pilot is initialized with bounded limits', async () => {
  const { data, error } = await db.from('voice_pilot_settings').select('budget_seconds,max_call_seconds,max_concurrent_calls,enabled').eq('business_id', businessId).single();
  requireValue(!error && data && data.budget_seconds >= 0 && data.max_call_seconds <= 600 && data.max_concurrent_calls <= 2, 'Pilot settings are missing or outside approved operating limits');
  checks.push({ check: 'Current routing switch', value: data.enabled ? 'Enabled' : 'Disabled' });
});
if (!schemaOnly) {
  await check('OpenAI GPT-Live model access', async () => {
    await request('https://api.openai.com/v1/models/gpt-live-1', { Authorization: `Bearer ${need('OPENAI_API_KEY')}` });
  });
  await check('Claude answering model access', async () => {
    await request('https://api.anthropic.com/v1/models/claude-haiku-4-5-20251001', { 'x-api-key': need('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' });
  });
  await check('Existing Telnyx callback routing', async () => {
    const { data, error } = await db.from('businesses').select('telnyx_voice_application_id').eq('id', businessId).single();
    requireValue(!error && data?.telnyx_voice_application_id, 'Business voice application missing');
    const client = new Telnyx({ apiKey: need('TELNYX_API_KEY'), timeout: 7500, maxRetries: 0 });
    const app = (await client.callControlApplications.retrieve(data.telnyx_voice_application_id)).data;
    requireValue(app?.webhook_event_url === 'https://simplassist.com/api/messaging/voice', 'Callback differs from the approved existing URL');
  });
  await check('Voice service and durable maintenance are ready', async () => {
    const endpoint = new URL('/ready', need('VOICE_SERVICE_URL'));
    requireValue(endpoint.protocol === 'https:', 'Voice service must use HTTPS');
    const token = need('VOICE_INTERNAL_TOKEN');
    requireValue(token.length >= 32 && need('VOICE_STREAM_SECRET').length >= 32, 'Voice credentials need at least 32 characters');
    const response = await request(endpoint, { Authorization: `Bearer ${token}` });
    const body = await response.json();
    requireValue(body.ready === true && body.model === 'gpt-live-1' && body.profile === (process.env.VOICE_AUDIO_PROFILE || 'pcm16'), 'Worker model, audio profile or maintenance readiness mismatch');
  });
  await check('Approved tester numbers are configured', async () => {
    const { count, error } = await db.from('voice_pilot_testers').select('phone_number', { count: 'exact', head: true }).eq('business_id', businessId);
    requireValue(!error && count > 0, 'Enter approved testers through /admin/voice');
  });
  checks.push({ check: 'Application rollout setting', value: process.env.VOICE_PILOT_ROLLOUT === 'true' ? 'Configured for internal pilot' : 'Disabled' });
}
console.log(JSON.stringify({ readOnly: true, checks, pass: checks.every(c => c.pass !== false) }, null, 2));
if (checks.some(c => c.pass === false)) process.exitCode = 1;
