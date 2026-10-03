import { z } from "zod";
import { customerFiltersSchema } from "@/lib/customers/domain";
import { customerJson, customerRoute } from "@/lib/customers/http.server";
import { savedViews, saveView } from "@/lib/customers/service.server";
export async function GET() {
  return customerRoute(false, async (scope) => ({
    savedViews: await savedViews(scope),
  }));
}
export async function POST(request: Request) {
  return customerRoute(true, async (scope) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(80),
        filters: customerFiltersSchema,
      })
      .strict()
      .parse(await customerJson(request));
    return { savedView: await saveView(scope, input.name, input.filters) };
  });
}
