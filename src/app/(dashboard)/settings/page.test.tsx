import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getOwnerVoiceSettings: vi.fn(),
  redirect: vi.fn(),
  requireWorkspacePageAccess: vi.fn(),
  getDashboardEntitledContext: vi.fn(),
  canUseFeature: vi.fn(),
  isPlanAvailable: vi.fn(),
  from: vi.fn(),
  goalSettingsForm: vi.fn(),
  compliancePanel: vi.fn(),
  businessInfoEditor: vi.fn(),
  aiSettingsForm: vi.fn(),
  isSettingsRegistrationLocked: vi.fn(),
  richerWebsiteScanEnabled: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/customer/workspaceRouteResponse.server', () => ({
  requireWorkspacePageAccess: mocks.requireWorkspacePageAccess,
}));
vi.mock('@/lib/dashboard/context', () => ({
  getDashboardEntitledContext: mocks.getDashboardEntitledContext,
}));
vi.mock('@/lib/billing/entitlements', () => ({
  canUseFeature: mocks.canUseFeature,
}));
vi.mock('@/lib/billing/planAvailability', () => ({
  isPlanAvailable: mocks.isPlanAvailable,
}));
vi.mock('@/lib/settings/registrationLock.server', () => ({
  isSettingsRegistrationLocked: mocks.isSettingsRegistrationLocked,
}));
vi.mock('@/lib/website-scans/rollout.server', () => ({
  isRicherWebsiteScanEnabledForBusiness: mocks.richerWebsiteScanEnabled,
}));
vi.mock('@/components/settings/AISettingsForm', () => ({
  default: (props: unknown) => {
    mocks.aiSettingsForm(props);
    return <div>AI settings form</div>;
  },
}));
vi.mock('@/components/settings/GoalSettingsForm', () => ({
  default: (props: unknown) => {
    mocks.goalSettingsForm(props);
    return <div data-goal-settings-form>Goal settings form</div>;
  },
}));
vi.mock('@/components/settings/ServicesManager', () => ({
  default: () => <div>Services manager</div>,
}));
vi.mock('@/components/settings/FAQManager', () => ({
  default: () => <div>FAQ manager</div>,
}));
vi.mock('@/components/settings/BusinessHoursEditor', () => ({
  default: () => <div>Business hours editor</div>,
}));
vi.mock('@/components/settings/BusinessInfoEditor', () => ({
  default: (props: unknown) => {
    mocks.businessInfoEditor(props);
    return <div>Business info editor</div>;
  },
}));
vi.mock('@/components/settings/PhoneNumberSection', () => ({
  default: () => <div>Phone number section</div>,
}));
vi.mock('@/components/settings/BusinessEmailForm', () => ({
  default: () => <div>Business email form</div>,
}));
vi.mock('@/components/settings/TimezoneSelector', () => ({
  default: () => <div>Timezone selector</div>,
}));
vi.mock('@/components/settings/CompliancePanel', () => ({
  default: (props: unknown) => {
    mocks.compliancePanel(props);
    return <div>Compliance panel</div>;
  },
}));
vi.mock('@/components/settings/DangerZone', () => ({
  default: () => <div>Danger zone</div>,
}));
vi.mock('@/components/owner-booking-alerts/OwnerBookingAlerts', () => ({
  default: () => <section id="booking-alerts">Owner booking alerts</section>,
}));
vi.mock('@/components/entitlements/LockedFeatureCard', () => ({
  LockedFeatureCard: () => <div>Locked feature</div>,
}));

vi.mock("@/lib/voice/access.server", () => ({
  getOwnerVoiceSettings: mocks.getOwnerVoiceSettings,
}));

import SettingsPage from './page';

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const ENTITLEMENTS = {
  active: true,
  plan: 'sms_and_chat',
};
const AI_SETTINGS = {
  id: 'settings-1',
  business_id: BUSINESS_ID,
  language: 'en',
};
const CALENDAR_TOKEN = {
  business_id: BUSINESS_ID,
  google_email: 'owner@example.com',
};
const RETAINED_GOAL_URL = 'https://example.com/retained';
const SIGNUP_GOAL_URL = 'https://example.com/signup';
const SETTINGS_TABLES = [
  'ai_settings',
  'services',
  'faqs',
  'business_hours',
  'phone_numbers',
  'google_calendar_tokens',
] as const;

