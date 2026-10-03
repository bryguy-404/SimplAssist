import { z } from "zod";
import { customerJson, customerRoute } from "@/lib/customers/http.server";
import { previewImport } from "@/lib/customers/service.server";
export async function POST(request: Request) {
  return customerRoute(true, async (scope) => {
    const input = z
      .object({
        csv: z.string(),
        mapping: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .parse(await customerJson(request, 12 * 1024 * 1024));
    return previewImport(scope, input.csv, input.mapping);
  });
}
