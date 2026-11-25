'use client';

import { useState, useCallback } from 'react';
import type { WidgetConfig } from '@/types/database';
import WidgetConfigForm, { type WidgetConfigFormValues } from '@/components/widget/WidgetConfigForm';
import WidgetPreview from '@/components/widget/WidgetPreview';
import EmbedCodeGenerator from '@/components/widget/EmbedCodeGenerator';
import { DEFAULT_MASCOT_COLOR } from '@/components/widget/MascotColorField';
import { card } from '@/lib/theme-v2/theme';

interface WidgetPageClientProps {
  config: WidgetConfig;
  businessId: string;
  businessName: string;
  scriptOrigin: string;
}

export default function WidgetPageClient({
  config,
  businessId,
  scriptOrigin,
}: WidgetPageClientProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [previewValues, setPreviewValues] = useState<WidgetConfigFormValues>(() => ({
    brand_color: config.brand_color,
    position: config.position,
    show_logo: config.show_logo,
    logo_url: config.logo_url || '',
    mascot_color: config.mascot_color || DEFAULT_MASCOT_COLOR,
    welcome_message: config.welcome_message,
    proactive_invitation_enabled: config.proactive_invitation_enabled,
    lead_capture_enabled: config.lead_capture_enabled,
    lead_capture_timing: config.lead_capture_timing,
    quick_replies: config.quick_replies || [],
    allowed_hostnames: config.allowed_hostnames || [],
    is_active: config.is_active,
  }));

  const handlePreviewChange = useCallback((values: WidgetConfigFormValues) => {
    setPreviewValues(values);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-stone-900 dark:text-[#f5f5f5]">Website Chat Widget</h1>
        <p className="mt-1 text-stone-500 dark:text-[#bdbdbf]">Configure and embed a chat assistant on your website</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left column — config form */}
        <div className={`lg:col-span-3 p-6 ${card}`}>
          <WidgetConfigForm
            config={config}
            onSaved={() => setRefreshKey((k) => k + 1)}
            onPreviewChange={handlePreviewChange}
          />
        </div>

        {/* Right column — preview + embed code */}
        <div className="lg:col-span-2 space-y-6">
          <div className={`p-6 ${card}`}>
            <WidgetPreview businessId={businessId} refreshKey={refreshKey} preview={previewValues} />
          </div>
          <div className={`p-6 ${card}`}>
            <EmbedCodeGenerator
              businessId={businessId}
              scriptOrigin={scriptOrigin}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