type PrimaryGoal = 'book' | 'signup' | 'quote' | 'callback' | null;

type RegistrationStateOverrides = Partial<{
  telnyx_brand_id: string | null;
  brand_status: string | null;
  campaign_status: string | null;
  onboarding_registration_status:
    | 'not_started'
    | 'submitting'
    | 'failed'
    | 'submitted';
}>;

interface QueryResult {
  data: unknown;
  error: null;
}

interface QueryRecorder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
}

const queryRecorders = new Map<string, QueryRecorder>();
let tableData: Record<string, unknown>;

function resolvedContext(
  primaryGoal: PrimaryGoal = 'book',
  goalUrl: string | null = RETAINED_GOAL_URL,
  registrationState: RegistrationStateOverrides = {}
) {
  return {
    status: 'resolved',
    supabase: { from: mocks.from },
    user: { id: 'user-1' },
    business: {
      id: BUSINESS_ID,
      primary_goal: primaryGoal,
      goal_url: goalUrl,
      telnyx_brand_id: null,
      brand_status: null,
      campaign_status: null,
      onboarding_registration_status: 'not_started',
      name: 'Example Business',
      call_forwarding_enabled: false,
      forward_to_number: null,
      email: 'business@example.com',
      slug: 'example-business',
      phone_number: '+13175550123',
      address: '123 Main Street',
      city: 'Indianapolis',
      state: 'IN',
      zip: '46204',
      opt_in_description: 'Customers opt in on the website.',
      privacy_terms_mode: 'hosted',
      privacy_url_override: null,
      terms_url_override: null,
      timezone: 'America/Indiana/Indianapolis',
      ...registrationState,
    },
    entitlements: ENTITLEMENTS,
  };
}

function stripGoalSettingsForm(markup: string): string {
  return markup.replace(
    '<div data-goal-settings-form="true">Goal settings form</div>',
    ''
  );
}

function makeQuery(table: string): QueryRecorder {
  const result = (): QueryResult => ({ data: tableData[table], error: null });
  const query = {} as QueryRecorder;
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(async () => result());
  query.single = vi.fn(async () => result());
  queryRecorders.set(table, query);
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOwnerVoiceSettings.mockResolvedValue(null);
  mocks.richerWebsiteScanEnabled.mockReturnValue(true);
  queryRecorders.clear();
  tableData = {
    ai_settings: AI_SETTINGS,
    services: [{ id: 'service-1' }],
    faqs: [{ id: 'faq-1' }],
    business_hours: [{ id: 'hours-1' }],
    phone_numbers: {
      phone_number: '+13175550123',
      is_active: true,
    },
    google_calendar_tokens: CALENDAR_TOKEN,
  };
  mocks.from.mockImplementation((table: string) => makeQuery(table));
  mocks.requireWorkspacePageAccess.mockResolvedValue(undefined);
  mocks.getDashboardEntitledContext.mockResolvedValue(resolvedContext());
  mocks.canUseFeature.mockReturnValue(true);
  mocks.isPlanAvailable.mockReturnValue(true);
  mocks.isSettingsRegistrationLocked.mockImplementation(
    (business: {
      telnyx_brand_id: string | null;
      brand_status: string | null;
      campaign_status: string | null;
      onboarding_registration_status: string | null;
    }) =>
      business.onboarding_registration_status !== 'failed' &&
      Boolean(
        business.telnyx_brand_id ||
          business.brand_status ||
          business.campaign_status ||
          business.onboarding_registration_status === 'submitted'
      )
  );
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
});

