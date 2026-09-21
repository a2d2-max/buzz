import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  UpstreamAppScreen,
  type UpstreamProduct,
} from "@/features/upstream-apps/UpstreamAppScreen";

export const Route = createFileRoute("/apps/$product")({
  component: UpstreamAppRoute,
  beforeLoad: ({ params }) => {
    if (params.product === "affine" || params.product === "plane") return;
    throw redirect({ to: "/", replace: true });
  },
});

function UpstreamAppRoute() {
  const { product } = Route.useParams();
  return <UpstreamAppScreen product={product as UpstreamProduct} />;
}
