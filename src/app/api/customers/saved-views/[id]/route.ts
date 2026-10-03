import { customerId, customerRoute } from "@/lib/customers/http.server";
import { deleteView } from "@/lib/customers/service.server";
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  return customerRoute(true, async (scope) => {
    await deleteView(scope, customerId(params.id));
    return { deleted: true };
  });
}