describe('SettingsPage access and owner reads', () => {
  it('redirects unauthenticated users before settings queries', async () => {
    mocks.getDashboardEntitledContext.mockResolvedValue({
      status: 'unauthenticated',
      supabase: { from: mocks.from },
      user: null,
    });

    await expect(SettingsPage({})).rejects.toThrow('redirect:/login');

    expect(mocks.requireWorkspacePageAccess).toHaveBeenCalledOnce();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('redirects unresolved business state before settings queries', async () => {
    mocks.getDashboardEntitledContext.mockResolvedValue({
      status: 'business_not_found',
      supabase: { from: mocks.from },
      user: { id: 'user-1' },
    });

    await expect(SettingsPage({})).rejects.toThrow('redirect:/onboarding');
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('keeps the six existing reads on the resolved owner client and business', async () => {
    await SettingsPage({});

    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
      ...SETTINGS_TABLES,
    ]);
    queryRecorders.forEach((query) => {
      expect(query.select).toHaveBeenCalledWith('*');
      expect(query.eq).toHaveBeenCalledWith('business_id', BUSINESS_ID);
    });
    expect(queryRecorders.get('services')?.order).toHaveBeenCalledWith('name');
    expect(queryRecorders.get('faqs')?.order).toHaveBeenCalledWith('question');
    expect(queryRecorders.get('business_hours')?.order).toHaveBeenCalledWith(
      'day_of_week'
    );
    expect(queryRecorders.get('phone_numbers')?.eq.mock.calls).toEqual([
      ['business_id', BUSINESS_ID],
      ['is_active', true],
    ]);
  });

  it('preserves the onboarding redirect when AI settings are missing', async () => {
    tableData.ai_settings = null;

    await expect(SettingsPage({})).rejects.toThrow('redirect:/onboarding');

    expect(mocks.from).toHaveBeenCalledTimes(6);
    expect(mocks.goalSettingsForm).not.toHaveBeenCalled();
    expect(mocks.aiSettingsForm).not.toHaveBeenCalled();
  });
});

describe('SettingsPage primary-goal presentation', () => {
  it('passes false while preserving saved token state for signup mode', async () => {
    mocks.getDashboardEntitledContext.mockResolvedValue(
      resolvedContext('signup', SIGNUP_GOAL_URL)
    );

    const markup = renderToStaticMarkup(await SettingsPage({}));

    expect(mocks.goalSettingsForm).toHaveBeenCalledWith({
      initialPrimaryGoal: 'signup',
      initialGoalUrl: SIGNUP_GOAL_URL,
      registrationLocked: false,
    });
    expect(markup.indexOf('Goal settings form')).toBeLessThan(
      markup.indexOf('AI settings form')
    );

    expect(mocks.aiSettingsForm).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        calendarGoalAvailable: false,
        calendarEmail: CALENDAR_TOKEN.google_email,
        calendarConnected: true,
        canUseCalendar: true,
      })
    );
    expect(mocks.from).toHaveBeenCalledWith('google_calendar_tokens');
  });

  it.each(['book', 'quote', 'callback'] as const)(
    'passes true and preserves current markup/query behavior for primary_goal=%s',
    async (primaryGoal) => {
      mocks.getDashboardEntitledContext.mockResolvedValue(
        resolvedContext(primaryGoal)
      );

      const markup = renderToStaticMarkup(await SettingsPage({}));

      expect(markup).toContain('Settings');
      expect(markup).toContain('AI settings form');
      expect(mocks.from).toHaveBeenCalledTimes(6);
      expect(mocks.goalSettingsForm).toHaveBeenCalledWith({
        initialPrimaryGoal: primaryGoal,
        initialGoalUrl: RETAINED_GOAL_URL,
        registrationLocked: false,
      });
      expect(mocks.aiSettingsForm).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarGoalAvailable: true,
          calendarEmail: CALENDAR_TOKEN.google_email,
          calendarConnected: true,
        })
      );
    }
  );

  it.each(['quote', 'callback'] as const)(
    'keeps primary_goal=%s legacy Settings markup and query calls byte-identical to book after stripping only the goal form',
    async (primaryGoal) => {
      mocks.getDashboardEntitledContext
        .mockResolvedValueOnce(resolvedContext('book'))
        .mockResolvedValueOnce(resolvedContext(primaryGoal));

      const bookMarkup = renderToStaticMarkup(await SettingsPage({}));
      const legacyMarkup = renderToStaticMarkup(await SettingsPage({}));
      const tableCalls = mocks.from.mock.calls.map(([table]) => table);

      expect(stripGoalSettingsForm(legacyMarkup)).toBe(
        stripGoalSettingsForm(bookMarkup)
      );
      expect(tableCalls.slice(0, SETTINGS_TABLES.length)).toEqual([
        ...SETTINGS_TABLES,
      ]);
      expect(tableCalls.slice(SETTINGS_TABLES.length)).toEqual([
        ...SETTINGS_TABLES,
      ]);
    }
  );
});

