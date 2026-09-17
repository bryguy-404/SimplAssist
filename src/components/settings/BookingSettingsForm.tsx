'use client';
import { useEffect, useState } from 'react';
import { bookingSettingsUpdateSchema, type BookingOffering, type BookingSettings } from '@/lib/booking/contracts';
import { card } from '@/lib/theme-v2/theme';

const initial: BookingOffering = { format: 'phone_callback', label: 'Appointment', durationMinutes: 30, businessAddress: null };
const inputClass = 'w-full rounded-xl border border-stone-300 bg-transparent px-3 py-2 dark:border-white/20';
export function BookingOfferingFields({ value, onChange, prefix }: { value: BookingOffering; onChange: (value: BookingOffering) => void; prefix: string }) {
  return <div className="grid gap-4 sm:grid-cols-2">
    <label htmlFor={`${prefix}-format`}>Appointment format<select id={`${prefix}-format`} className={inputClass} value={value.format} onChange={e => onChange({ ...value, format: e.target.value as BookingOffering['format'], businessAddress: e.target.value === 'business_visit' ? '' : null })}>
      <option value="phone_callback">Phone callback</option><option value="business_visit">Customer visits your business</option><option value="customer_site">Visit the customer’s location</option>
    </select></label>
    <label htmlFor={`${prefix}-label`}>Appointment name<input id={`${prefix}-label`} className={inputClass} value={value.label} maxLength={240} onChange={e => onChange({ ...value, label: e.target.value })} placeholder="Estimate or consultation" /></label>
    <label htmlFor={`${prefix}-duration`}>Duration<select id={`${prefix}-duration`} className={inputClass} value={value.durationMinutes} onChange={e => onChange({ ...value, durationMinutes: Number(e.target.value) })}>
      {[30,60,90,120,150,180,210,240].map(minutes => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
    </select></label>
    {value.format === 'business_visit' && <label htmlFor={`${prefix}-address`}>Address customers should visit<input id={`${prefix}-address`} className={inputClass} value={value.businessAddress ?? ''} maxLength={500} onChange={e => onChange({ ...value, businessAddress: e.target.value })} /></label>}
    <p className="text-sm text-stone-500 dark:text-stone-400 sm:col-span-2">{value.format === 'phone_callback' ? 'A callback reserves time for your business to call the customer. SimplAssist does not place the call.' : value.format === 'customer_site' ? 'The assistant will ask for the customer’s address before confirming a direct booking.' : 'Use an address you want customers to receive. Your billing address is not used automatically.'}</p>
  </div>;
}
export default function BookingSettingsForm({ services }: { services: Array<{ id: string; name: string; is_active: boolean }> }) {
  const [settings, setSettings] = useState<BookingSettings | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/settings/booking', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSettings(data.booking);
    } catch { setError('Could not load booking settings. Please refresh.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function save() {
    if (!settings) return;
    const input = bookingSettingsUpdateSchema.safeParse({ expectedRevision: settings.revision, defaults: settings.defaults, services: settings.services });
    if (!input.success) { setError('Choose an appointment format, name, duration and any required address.'); return; }
    setBusy(true); setError(''); setSaved(false);
    try {
      const response = await fetch('/api/settings/booking', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.data) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSettings(data.booking); setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save booking settings.'); }
    finally { setBusy(false); }
  }
  return <section className={`p-6 space-y-4 ${card}`} aria-label="Booking details">
    <h2 className="text-lg font-semibold">Booking details</h2>
    <p className="text-sm">Choose what customers book. Your AI booking mode still decides whether to collect a request or confirm a calendar appointment.</p>
    {error && <p role="alert">{error}</p>}
    {!settings ? <button type="button" onClick={() => void load()} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</button> : <>
      {!settings.defaults && <p role="status">Your existing appointments use 30 minutes and no specified location. Choose a format below to update them.</p>}
      <fieldset disabled={busy} className="space-y-4">
        <BookingOfferingFields prefix="booking-default" value={settings.defaults ?? initial} onChange={defaults => { setSaved(false); setSettings({ ...settings, defaults }); }} />
        {!settings.defaults && <button type="button" className="underline" onClick={() => setSettings({ ...settings, defaults: initial })}>Use phone callbacks as the default</button>}
        {services.filter(s => s.is_active).map(service => {
          const override = settings.services.find(s => s.serviceId === service.id)?.setting ?? { mode: 'inherit' as const };
          function update(setting: BookingSettings['services'][number]['setting']) {
            setSaved(false); setSettings(current => current && ({ ...current, services: [...current.services.filter(s => s.serviceId !== service.id), { serviceId: service.id, setting }] }));
          }
          return <div key={service.id} className="space-y-3 border-t border-stone-300 pt-4 dark:border-white/10">
            <label htmlFor={`service-booking-${service.id}`}>{service.name}<select id={`service-booking-${service.id}`} className={inputClass} value={override.mode} onChange={e => update(e.target.value === 'override' ? { mode: 'override', offering: settings.defaults ?? initial } : { mode: e.target.value as 'inherit' | 'unavailable' })}>
              <option value="inherit">Use business defaults</option><option value="override">Custom appointment details</option><option value="unavailable">Not available for direct booking</option>
            </select></label>
            {override.mode === 'override' && <BookingOfferingFields prefix={`booking-${service.id}`} value={override.offering} onChange={offering => update({ mode: 'override', offering })} />}
          </div>;
        })}
        <div className="flex gap-4"><button type="button" className="rounded-full bg-orange-500 px-4 py-2 text-black" onClick={() => void save()}>Save booking details</button><button type="button" onClick={() => void load()}>Refresh</button></div>
      </fieldset>
      {saved && <p role="status">Booking details saved.</p>}
    </>}
  </section>;
}
