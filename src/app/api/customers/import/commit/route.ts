import { z } from "zod";
import { customerJson, customerRoute } from "@/lib/customers/http.server";
import { commitImport } from "@/lib/customers/service.server";
export async function POST(request: Request) {
  return customerRoute(true, async (scope) => {
    const input = z
      .object({ previewToken: z.string().uuid() })
      .strict()
      .parse(await customerJson(request));
    return commitImport(scope, input.previewToken);
  });
}