describe('SettingsPage registration-sensitive settings', () => {
  it.each([
    ['Telnyx brand id', { telnyx_brand_id: 'brand-1' }, true],
    ['brand status', { brand_status: 'pending' }, true],
    ['campaign status', { campaign_status: 'approved' }, true],
    [
      'submitted onboarding registration',
      { onboarding_registration_status: 'submitted' as const },
      true,
    ],
    ['pristine registration', {}, false],
    [
      'bare submitting registration',
      { onboarding_registration_status: 'submitting' as const },
      false,
    ],
    [
      'failed registration override',
      {
        telnyx_brand_id: 'brand-1',
        campaign_status: 'approved',
        onboarding_registration_status: 'failed' as const,
      },
      false,
    ],
  ] as const)(
    'passes the shared registration lock state for %s',
    async (_label, registrationState, expectedLocked) => {
      mocks.getDashboardEntitledContext.mockResolvedValue(
        resolvedContext('book', RETAINED_GOAL_URL, registrationState)
      );

      renderToStaticMarkup(await SettingsPage({}));

      expect(mocks.goalSettingsForm).toHaveBeenCalledWith({
        initialPrimaryGoal: 'book',
        initialGoalUrl: RETAINED_GOAL_URL,
        registrationLocked: expectedLocked,
      });
      expect(mocks.businessInfoEditor).toHaveBeenCalledWith({
        initialPhoneNumber: '+13175550123',
        initialAddress: '123 Main Street',
        initialCity: 'Indianapolis',
        initialState: 'IN',
        initialZip: '46204',
        registrationLocked: expectedLocked,
      });
      expect(mocks.compliancePanel).toHaveBeenCalledWith(
        expect.objectContaining({ registrationLocked: expectedLocked })
      );
    }
  );

  it('hides every SMS-only surface for Chat Only despite stale carrier data', async () => {
    const context = resolvedContext('book', RETAINED_GOAL_URL, {
      telnyx_brand_id: 'stale-brand',
      brand_status: 'approved',
      campaign_status: 'approved',
      onboarding_registration_status: 'submitted',
    });
    context.entitlements = { active: true, plan: 'chat_only' };
    mocks.getDashboardEntitledContext.mockResolvedValue(context);

    const markup = renderToStaticMarkup(await SettingsPage({}));

    expect(mocks.from.mock.calls.map(([table]) => table)).not.toContain(
      'phone_numbers'
    );
    expect(markup).not.toContain('Phone Number');
    expect(markup).not.toContain('Phone number section');
    expect(markup).not.toContain('Compliance');
    expect(markup).not.toContain('Compliance panel');
    expect(markup).toContain('id="booking-alerts"');
    expect(markup).toContain('Owner booking alerts');
    expect(mocks.compliancePanel).not.toHaveBeenCalled();
    expect(mocks.aiSettingsForm).toHaveBeenCalledWith(
      expect.objectContaining({ showSmsResponseDelay: false })
    );
    expect(mocks.goalSettingsForm).toHaveBeenCalledWith(
      expect.objectContaining({ registrationLocked: false })
    );
    expect(mocks.businessInfoEditor).toHaveBeenCalledWith(
      expect.objectContaining({ registrationLocked: false })
    );
  });
});

