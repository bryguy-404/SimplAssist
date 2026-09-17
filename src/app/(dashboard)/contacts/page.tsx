import { redirect } from "next/navigation";
import ContactStats from "@/components/contacts/ContactStats";
import ContactsTable from "@/components/contacts/ContactsTable";
import { getDashboardBusinessContext } from "@/lib/dashboard/context";
import { requireWorkspacePageAccess } from "@/lib/customer/workspaceRouteResponse.server";

export default async function ContactsPage({ searchParams }: { searchParams?: { contact?: string | string[] } }) {
  await requireWorkspacePageAccess();
  const context = await getDashboardBusinessContext();
  if (context.status === "unauthenticated") redirect("/login");
  if (context.status !== "resolved") redirect("/onboarding");

  const { supabase, business } = context;

  // Fetch contacts and conversations in parallel
  const [contactsResult, conversationsResult] = await Promise.all([
    supabase
      .from("contacts")
      .select("*")
      .eq("business_id", business.id)
      .order("last_contacted_at", { ascending: false }),
    supabase
      .from("conversations")
      .select("*")
      .eq("business_id", business.id),
  ]);

  const contacts = contactsResult.data ?? [];
  const conversations = conversationsResult.data ?? [];
  const selectedContactId = typeof searchParams?.contact === "string" ? searchParams.contact : undefined;
  // The bulk list can be capped by the provider. Resolve a deep link separately
  // without widening its ownership scope or loading the entire contact history.
  if (selectedContactId && !contacts.some((contact) => contact.id === selectedContactId)) {
    const selected = await supabase.from("contacts").select("*")
      .eq("business_id", business.id).eq("id", selectedContactId).maybeSingle();
    if (!selected.error && selected.data) contacts.unshift(selected.data);
  }

  // Compute conversation count per contact
  const countMap: Record<string, number> = {};
  for (const conv of conversations) {
    countMap[conv.contact_id] = (countMap[conv.contact_id] ?? 0) + 1;
  }

  const contactsWithCount = contacts.map((c) => ({
    ...c,
    conversation_count: countMap[c.id] ?? 0,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-stone-900 dark:text-[#f5f5f5]">Contacts</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-[#bdbdbf]">
          Manage your leads and customer contacts
        </p>
      </div>

      <ContactStats contacts={contacts} />
      <ContactsTable
        contacts={contactsWithCount}
        conversations={conversations}
        initialSelectedId={selectedContactId}
      />
    </div>
  );
}
