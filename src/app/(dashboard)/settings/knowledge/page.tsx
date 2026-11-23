import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import WebsiteKnowledgeManager from '@/components/settings/WebsiteKnowledgeManager';
import { canUseFeature } from '@/lib/billing/entitlements';
import { getDashboardEntitledContext } from '@/lib/dashboard/context';
import { requireWorkspacePageAccess } from '@/lib/customer/workspaceRouteResponse.server';
import type { ServicesAndFaqsValues } from '@/lib/onboarding/servicesAndFaqsDefaults';
import type { BusinessType } from '@/types/database';
import { isRicherWebsiteScanEnabledForBusiness } from '@/lib/website-scans/rollout.server';

export default async function AssistantKnowledgePage() {
  await requireWorkspacePageAccess();
  const context = await getDashboardEntitledContext();
  if (context.status === 'unauthenticated') redirect('/login');
  if (context.status !== 'resolved') redirect('/onboarding');

  const { supabase, business, entitlements } = context;
  if (!isRicherWebsiteScanEnabledForBusiness(business.id)) redirect('/settings');
  const [
    { data: services },
    { data: faqs },
    { data: businessProfile },
    { data: knowledgeItems },
  ] = await Promise.all([
    supabase.from('services').select('name, description, price, source').eq('business_id', business.id).eq('is_active', true).order('name'),
    supabase.from('faqs').select('question, answer, source').eq('business_id', business.id).eq('is_active', true).order('question'),
    supabase.from('businesses').select('business_type').eq('id', business.id).single(),
    supabase
      .from('business_knowledge_items')
      .select('kind, title, content')
      .eq('business_id', business.id)
      .eq('is_active', true)
      .order('kind'),
  ]);

  const initialData: ServicesAndFaqsValues = {
    services: (services ?? []).map((service) => ({
      name: service.name,
      description: service.description ?? '',
      price: service.price ?? '',
      source: service.source,
    })),
    faqs: (faqs ?? []).map((faq) => ({
      question: faq.question,
      answer: faq.answer,
      source: faq.source,
    })),
  };

  return (
    <div className="space-y-4">
      <Link
        href="/settings#your-assistant"
        className="inline-flex items-center gap-1.5 rounded-full border border-[#e7e0d4] bg-white px-3.5 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:border-[#d9d0c1] hover:bg-[#faf6ef] dark:border-white/[0.12] dark:bg-white/[0.07] dark:text-[#f5f5f5] dark:hover:bg-white/[0.11]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to Settings
      </Link>
      <WebsiteKnowledgeManager
      businessId={business.id}
      businessType={(businessProfile?.business_type || 'general') as BusinessType}
      websiteUrl={business.website_url}
      canCustomizeAi={canUseFeature(entitlements, 'ai_customization')}
      planActive={entitlements.active}
      initialData={initialData}
      initialKnowledge={(knowledgeItems ?? []).map((item) => ({
        kind: item.kind,
        title: item.title,
        content: item.content,
      }))}
      />
    </div>
  );
}