describe('SettingsPage Calendar status parsing', () => {
  it('shows the friendly status only for an exact scalar unavailable value in signup mode', async () => {
    mocks.getDashboardEntitledContext.mockResolvedValue(
      resolvedContext('signup')
    );

    const markup = renderToStaticMarkup(
      await SettingsPage({ searchParams: { calendar: 'unavailable' } })
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      'Google Calendar isn’t used for the signup-link goal.'
    );
    expect(markup).toContain(
      'Your assistant can keep sending your configured link, and sent links appear in Leads.'
    );
  });

  it.each([
    ['missing', undefined],
    ['other', 'connected'],
    ['repeated', ['unavailable', 'unavailable']],
    ['single-item array', ['unavailable']],
  ] as const)(
    'ignores the %s Calendar query state',
    async (_scenario, calendar) => {
      mocks.getDashboardEntitledContext.mockResolvedValue(
        resolvedContext('signup')
      );

      const markup = renderToStaticMarkup(
        await SettingsPage({
          searchParams: {
            calendar: calendar as string | string[] | undefined,
          },
        })
      );

      expect(markup).not.toContain('role="status"');
      expect(markup).not.toContain(
        'Google Calendar isn’t used for the signup-link goal.'
      );
    }
  );

  it('ignores the friendly state for a book-compatible goal', async () => {
    mocks.getDashboardEntitledContext.mockResolvedValue(
      resolvedContext('book')
    );

    const markup = renderToStaticMarkup(
      await SettingsPage({ searchParams: { calendar: 'unavailable' } })
    );

    expect(markup).not.toContain('role="status"');
    expect(mocks.aiSettingsForm).toHaveBeenCalledWith(
      expect.objectContaining({ calendarGoalAvailable: true })
    );
  });
});

describe('SettingsPage richer scan rollout', () => {
  it('hides the Assistant Knowledge entry point outside the canary rollout', async () => {
    mocks.richerWebsiteScanEnabled.mockReturnValue(false);

    const markup = renderToStaticMarkup(await SettingsPage({}));

    expect(markup).not.toContain('href="/settings/knowledge"');
  });
});

const VOICE_USAGE = {
  visible: true, accessSource: "commercial", canEditPreferences: false, canEnableVoice: false,
  status: "plan_required", timezone: "America/New_York",
  preferences: { mode: "text", textFallbackEnabled: false, revision: 2 },
  usage: { kind: "monthly", periodState: "current", includedSeconds: 6000, usedSeconds: 1200, heldSeconds: 0,
    availableSeconds: 4800, resetsAt: "2026-10-01T00:00:00Z", reconciling: false },
};

describe("Settings voice integration", () => {
  it("loads only the resolved business and hides voice activation for ordinary accounts", async () => {
    mocks.getOwnerVoiceSettings.mockResolvedValue({ ...VOICE_USAGE, visible: false });
    const html = renderToStaticMarkup(await SettingsPage({}));
    expect(mocks.getOwnerVoiceSettings).toHaveBeenCalledWith(BUSINESS_ID);
    expect(html).not.toContain("Call answering");
    expect(html).not.toContain("Save call settings");
  });
  it("preserves usage and call history after access is lost", async () => {
    mocks.getOwnerVoiceSettings.mockResolvedValue(VOICE_USAGE);
    const html = renderToStaticMarkup(await SettingsPage({}));
    expect(html).toContain("current plan does not include voice");
    expect(html).toContain("Voice minutes this billing period");
    expect(html).toContain('href="/conversations"');
    expect(html).not.toContain("Save call settings");
  });
  it("keeps the settings page usable if the optional voice lookup fails", async () => {
    mocks.getOwnerVoiceSettings.mockRejectedValue(new Error("schema temporarily unavailable"));
    const html = renderToStaticMarkup(await SettingsPage({}));
    expect(html).toContain("Business Email");
    expect(html).not.toContain("Call answering");
  });
});
