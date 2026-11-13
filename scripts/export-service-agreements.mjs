#!/usr/bin/env node
// Read-only export. Keep this file in private backup storage, never the website.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

export async function exportServiceAgreements(client) {
  const tables = {};
  for (const table of ["service_terms_versions", "service_agreements", "service_agreement_references"]) {
    const rows = [];
    const order = table === "service_terms_versions" ? "version" : table === "service_agreements" ? "id" : "agreement_id";
    for (let offset = 0; ; offset += 500) {
      let query = client.from(table).select("*").order(order);
      if (table === "service_agreement_references") query = query.order("kind").order("reference");
      const { data, error } = await query.range(offset, offset + 499);
      if (error || !data) throw new Error("Agreement backup could not be completed.");
      rows.push(...data);
      if (data.length < 500) break;
    }
    tables[table] = rows;
  }
  const versions = new Map(tables.service_terms_versions.map((row) => [row.version, row]));
  for (const row of versions.values()) {
    if (createHash("sha256").update(row.terms_html).digest("hex") !== row.terms_sha256)
      throw new Error("Agreement backup contains a damaged Terms archive.");
  }
  for (const row of tables.service_agreements) {
    if (!versions.has(row.terms_version)) throw new Error("Agreement backup is missing an accepted Terms version.");
  }
  const agreements = new Set(tables.service_agreements.map((row) => row.id));
  for (const row of tables.service_agreement_references) {
    if (!agreements.has(row.agreement_id)) throw new Error("Agreement backup is missing a referenced acceptance. Retry the export.");
  }
  return { format: "simplassist-service-agreements-v1", exportedAt: new Date().toISOString(), tables };
}
async function main() {
  const output = process.argv[2];
  if (!output || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("Provide a private output path and the Supabase URL/service credentials through the environment.");
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const snapshot = await exportServiceAgreements(client);
  // Refuse to overwrite an earlier backup; files are readable only by the owner.
  await writeFile(output, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
  console.log("Agreement backup saved and document hashes verified.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
