'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Monitor, Smartphone } from 'lucide-react';
import type { WidgetConfigFormValues } from '@/components/widget/WidgetConfigForm';
import { secondaryCtaCompactClass } from '@/lib/glass';
import { cn } from '@/lib/utils';

const PREVIEW_MSG_SOURCE = 'simplassist-widget-preview';
const PREVIEW_MSG_TYPE = 'apply-preview';

interface WidgetPreviewProps {
  businessId: string;
  refreshKey?: number;
  /** Current form values for live preview (not persisted until Save). */
  preview: WidgetConfigFormValues;
}

export function buildPreviewPayload(values: WidgetConfigFormValues) {
  return {
    brandColor: values.brand_color,
    position: values.position,
    showLogo: values.show_logo,
    logoUrl: values.logo_url || '',
    mascotColor: values.mascot_color,
    welcomeMessage: values.welcome_message,
    proactiveInvitationEnabled: values.proactive_invitation_enabled,
    forceProactiveInvitationOpen: values.proactive_invitation_enabled,
    leadCaptureEnabled: values.lead_capture_enabled,
    leadCaptureTiming: values.lead_capture_timing,
    quickReplies: values.quick_replies.filter(q => q.trim() !== ''),
  };
}

export default function WidgetPreview({ businessId, refreshKey = 0, preview }: WidgetPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const previewUrl = `/widget/preview?businessId=${encodeURIComponent(businessId)}`;

  const pushPreview = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      {
        source: PREVIEW_MSG_SOURCE,
        type: PREVIEW_MSG_TYPE,
        payload: buildPreviewPayload(preview),
      },
      '*'
    );
  }, [preview]);

  useEffect(() => {
    pushPreview();
  }, [pushPreview]);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5]">Live Preview</h2>
          <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">
            Updates as you edit — save to apply on your live site.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.open(previewUrl, '_blank')}
          className={secondaryCtaCompactClass}
        >
          <ExternalLink className="h-4 w-4" />
          Open in New Tab
        </button>
      </div>

      <div
        className="mb-3 inline-flex rounded-full border border-[#e3dacc] bg-[#faf6ef] p-1 dark:border-white/[0.12] dark:bg-white/[0.04]"
        role="group"
        aria-label="Preview device"
      >
        {([
          { value: 'desktop' as const, label: 'Desktop', icon: Monitor },
          { value: 'mobile' as const, label: 'Mobile', icon: Smartphone },
        ]).map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={device === value}
            onClick={() => setDevice(value)}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors',
              device === value
                ? 'bg-white text-stone-900 shadow-sm dark:bg-white/[0.12] dark:text-[#f5f5f5]'
                : 'text-stone-500 hover:text-stone-900 dark:text-[#bdbdbf] dark:hover:text-[#f5f5f5]',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {/* Browser window chrome */}
      <div
        className={cn(
          'overflow-hidden rounded-lg border border-[#ece4d8] shadow-sm transition-[width] dark:border-white/[0.10]',
          device === 'mobile' ? 'mx-auto w-full max-w-[390px]' : 'w-full',
        )}
        data-preview-device={device}
      >
        {/* URL bar */}
        <div className="flex items-center gap-2 bg-[#faf6ef] dark:bg-white/[0.03] border-b border-[#ece4d8] dark:border-white/[0.10] px-3 py-2">
          <div className="flex gap-1.5">
            <div className="h-3 w-3 rounded-full bg-red-400" />
            <div className="h-3 w-3 rounded-full bg-yellow-400" />
            <div className="h-3 w-3 rounded-full bg-green-400" />
          </div>
          <div className="flex-1 rounded-md bg-white dark:bg-white/[0.06] border border-[#ece4d8] dark:border-white/[0.12] px-3 py-1 text-xs text-stone-500 dark:text-[#bdbdbf] font-mono">
            yourwebsite.com
          </div>
        </div>

        {/* iframe */}
        <iframe
          key={refreshKey}
          ref={iframeRef}
          src={previewUrl}
          title="Widget Preview"
          onLoad={pushPreview}
          className={cn(
            'w-full border-0 bg-white dark:bg-white/[0.03]',
            device === 'mobile' ? 'h-[640px]' : 'h-[300px] sm:h-[460px]',
          )}
        />
      </div>
    </div>
  );
}
