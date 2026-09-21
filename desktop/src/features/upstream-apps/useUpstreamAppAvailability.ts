import { invoke } from "@tauri-apps/api/core";
import * as React from "react";

export type UpstreamProduct = "affine" | "plane";

type AvailabilityState =
  | { status: "loading" }
  | { products: ReadonlySet<UpstreamProduct>; status: "ready" }
  | { status: "error" };

function parseProducts(value: unknown): ReadonlySet<UpstreamProduct> {
  if (
    !Array.isArray(value) ||
    value.some((product) => product !== "affine" && product !== "plane")
  ) {
    throw new Error("Invalid upstream application availability");
  }
  return new Set(value);
}

export function useUpstreamAppAvailability(): AvailabilityState & {
  retry: () => void;
} {
  const [request, retry] = React.useReducer((value: number) => value + 1, 0);
  const [state, setState] = React.useState<AvailabilityState>({
    status: "loading",
  });
  const generation = React.useRef(0);

  React.useEffect(() => {
    void request;
    const currentGeneration = ++generation.current;
    setState({ status: "loading" });
    void invoke<unknown>("get_upstream_app_availability")
      .then((value) => {
        if (generation.current !== currentGeneration) return;
        setState({ products: parseProducts(value), status: "ready" });
      })
      .catch(() => {
        if (generation.current !== currentGeneration) return;
        setState({ status: "error" });
      });
    return () => {
      if (generation.current === currentGeneration) generation.current += 1;
    };
  }, [request]);

  return { ...state, retry };
}
