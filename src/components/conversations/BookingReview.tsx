'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { bookingStatusLabel, bookingTextStatus, type BookingReview } from '@/lib/booking/review';
import { body, ink } from '@/lib/theme-v2/theme';
export function BookingReviewPanel({ conversationId }: { conversationId: string }) {
  const [state,setState] = useState<{ id: string; items?: BookingReview[]; error?: boolean }>({id:conversationId});
  const [refresh,setRefresh] = useState(0);
  useEffect(()=>{
    const controller = new AbortController();
    setState({id:conversationId});
    void (async()=>{
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/bookings`,{cache:'no-store',signal:controller.signal});
        const result = await response.json();
        if (!response.ok || result.conversationId!==conversationId || !Array.isArray(result.bookings)) throw new Error('unavailable');
        if (!controller.signal.aborted) setState({id:conversationId,items:result.bookings});
      } catch { if (!controller.signal.aborted) setState({id:conversationId,error:true}); }
    })();
    return ()=>controller.abort();
  },[conversationId,refresh]);
  const current = state.id===conversationId ? state : null;
  if (current?.items?.length === 0) return null;
  return <details className={`mb-4 rounded-xl border border-stone-200 p-3 dark:border-white/10 ${body}`}>
    <summary className={`cursor-pointer text-sm font-medium ${ink}`}>Appointment details{current?.items?.length ? ` (${current.items.length})` : ''}</summary>
    <button type="button" className="my-3 text-sm underline" onClick={()=>setRefresh(r=>r+1)}>Refresh appointment details</button>
    {current?.error ? <p role="alert">Could not load appointment details. Please refresh.</p> : !current?.items ? <p role="status">Loading appointment details…</p> : !current.items.length ? <p className="text-sm">No appointment details recorded in this conversation.</p> : current.items.map(item=><article key={item.id} className="mb-3 space-y-2 rounded-lg border border-stone-200 p-3 text-sm [overflow-wrap:anywhere] dark:border-white/10">
      <h4 className={`font-semibold ${ink}`}>{bookingStatusLabel(item.status)}</h4>
      <p>{item.snapshot.offering.label}: {item.snapshot.offering.serviceName} · {item.snapshot.offering.durationMinutes} minutes</p>
      <p>{item.snapshot.startTime?.replace('T',' ') || item.snapshot.requestedTime || 'Time not specified'} ({item.snapshot.timezone})</p>
      <p>{item.snapshot.offering.format==='phone_callback' ? `Business callback to ${item.snapshot.phone || 'phone not provided'}` : item.snapshot.offering.format==='business_visit' ? `Business visit: ${item.snapshot.offering.businessAddress}` : item.snapshot.offering.format==='customer_site' ? `Customer site: ${item.snapshot.customerAddress || 'address not provided'}` : 'Location not specified'}</p>
      <p>{item.snapshot.name || 'Name not provided'} · {item.snapshot.phone || 'Phone not provided'} · {item.snapshot.email || 'No email invitation'}</p>
      <p className="text-xs">Details recorded for this appointment; the saved contact may differ. {item.snapshot.mode==='collect_info' ? 'This request is not a confirmed appointment.' : item.status==='confirmed' && item.snapshot.email ? 'A calendar invitation was requested; email delivery is not verified here.' : ''}</p>
      {item.notifications.map(n=><p key={n.id}>{n.purpose==='review'?'Review text':'Confirmation text'}: {bookingTextStatus(n.status)} {n.conversationId ? <Link className="underline" href={`/conversations?conversation=${encodeURIComponent(n.conversationId)}`}>View text</Link> : null}</p>)}
    </article>)}
  </details>;
}
