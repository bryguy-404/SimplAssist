import {
  customerId,
  customerJson,
  customerRoute,
} from "@/lib/customers/http.server";
import {
  deleteCustomer,
  getCustomer,
  saveCustomer,
} from "@/lib/customers/service.server";
import { z } from "zod";
export const dynamic = "force-dynamic";
type Context = { params: { id: string } };
export async function GET(request: Request, { params }: Context) {
  return customerRoute(false, (scope) =>
    getCustomer(
      scope,
      customerId(params.id),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(1000000)
        .parse(new URL(request.url).searchParams.get("historyPage") ?? 1),
    ),
  );
}
export async function PATCH(request: Request, { params }: Context) {
  return customerRoute(true, async (scope) => ({
    customer: await saveCustomer(
      scope,
      customerId(params.id),
      await customerJson(request),
    ),
  }));
}
export async function DELETE(_request: Request, { params }: Context) {
  return customerRoute(true, async (scope) => {
    await deleteCustomer(scope, customerId(params.id));
    return { deleted: true };
  });
}
