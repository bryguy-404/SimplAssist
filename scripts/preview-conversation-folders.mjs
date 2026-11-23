// Print a read-only, account-scoped SQL preview. It can also run before the migration.
import { readFileSync } from "node:fs";

const business = process.argv[2];
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(business ?? "")) {
  throw new Error("Usage: node scripts/preview-conversation-folders.mjs <business-uuid>");
}
const path = new URL("../supabase/migrations/20261123033836_conversation_reply_folders.sql", import.meta.url);
const parts = readFileSync(path, "utf8").split("$activity$");
if (parts.length !== 3) throw new Error("The inbox activity query could not be located.");
const query = parts[1]
  .replaceAll("p_business", "'" + business + "'::uuid")
  .replace("c.inbox_kept,", "coalesce((to_jsonb(c)->>'inbox_kept')::boolean,false) AS inbox_kept,")
  .replace("v.inbox_reply_state,", "(to_jsonb(v)->>'inbox_reply_state') AS inbox_reply_state,")
  .replaceAll("s.inbox_call_origin", "(to_jsonb(s)->>'inbox_call_origin')");
process.stdout.write(`WITH preview(conversation_id,item_id,folder,reason,sort_time,call_history,protected_booking) AS (${query})
SELECT folder, reason, count(*) FILTER (WHERE conversation_id=item_id) AS displayed,
       count(*) FILTER (WHERE conversation_id<>item_id) AS grouped_calls
FROM preview GROUP BY folder, reason ORDER BY folder, reason;\n`);
