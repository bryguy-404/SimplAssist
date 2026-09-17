/** Build a reviewable SQL-editor bundle. Does not connect to any database. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['088_booking_confirmation_foundation.sql','089_booking_draft_lifecycle.sql','090_booking_notifications.sql'];
const output=process.argv[2];
if(!output || !path.isAbsolute(output))throw Error('Supply an absolute output path for the review bundle.');
let sql=`-- SimplAssist booking release: target inmgpkurctttsofpywuz, expected baseline 087.\n-- Review before running. One transaction; feature controls remain disabled.\nBEGIN;\nDO $$ BEGIN\n IF (SELECT max(version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM '087' THEN RAISE EXCEPTION 'Expected migration baseline 087; stop and review'; END IF;\nEND $$;\n`;
const manifest=[];
for(const filename of files){
 const source=readFileSync(path.join(root,'supabase/migrations',filename),'utf8');
 if(!source.startsWith('BEGIN;') || !source.trimEnd().endsWith('COMMIT;'))throw Error('Unexpected migration transaction wrapper');
 sql+=`\n-- ${filename}\n`+source.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
 const version=filename.slice(0,3), name=filename.slice(4,-4);
 sql+=`\nINSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('${version}','${name}',ARRAY[$booking_migration$${source}$booking_migration$]);\n`;
 manifest.push({filename,sha256:createHash('sha256').update(source).digest('hex')});
}
sql+='\nCOMMIT;\n';
writeFileSync(output,sql,{mode:0o600});
console.log(JSON.stringify({output,sha256:createHash('sha256').update(sql).digest('hex'),migrations:manifest},null,2));
