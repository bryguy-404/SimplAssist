export type ReviewPermissionSummary = {
  channel: "email" | "sms";
  destination: string;
  status: "granted" | "withdrawn" | "suppressed" | "keyword_required";
  grantedAt: string;
  revokedAt: string | null;
  source: "customer_keyword" | "owner";
  evidence: string;
};
export type ReviewSettings = {
  business_id: string;
  owner_id: string;
  google_review_url: string | null;
  reply_to: string;
  reply_to_verified_at: string;
  notification_email: string;
  pending_reply_to: string | null;
  postal_address: string | null;
  timezone: string;
  paused: boolean;
  subject: string;
  body: string;
  reminder_enabled: boolean;
  revision: number;
  automation_enabled?: boolean;
  automation_channel?: "email" | "sms";
};
export type ReviewUsage = {
  allowance: number;
  used: number;
  remaining: number;
  periodStart?: string;
  periodEnd?: string;
};
export type ReviewOverview = {
  settings: ReviewSettings;
  templates: {
    subject: string;
    body: string;
    reminderSubject: string;
    reminderBody: string;
  };
  eligibility: {
    enabled: boolean;
    paid: boolean;
    paused: boolean;
    ready: boolean;
    sendingEnabled: boolean;
  };
  usage: ReviewUsage;
};
export type ReviewRecipient = {
  contactId: string;
  name: string;
  email: string;
  phone?: string;
  identities: string[];
  timezone: string;
  scheduledAt: string;
  enrollmentId: string;
};
export type ReviewPreview = {
  sendingEnabled?: boolean;
  channel?: "email" | "sms";
  estimatedSmsParts?: number;
  previewToken: string;
  expiresAt: string;
  summary: { selected: number; eligible: number; excluded: number };
  recipients: ReviewRecipient[];
  excluded: { contactId: string; reason: string }[];
  sample: { subject: string; text: string; html: string } | null;
  usage: ReviewUsage;
  reminderEnabled: boolean;
  estimatedEmails: number;
};
export type ReviewDelivery = {
  id: string;
  kind: "initial" | "reminder";
  status: string;
  scheduled_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
};
export type ReviewEnrollment = {
  id: string;
  contact_id: string | null;
  destination: string;
  status: string;
  accepted_at: string | null;
  stop_reason: string | null;
  review_email_outbox: ReviewDelivery[];
  review_sms_outbox?: ReviewDelivery[];
};
export type ReviewCampaign = {
  id: string;
  displaySubject?: string;
  channel?: "email" | "sms";
  subject: string;
  body: string;
  scheduled_at: string;
  reminder_enabled: boolean;
  audience_count: number;
  created_at: string;
  summary: { selected?: number; eligible?: number; excluded?: number };
  review_enrollments: ReviewEnrollment[];
};
export type ReviewCampaignList = {
  campaigns: ReviewCampaign[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};
