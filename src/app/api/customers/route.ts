import { z } from "zod";
import { filtersFromParams } from "@/lib/customers/domain";
import { customerJson, customerRoute } from "@/lib/customers/http.server";
import { listCustomers, saveCustomer } from "@/lib/customers/service.server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return customerRoute(false, async (scope) => {
    const params = new URL(request.url).searchParams;
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000000)
      .parse(params.get("page") ?? 1);
    const size = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(params.get("pageSize") ?? 25);
    return listCustomers(scope, filtersFromParams(params), page, size);
  });
}
export async function POST(request: Request) {
  return customerRoute(true, async (scope) => ({
    customer: await saveCustomer(scope, null, await customerJson(request)),
  }));
}
